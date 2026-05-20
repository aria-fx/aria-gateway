/**
 * Cost API tests — ingestion, aggregation, top-assets, and validation.
 */

import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import app from "../src/index.js";
import { clearCostRecords } from "../src/services/cost.service.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VALID_RECORD = {
  provider: "azure",
  asset_name: "aria.dev/skills/hr-policy-lookup",
  asset_version: "1.2.0",
  cost_usd: 42.50,
  period_start: "2026-01-01T00:00:00Z",
  period_end: "2026-01-31T23:59:59Z",
  currency: "USD",
  tags: { team: "hr", env: "prod" },
};

// ---------------------------------------------------------------------------
// POST /cost/ingest
// ---------------------------------------------------------------------------

describe("POST /cost/ingest", () => {
  beforeEach(() => clearCostRecords());

  it("returns 201 with id and ingested_at for a valid record", async () => {
    const res = await request(app)
      .post("/cost/ingest")
      .send(VALID_RECORD)
      .set("Content-Type", "application/json");

    expect(res.status).toBe(201);
    expect(typeof res.body.id).toBe("string");
    expect(res.body.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(typeof res.body.ingested_at).toBe("string");
    expect(new Date(res.body.ingested_at).getTime()).not.toBeNaN();
  });

  it("accepts a minimal record without optional fields", async () => {
    const res = await request(app)
      .post("/cost/ingest")
      .send({
        provider: "aws",
        asset_name: "aria.dev/agents/code-assistant",
        cost_usd: 0,
        period_start: "2026-02-01T00:00:00Z",
        period_end: "2026-02-28T23:59:59Z",
      })
      .set("Content-Type", "application/json");

    expect(res.status).toBe(201);
  });

  it("returns 400 when required fields are missing", async () => {
    const res = await request(app)
      .post("/cost/ingest")
      .send({ provider: "azure" })
      .set("Content-Type", "application/json");

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid cost record");
    expect(res.body.details).toBeDefined();
  });

  it("returns 400 when cost_usd is negative", async () => {
    const res = await request(app)
      .post("/cost/ingest")
      .send({ ...VALID_RECORD, cost_usd: -1 })
      .set("Content-Type", "application/json");

    expect(res.status).toBe(400);
  });

  it("returns 400 when period_end is before period_start", async () => {
    const res = await request(app)
      .post("/cost/ingest")
      .send({
        ...VALID_RECORD,
        period_start: "2026-01-31T00:00:00Z",
        period_end: "2026-01-01T00:00:00Z",
      })
      .set("Content-Type", "application/json");

    expect(res.status).toBe(400);
  });

  it("returns 400 when provider is empty", async () => {
    const res = await request(app)
      .post("/cost/ingest")
      .send({ ...VALID_RECORD, provider: "" })
      .set("Content-Type", "application/json");

    expect(res.status).toBe(400);
  });

  it("returns 400 when period_start is not an ISO datetime", async () => {
    const res = await request(app)
      .post("/cost/ingest")
      .send({ ...VALID_RECORD, period_start: "not-a-date" })
      .set("Content-Type", "application/json");

    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// GET /cost/assets
// ---------------------------------------------------------------------------

describe("GET /cost/assets", () => {
  beforeEach(async () => {
    clearCostRecords();
    // Seed some records
    await request(app).post("/cost/ingest").send(VALID_RECORD);
    await request(app).post("/cost/ingest").send({
      provider: "aws",
      asset_name: "aria.dev/agents/code-assistant",
      cost_usd: 100,
      period_start: "2026-02-01T00:00:00Z",
      period_end: "2026-02-28T23:59:59Z",
    });
    await request(app).post("/cost/ingest").send({
      ...VALID_RECORD,
      cost_usd: 10,
      period_start: "2026-02-01T00:00:00Z",
      period_end: "2026-02-28T23:59:59Z",
    });
  });

  it("returns all summaries when no filters applied", async () => {
    const res = await request(app).get("/cost/assets");

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.assets)).toBe(true);
    expect(res.body.total).toBe(res.body.assets.length);
    // Two distinct asset+provider combos: azure/hr-policy-lookup and aws/code-assistant
    expect(res.body.total).toBe(2);
  });

  it("aggregates multiple records for the same asset+provider", async () => {
    const res = await request(app).get("/cost/assets?provider=azure");

    expect(res.status).toBe(200);
    expect(res.body.assets).toHaveLength(1);
    const summary = res.body.assets[0];
    expect(summary.asset_name).toBe("aria.dev/skills/hr-policy-lookup");
    expect(summary.provider).toBe("azure");
    expect(summary.total_cost_usd).toBeCloseTo(52.5); // 42.50 + 10
    expect(summary.record_count).toBe(2);
  });

  it("filters by provider", async () => {
    const res = await request(app).get("/cost/assets?provider=aws");

    expect(res.status).toBe(200);
    expect(res.body.assets).toHaveLength(1);
    expect(res.body.assets[0].provider).toBe("aws");
  });

  it("filters by from date — excludes records ending before 'from'", async () => {
    // from=2026-02-01 → only the February records remain
    const res = await request(app).get("/cost/assets?from=2026-02-01T00:00:00Z");

    expect(res.status).toBe(200);
    // azure January record is excluded; azure February and aws February remain → 2 summaries
    expect(res.body.total).toBe(2);
  });

  it("filters by to date — excludes records starting after 'to'", async () => {
    // to=2026-01-31 → only the January record remains
    const res = await request(app).get("/cost/assets?to=2026-01-31T23:59:59Z");

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.assets[0].provider).toBe("azure");
  });

  it("each summary includes required fields", async () => {
    const res = await request(app).get("/cost/assets");

    for (const s of res.body.assets) {
      expect(s).toHaveProperty("asset_name");
      expect(s).toHaveProperty("provider");
      expect(s).toHaveProperty("total_cost_usd");
      expect(s).toHaveProperty("period_start");
      expect(s).toHaveProperty("period_end");
      expect(s).toHaveProperty("record_count");
    }
  });

  it("returns empty list when no records match the filter", async () => {
    const res = await request(app).get("/cost/assets?provider=nonexistent");

    expect(res.status).toBe(200);
    expect(res.body.assets).toHaveLength(0);
    expect(res.body.total).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// GET /cost/assets/top
// ---------------------------------------------------------------------------

describe("GET /cost/assets/top", () => {
  beforeEach(async () => {
    clearCostRecords();
    // Seed three distinct assets with varying spend
    const assets = [
      { provider: "azure", asset_name: "aria.dev/a", cost_usd: 50 },
      { provider: "azure", asset_name: "aria.dev/b", cost_usd: 200 },
      { provider: "azure", asset_name: "aria.dev/c", cost_usd: 10 },
    ];
    for (const a of assets) {
      await request(app).post("/cost/ingest").send({
        ...a,
        period_start: "2026-01-01T00:00:00Z",
        period_end: "2026-01-31T23:59:59Z",
      });
    }
  });

  it("returns assets ordered by total_cost_usd descending", async () => {
    const res = await request(app).get("/cost/assets/top");

    expect(res.status).toBe(200);
    const costs = res.body.assets.map((a: { total_cost_usd: number }) => a.total_cost_usd);
    expect(costs).toEqual([...costs].sort((a, b) => b - a));
  });

  it("respects the limit parameter", async () => {
    const res = await request(app).get("/cost/assets/top?limit=2");

    expect(res.status).toBe(200);
    expect(res.body.assets).toHaveLength(2);
    // Should be the top 2 by spend
    expect(res.body.assets[0].total_cost_usd).toBe(200);
    expect(res.body.assets[1].total_cost_usd).toBe(50);
  });

  it("defaults to limit=10 when not specified", async () => {
    const res = await request(app).get("/cost/assets/top");

    expect(res.status).toBe(200);
    expect(res.body.assets.length).toBeLessThanOrEqual(10);
  });

  it("returns 400 for invalid limit", async () => {
    const res = await request(app).get("/cost/assets/top?limit=0");

    expect(res.status).toBe(400);
  });

  it("returns empty list when store is empty", async () => {
    clearCostRecords();
    const res = await request(app).get("/cost/assets/top");

    expect(res.status).toBe(200);
    expect(res.body.assets).toHaveLength(0);
    expect(res.body.total).toBe(0);
  });

  it("filters by provider before ranking", async () => {
    // Add an AWS record that would otherwise rank first
    await request(app).post("/cost/ingest").send({
      provider: "aws",
      asset_name: "aria.dev/z",
      cost_usd: 9999,
      period_start: "2026-01-01T00:00:00Z",
      period_end: "2026-01-31T23:59:59Z",
    });

    const res = await request(app).get("/cost/assets/top?provider=azure");

    expect(res.status).toBe(200);
    for (const a of res.body.assets) {
      expect(a.provider).toBe("azure");
    }
  });
});
