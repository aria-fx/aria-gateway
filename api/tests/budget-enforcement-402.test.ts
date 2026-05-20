/**
 * Budget-threshold enforcement — 402 integration tests.
 *
 * Uses a mocked getAllAssets() to inject a fixture asset with budget_threshold
 * configured, so the 402 response body and counter emission are validated
 * end-to-end for both manifest (invoke) and install routes.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";
import type { CatalogAsset } from "../src/models/oasf.js";
import { POLICY_CONTRACT_VERSION } from "../src/models/policy-contract.js";
import { clearCostRecords, ingestCostRecord } from "../src/services/cost.service.js";
import { getCounters, resetCounters } from "../src/services/observability.service.js";

// ---------------------------------------------------------------------------
// Mock the catalog service — wrap getAllAssets in a spy so tests can inject
// fixture assets with budget_threshold configured.
// ---------------------------------------------------------------------------

vi.mock("../src/services/catalog.service.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/services/catalog.service.js")>();
  return {
    ...actual,
    getAllAssets: vi.fn(actual.getAllAssets),
  };
});

import { getAllAssets } from "../src/services/catalog.service.js";
import app from "../src/index.js";

// ---------------------------------------------------------------------------
// Fixture: a public-tier asset with a budget threshold and no other
// governance restrictions, so anonymous requests pass the governance check.
// ---------------------------------------------------------------------------

const BUDGET_ASSET_NAME = "aria.dev/skills/budget-test";
const BUDGET_ASSET_VERSION = "1.0.0";
const BUDGET_ASSET_ENCODED = encodeURIComponent(BUDGET_ASSET_NAME);

const FIXTURE_ASSET: CatalogAsset = {
  record: {
    name: BUDGET_ASSET_NAME,
    version: BUDGET_ASSET_VERSION,
    schema_version: "1.0.0",
    description: "Fixture asset for budget enforcement 402 tests",
    skills: [],
    domains: [{ name: "engineering" }],
    modules: [{ type: "mcp_server", transport: "stdio", tools: ["run"] }],
    locators: [{ type: "oci", uri: "ghcr.io/aria-fx/aria-assets/budget-test:1.0.0" }],
    authors: ["Test <test@aria.dev>"],
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    lifecycle_state: "published",
    tags: [],
  },
  governance: {
    sensitivity_tier: "public",
    allowed_consumers: ["all-employees"],
    budget_threshold: 100,
    budget_currency: "EUR",
  },
};

/** Cost record that pushes spend (120) above the 100 EUR threshold. */
const OVER_THRESHOLD_RECORD = {
  provider: "azure",
  asset_name: BUDGET_ASSET_NAME,
  asset_version: BUDGET_ASSET_VERSION,
  cost_usd: 120,
  period_start: "2026-01-01T00:00:00Z",
  period_end: "2026-01-31T23:59:59Z",
  currency: "EUR",
};

// ---------------------------------------------------------------------------
// Integration: GET /catalog/assets/:name/:version/manifest — 402 invoke flow
// ---------------------------------------------------------------------------

describe("GET /catalog/assets/:name/:version/manifest — 402 budget enforcement", () => {
  beforeEach(() => {
    clearCostRecords();
    resetCounters();
    vi.mocked(getAllAssets).mockResolvedValue([FIXTURE_ASSET]);
    ingestCostRecord(OVER_THRESHOLD_RECORD);
  });

  afterEach(() => {
    vi.mocked(getAllAssets).mockReset();
  });

  it("returns 402 when spend meets or exceeds the budget threshold", async () => {
    const res = await request(app).get(
      `/catalog/assets/${BUDGET_ASSET_ENCODED}/${BUDGET_ASSET_VERSION}/manifest`
    );
    expect(res.status).toBe(402);
  });

  it("returns allowed=false with the correct error message", async () => {
    const res = await request(app).get(
      `/catalog/assets/${BUDGET_ASSET_ENCODED}/${BUDGET_ASSET_VERSION}/manifest`
    );
    expect(res.body.allowed).toBe(false);
    expect(res.body.error).toBe("Asset invoke blocked: budget threshold exceeded");
  });

  it("includes the POLICY_CONTRACT_VERSION constant in the 402 body", async () => {
    const res = await request(app).get(
      `/catalog/assets/${BUDGET_ASSET_ENCODED}/${BUDGET_ASSET_VERSION}/manifest`
    );
    expect(res.body.contract_version).toBe(POLICY_CONTRACT_VERSION);
  });

  it("includes current_spend, threshold, and currency in the 402 body", async () => {
    const res = await request(app).get(
      `/catalog/assets/${BUDGET_ASSET_ENCODED}/${BUDGET_ASSET_VERSION}/manifest`
    );
    expect(res.body.current_spend).toBe(120);
    expect(res.body.threshold).toBe(100);
    expect(res.body.currency).toBe("EUR");
  });

  it("includes a structured reason object with code and message in the 402 body", async () => {
    const res = await request(app).get(
      `/catalog/assets/${BUDGET_ASSET_ENCODED}/${BUDGET_ASSET_VERSION}/manifest`
    );
    expect(res.body.reason).toMatchObject({
      code: "budget_exceeded",
      message: expect.stringContaining("EUR"),
    });
  });

  it("increments the budget.enforcement.invoke counter", async () => {
    await request(app).get(
      `/catalog/assets/${BUDGET_ASSET_ENCODED}/${BUDGET_ASSET_VERSION}/manifest`
    );
    expect(getCounters()["budget.enforcement.invoke"]).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Integration: POST /catalog/assets/:name/:version/install — 402 install flow
// ---------------------------------------------------------------------------

describe("POST /catalog/assets/:name/:version/install — 402 budget enforcement", () => {
  beforeEach(() => {
    clearCostRecords();
    resetCounters();
    vi.mocked(getAllAssets).mockResolvedValue([FIXTURE_ASSET]);
    ingestCostRecord(OVER_THRESHOLD_RECORD);
  });

  afterEach(() => {
    vi.mocked(getAllAssets).mockReset();
  });

  it("returns 402 when spend meets or exceeds the budget threshold", async () => {
    const res = await request(app)
      .post(`/catalog/assets/${BUDGET_ASSET_ENCODED}/${BUDGET_ASSET_VERSION}/install`)
      .send({ target: "claude_desktop" });
    expect(res.status).toBe(402);
  });

  it("returns allowed=false with the correct error message", async () => {
    const res = await request(app)
      .post(`/catalog/assets/${BUDGET_ASSET_ENCODED}/${BUDGET_ASSET_VERSION}/install`)
      .send({ target: "claude_desktop" });
    expect(res.body.allowed).toBe(false);
    expect(res.body.error).toBe("Install blocked: asset budget threshold exceeded");
  });

  it("includes the POLICY_CONTRACT_VERSION constant in the 402 body", async () => {
    const res = await request(app)
      .post(`/catalog/assets/${BUDGET_ASSET_ENCODED}/${BUDGET_ASSET_VERSION}/install`)
      .send({ target: "claude_desktop" });
    expect(res.body.contract_version).toBe(POLICY_CONTRACT_VERSION);
  });

  it("includes current_spend, threshold, and currency in the 402 body", async () => {
    const res = await request(app)
      .post(`/catalog/assets/${BUDGET_ASSET_ENCODED}/${BUDGET_ASSET_VERSION}/install`)
      .send({ target: "claude_desktop" });
    expect(res.body.current_spend).toBe(120);
    expect(res.body.threshold).toBe(100);
    expect(res.body.currency).toBe("EUR");
  });

  it("includes a structured reason object with code and message in the 402 body", async () => {
    const res = await request(app)
      .post(`/catalog/assets/${BUDGET_ASSET_ENCODED}/${BUDGET_ASSET_VERSION}/install`)
      .send({ target: "claude_desktop" });
    expect(res.body.reason).toMatchObject({
      code: "budget_exceeded",
      message: expect.stringContaining("EUR"),
    });
  });

  it("increments the budget.enforcement.install counter", async () => {
    await request(app)
      .post(`/catalog/assets/${BUDGET_ASSET_ENCODED}/${BUDGET_ASSET_VERSION}/install`)
      .send({ target: "claude_desktop" });
    expect(getCounters()["budget.enforcement.install"]).toBe(1);
  });
});
