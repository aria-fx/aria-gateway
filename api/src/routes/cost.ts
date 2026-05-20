import { Router } from "express";
import { z } from "zod";
import { providerCostRecordSchema } from "../models/cost.js";
import {
  ingestCostRecord,
  getAssetCostSummaries,
  getTopAssets,
} from "../services/cost.service.js";
import { emitCostIngestion } from "../services/observability.service.js";

const router = Router();

// ---------------------------------------------------------------------------
// POST /cost/ingest — submit a provider cost record
// ---------------------------------------------------------------------------

router.post("/ingest", (req, res) => {
  const parsed = providerCostRecordSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: "Invalid cost record",
      details: parsed.error.flatten(),
    });
    return;
  }

  const stored = ingestCostRecord(parsed.data);

  emitCostIngestion({
    record_id: stored.id,
    provider: stored.provider,
    asset_name: stored.asset_name,
  });

  res.status(201).json({
    id: stored.id,
    ingested_at: stored.ingested_at,
  });
});

// ---------------------------------------------------------------------------
// Shared query-parameter schema for read endpoints
// ---------------------------------------------------------------------------

const costQuerySchema = z.object({
  /** Filter to a specific provider. */
  provider: z.string().optional(),
  /**
   * Inclusive start of the query window (ISO 8601 date or datetime).
   * Records whose period_end is before this value are excluded.
   */
  from: z.string().optional(),
  /**
   * Inclusive end of the query window (ISO 8601 date or datetime).
   * Records whose period_start is after this value are excluded.
   */
  to: z.string().optional(),
});

// ---------------------------------------------------------------------------
// GET /cost/assets — per-asset cost summaries
// ---------------------------------------------------------------------------

router.get("/assets", (req, res) => {
  const parsed = costQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({
      error: "Invalid query parameters",
      details: parsed.error.flatten(),
    });
    return;
  }

  const summaries = getAssetCostSummaries(parsed.data);
  res.json({ assets: summaries, total: summaries.length });
});

// ---------------------------------------------------------------------------
// GET /cost/assets/top — top N assets by total spend
// ---------------------------------------------------------------------------

router.get("/assets/top", (req, res) => {
  const topQuerySchema = costQuerySchema.extend({
    /** Maximum number of assets to return (1–100, default 10). */
    limit: z.coerce.number().int().min(1).max(100).default(10).optional(),
  });

  const parsed = topQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({
      error: "Invalid query parameters",
      details: parsed.error.flatten(),
    });
    return;
  }

  const top = getTopAssets(parsed.data);
  res.json({ assets: top, total: top.length });
});

export default router;
