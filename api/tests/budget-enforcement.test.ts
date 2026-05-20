/**
 * Budget-threshold enforcement tests.
 *
 * Covers:
 *   - checkBudgetThreshold service helper (unit)
 *   - emitBudgetEnforcement observability events and counters
 *   - POST /catalog/assets/:name/:version/install   — install flow
 *   - GET  /catalog/assets/:name/:version/manifest  — invoke flow
 *
 * Each section is isolated via clearCostRecords() and resetCounters() so
 * counter state and cost records do not bleed between tests.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";
import app from "../src/index.js";
import {
  clearCostRecords,
  ingestCostRecord,
  checkBudgetThreshold,
} from "../src/services/cost.service.js";
import {
  emitBudgetEnforcement,
  getCounters,
  resetCounters,
} from "../src/services/observability.service.js";

// ---------------------------------------------------------------------------
// Shared constants
// ---------------------------------------------------------------------------

// Sample asset available in CATALOG_SAMPLE_MODE (no sensitivity restriction)
const ASSET_NAME = "aria.dev/skills/hr-policy-lookup";
const ASSET_VERSION = "1.2.0";

// Public-tier sample asset — accessible to anonymous consumers
const PUBLIC_ASSET_NAME = "aria.dev/skills/code-review";
const PUBLIC_ASSET_VERSION = "1.5.2";
const ENCODED_PUBLIC_ASSET = encodeURIComponent(PUBLIC_ASSET_NAME);

const BASE_RECORD = {
  provider: "azure",
  asset_name: ASSET_NAME,
  asset_version: ASSET_VERSION,
  cost: 50,
  period_start: "2026-01-01T00:00:00Z",
  period_end: "2026-01-31T23:59:59Z",
  currency: "USD",
};

// ---------------------------------------------------------------------------
// Unit: checkBudgetThreshold
// ---------------------------------------------------------------------------

describe("checkBudgetThreshold — service unit tests", () => {
  beforeEach(() => clearCostRecords());

  it("returns exceeded=false when there are no cost records", () => {
    const result = checkBudgetThreshold(ASSET_NAME, 100);
    expect(result.exceeded).toBe(false);
    expect(result.current_spend).toBe(0);
    expect(result.threshold).toBe(100);
    expect(result.currency).toBe("USD");
  });

  it("returns exceeded=false when spend is below the threshold", () => {
    ingestCostRecord({ ...BASE_RECORD, cost: 40 });
    const result = checkBudgetThreshold(ASSET_NAME, 100);
    expect(result.exceeded).toBe(false);
    expect(result.current_spend).toBe(40);
  });

  it("returns exceeded=true when spend equals the threshold (boundary)", () => {
    ingestCostRecord({ ...BASE_RECORD, cost: 100 });
    const result = checkBudgetThreshold(ASSET_NAME, 100);
    expect(result.exceeded).toBe(true);
    expect(result.current_spend).toBe(100);
  });

  it("returns exceeded=true when spend exceeds the threshold", () => {
    ingestCostRecord({ ...BASE_RECORD, cost: 150 });
    const result = checkBudgetThreshold(ASSET_NAME, 100);
    expect(result.exceeded).toBe(true);
    expect(result.current_spend).toBe(150);
  });

  it("aggregates spend across multiple records for the same asset", () => {
    ingestCostRecord({ ...BASE_RECORD, cost: 40 });
    ingestCostRecord({ ...BASE_RECORD, cost: 40 });
    ingestCostRecord({ ...BASE_RECORD, cost: 40 });
    const result = checkBudgetThreshold(ASSET_NAME, 100);
    expect(result.exceeded).toBe(true);
    expect(result.current_spend).toBe(120);
  });

  it("aggregates spend across multiple providers for the same asset", () => {
    ingestCostRecord({ ...BASE_RECORD, provider: "azure", cost: 60 });
    ingestCostRecord({ ...BASE_RECORD, provider: "aws", cost: 60 });
    const result = checkBudgetThreshold(ASSET_NAME, 100);
    expect(result.exceeded).toBe(true);
    expect(result.current_spend).toBe(120);
  });

  it("ignores records for other assets", () => {
    ingestCostRecord({ ...BASE_RECORD, asset_name: "aria.dev/agents/other", cost: 999 });
    const result = checkBudgetThreshold(ASSET_NAME, 100);
    expect(result.exceeded).toBe(false);
    expect(result.current_spend).toBe(0);
  });

  it("always returns currency as USD since spend is accumulated from cost", () => {
    ingestCostRecord({ ...BASE_RECORD, cost: 40 });
    const result = checkBudgetThreshold(ASSET_NAME, 100);
    expect(result.currency).toBe("USD");
    expect(result.threshold).toBe(100);
  });

  it("defaults currency to USD when no records are present", () => {
    const result = checkBudgetThreshold(ASSET_NAME, 50);
    expect(result.currency).toBe("USD");
  });
});

// ---------------------------------------------------------------------------
// Unit: emitBudgetEnforcement — counters and log emission
// ---------------------------------------------------------------------------

describe("emitBudgetEnforcement — counter increments", () => {
  beforeEach(() => resetCounters());

  it("increments budget.enforcement.install counter", () => {
    emitBudgetEnforcement({
      asset_name: ASSET_NAME,
      asset_version: ASSET_VERSION,
      consumer_id: "hr-team",
      flow: "install",
      current_spend: 120,
      threshold: 100,
      currency: "USD",
    });
    expect(getCounters()["budget.enforcement.install"]).toBe(1);
  });

  it("increments budget.enforcement.invoke counter", () => {
    emitBudgetEnforcement({
      asset_name: ASSET_NAME,
      asset_version: ASSET_VERSION,
      consumer_id: "hr-team",
      flow: "invoke",
      current_spend: 120,
      threshold: 100,
      currency: "EUR",
    });
    expect(getCounters()["budget.enforcement.invoke"]).toBe(1);
  });

  it("accumulates across multiple enforcement events", () => {
    emitBudgetEnforcement({ asset_name: "a", asset_version: "1", consumer_id: "c", flow: "install", current_spend: 10, threshold: 5, currency: "USD" });
    emitBudgetEnforcement({ asset_name: "a", asset_version: "1", consumer_id: "c", flow: "install", current_spend: 12, threshold: 5, currency: "USD" });
    expect(getCounters()["budget.enforcement.install"]).toBe(2);
  });

  it("install and invoke counters are tracked independently", () => {
    emitBudgetEnforcement({ asset_name: "a", asset_version: "1", consumer_id: "c", flow: "install", current_spend: 10, threshold: 5, currency: "USD" });
    emitBudgetEnforcement({ asset_name: "a", asset_version: "1", consumer_id: "c", flow: "invoke", current_spend: 10, threshold: 5, currency: "USD" });
    expect(getCounters()["budget.enforcement.install"]).toBe(1);
    expect(getCounters()["budget.enforcement.invoke"]).toBe(1);
  });
});

describe("emitBudgetEnforcement — structured log emission", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    resetCounters();
  });
  afterEach(() => warnSpy.mockRestore());

  it("suppresses log output in test environment", () => {
    emitBudgetEnforcement({
      asset_name: ASSET_NAME,
      asset_version: ASSET_VERSION,
      consumer_id: "hr-team",
      flow: "install",
      current_spend: 120,
      threshold: 100,
      currency: "USD",
    });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("emits a structured JSON log in production with all required fields", () => {
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      emitBudgetEnforcement({
        asset_name: ASSET_NAME,
        asset_version: ASSET_VERSION,
        consumer_id: "hr-team",
        flow: "install",
        current_spend: 120.5,
        threshold: 100,
        currency: "EUR",
      });
      expect(warnSpy).toHaveBeenCalledOnce();
      const emitted = JSON.parse(warnSpy.mock.calls[0][0] as string);
      expect(emitted.event).toBe("budget.enforcement");
      expect(emitted.asset_name).toBe(ASSET_NAME);
      expect(emitted.asset_version).toBe(ASSET_VERSION);
      expect(emitted.consumer_id).toBe("hr-team");
      expect(emitted.flow).toBe("install");
      expect(emitted.current_spend).toBe(120.5);
      expect(emitted.threshold).toBe(100);
      expect(emitted.currency).toBe("EUR");
      expect(typeof emitted.timestamp).toBe("string");
    } finally {
      process.env.NODE_ENV = originalEnv;
    }
  });

  it("includes currency in the event for non-USD thresholds", () => {
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      emitBudgetEnforcement({
        asset_name: ASSET_NAME,
        asset_version: ASSET_VERSION,
        consumer_id: "finance-team",
        flow: "invoke",
        current_spend: 500,
        threshold: 400,
        currency: "GBP",
      });
      const emitted = JSON.parse(warnSpy.mock.calls[0][0] as string);
      expect(emitted.currency).toBe("GBP");
    } finally {
      process.env.NODE_ENV = originalEnv;
    }
  });
});

// ---------------------------------------------------------------------------
// Integration: POST /catalog/assets/:name/:version/install
// ---------------------------------------------------------------------------

describe("POST /catalog/assets/:name/:version/install — budget enforcement", () => {
  beforeEach(() => {
    clearCostRecords();
    resetCounters();
  });

  it("returns 202 when no budget threshold is set on the asset", async () => {
    // Public-tier code-review asset has no budget_threshold configured
    const res = await request(app)
      .post(`/catalog/assets/${ENCODED_PUBLIC_ASSET}/${PUBLIC_ASSET_VERSION}/install`)
      .send({ target: "claude_desktop" });

    expect(res.status).toBe(202);
  });

  it("returns 202 when spend is below the threshold", async () => {
    // Seed spend well under any threshold the asset might have
    ingestCostRecord({ ...BASE_RECORD, asset_name: PUBLIC_ASSET_NAME, cost: 1 });
    const res = await request(app)
      .post(`/catalog/assets/${ENCODED_PUBLIC_ASSET}/${PUBLIC_ASSET_VERSION}/install`)
      .send({ target: "claude_desktop" });

    expect(res.status).toBe(202);
  });
});

// ---------------------------------------------------------------------------
// Integration: budget enforcement via a custom in-memory asset
//
// The sample catalog doesn't ship assets with budget_threshold set, so we
// test the enforcement logic directly via the service layer rather than
// trying to inject a custom asset into the live catalog.
// ---------------------------------------------------------------------------

describe("checkBudgetThreshold integration with ingestCostRecord", () => {
  beforeEach(() => clearCostRecords());

  it("is not exceeded immediately after clearing records", () => {
    const result = checkBudgetThreshold(ASSET_NAME, 50);
    expect(result.exceeded).toBe(false);
    expect(result.current_spend).toBe(0);
    expect(result.currency).toBe("USD");
  });

  it("trips the threshold after records push spend over the limit", () => {
    ingestCostRecord({ ...BASE_RECORD, cost: 30 });
    ingestCostRecord({ ...BASE_RECORD, cost: 30 });
    const result = checkBudgetThreshold(ASSET_NAME, 50);
    expect(result.exceeded).toBe(true);
    expect(result.current_spend).toBe(60);
    expect(result.threshold).toBe(50);
  });

  it("enforces the threshold as a plain number regardless of configured budget_currency", () => {
    // Records ingested in USD; threshold is enforced as a number — no FX conversion.
    ingestCostRecord({ ...BASE_RECORD, cost: 200 });
    const result = checkBudgetThreshold(ASSET_NAME, 100);
    expect(result.exceeded).toBe(true);
    expect(result.currency).toBe("USD");
  });

  it("reports USD as the currency even when spend is below the threshold", () => {
    ingestCostRecord({ ...BASE_RECORD, cost: 50 });
    const result = checkBudgetThreshold(ASSET_NAME, 100);
    expect(result.exceeded).toBe(false);
    expect(result.currency).toBe("USD");
  });
});

// ---------------------------------------------------------------------------
// Integration: GET /catalog/assets/:name/:version/manifest — invoke flow
// ---------------------------------------------------------------------------

describe("GET /catalog/assets/:name/:version/manifest — budget enforcement", () => {
  beforeEach(() => {
    clearCostRecords();
    resetCounters();
  });

  it("returns 200 when no budget threshold is configured on the asset", async () => {
    const res = await request(app).get(
      `/catalog/assets/${ENCODED_PUBLIC_ASSET}/${PUBLIC_ASSET_VERSION}/manifest`
    );
    expect(res.status).toBe(200);
  });

  it("returns 200 when spend is below any threshold the asset might carry", async () => {
    ingestCostRecord({ ...BASE_RECORD, asset_name: PUBLIC_ASSET_NAME, cost: 1 });
    const res = await request(app).get(
      `/catalog/assets/${ENCODED_PUBLIC_ASSET}/${PUBLIC_ASSET_VERSION}/manifest`
    );
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Unit: 402 response shape is currency-agnostic
// ---------------------------------------------------------------------------

describe("402 response payload — currency-agnostic shape", () => {
  it("budget check result exposes currency field, not a USD-specific key", () => {
    clearCostRecords();
    ingestCostRecord({ ...BASE_RECORD, cost: 200 });
    const result = checkBudgetThreshold(ASSET_NAME, 100);
    // Verify the currency-agnostic field names are present
    expect(result).toHaveProperty("current_spend");
    expect(result).toHaveProperty("threshold");
    expect(result).toHaveProperty("currency");
    // currency is always USD since spend is accumulated from cost
    expect(result.currency).toBe("USD");
    // Verify the old USD-specific names are absent
    expect(result).not.toHaveProperty("current_usd");
    expect(result).not.toHaveProperty("threshold_usd");
    expect(result).not.toHaveProperty("current_spend_usd");
  });

  it("budget enforcement event carries currency field", () => {
    let capturedEvent: unknown;
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    const spy = vi.spyOn(console, "warn").mockImplementation((msg: string) => {
      capturedEvent = JSON.parse(msg);
    });
    try {
      emitBudgetEnforcement({
        asset_name: ASSET_NAME,
        asset_version: ASSET_VERSION,
        consumer_id: "hr-team",
        flow: "install",
        current_spend: 150,
        threshold: 100,
        currency: "JPY",
      });
      expect(capturedEvent).toMatchObject({
        event: "budget.enforcement",
        current_spend: 150,
        threshold: 100,
        currency: "JPY",
      });
      // Old USD-specific keys must not be present
      expect((capturedEvent as Record<string, unknown>)["current_spend_usd"]).toBeUndefined();
      expect((capturedEvent as Record<string, unknown>)["threshold_usd"]).toBeUndefined();
    } finally {
      process.env.NODE_ENV = originalEnv;
      spy.mockRestore();
    }
  });
});
