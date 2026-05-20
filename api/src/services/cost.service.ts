/**
 * Cost Service — per-asset spend ingestion and aggregation.
 *
 * Uses an in-memory store so no external database is required.
 * Each gateway instance maintains its own record set; for production
 * deployments replace the in-memory store with a persistent backend.
 */

import { v4 as uuidv4 } from "uuid";
import type { ProviderCostRecord, StoredCostRecord, AssetCostSummary } from "../models/cost.js";

// ---------------------------------------------------------------------------
// In-memory store
// ---------------------------------------------------------------------------

const records: StoredCostRecord[] = [];

// ---------------------------------------------------------------------------
// Write path
// ---------------------------------------------------------------------------

/**
 * Persist a validated cost record and return the stored copy with its
 * server-assigned id and ingestion timestamp.
 */
export function ingestCostRecord(record: ProviderCostRecord): StoredCostRecord {
  const stored: StoredCostRecord = {
    ...record,
    id: uuidv4(),
    ingested_at: new Date().toISOString(),
  };
  records.push(stored);
  return stored;
}

// ---------------------------------------------------------------------------
// Read path
// ---------------------------------------------------------------------------

export interface CostQueryOptions {
  /** Filter to a specific provider. Omit to include all providers. */
  provider?: string;
  /**
   * Inclusive lower bound on the billing window.
   * Records whose period_end is before this date are excluded.
   */
  from?: string;
  /**
   * Inclusive upper bound on the billing window.
   * Records whose period_start is after this date are excluded.
   */
  to?: string;
}

/**
 * Return per-asset cost summaries, grouped by (provider, asset_name, asset_version).
 */
export function getAssetCostSummaries(opts: CostQueryOptions = {}): AssetCostSummary[] {
  return aggregate(filterRecords(opts));
}

/**
 * Return the top N assets ordered by total_cost (descending).
 */
export function getTopAssets(
  opts: CostQueryOptions & { limit?: number } = {},
): AssetCostSummary[] {
  const limit = Math.max(1, Math.min(opts.limit ?? 10, 100));
  const summaries = getAssetCostSummaries(opts);
  summaries.sort((a, b) => b.total_cost - a.total_cost);
  return summaries.slice(0, limit);
}

// ---------------------------------------------------------------------------
// Test helper
// ---------------------------------------------------------------------------

/** Remove all in-memory records. Intended for use in tests only. */
export function clearCostRecords(): void {
  records.length = 0;
}

// ---------------------------------------------------------------------------
// Budget threshold check
// ---------------------------------------------------------------------------

export interface BudgetCheckResult {
  /** Whether current spend meets or exceeds the configured threshold. */
  exceeded: boolean;
  /** Sum of all recorded spend for the asset (rounded to the nearest cent). */
  current_spend: number;
  /** The configured threshold. */
  threshold: number;
  /** Always `"USD"` — spend is accumulated from the `cost` field on ingested records. */
  currency: string;
}

/**
 * Check whether the accumulated spend for an asset has reached a configured
 * threshold.  Totals all records for the given `assetName` (across all
 * providers and all versions) with no date-window filter, so enforcement is
 * based on lifetime spend for the asset name rather than a rolling window or
 * a per-version sub-total.
 *
 * This is intentional: `budget_threshold` represents the overall spend cap
 * for the asset (independent of which specific version is being installed or
 * invoked), matching how cloud cost dashboards typically bucket spend.
 * If you need per-version enforcement, configure separate governance overlays
 * per version and filter cost records accordingly before calling this helper.
 *
 * Spend is always accumulated from the `cost` field on ingested records
 * and compared directly against `threshold` as a plain number. Currency
 * labelling in `budget_currency` is informational only — no FX conversion
 * is performed.  `current_spend` in the result is always denominated in the
 * same unit as the ingested `cost` values.
 *
 * @param assetName   - OASF asset name to aggregate spend for.
 * @param threshold   - Maximum spend value before enforcement triggers.
 *
 * Returns `exceeded: true` when `current_spend >= threshold`.
 */
export function checkBudgetThreshold(
  assetName: string,
  threshold: number,
): BudgetCheckResult {
  const current_spend = round2(
    records.reduce(
      (sum, record) => sum + (record.asset_name === assetName ? record.cost : 0),
      0
    )
  );
  return {
    exceeded: current_spend >= threshold,
    current_spend,
    threshold,
    currency: "USD",
  };
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

function filterRecords(opts: CostQueryOptions): StoredCostRecord[] {
  return records.filter((r) => {
    if (opts.provider && r.provider !== opts.provider) return false;
    // Keep records whose billing window overlaps with [from, to]
    if (opts.from && r.period_end < opts.from) return false;
    if (opts.to && r.period_start > opts.to) return false;
    return true;
  });
}

function aggregate(recs: StoredCostRecord[]): AssetCostSummary[] {
  const map = new Map<string, AssetCostSummary>();

  for (const r of recs) {
    const key = `${r.provider}::${r.asset_name}::${r.asset_version ?? ""}`;
    const existing = map.get(key);

    if (existing) {
      existing.total_cost = round2(existing.total_cost + r.cost);
      existing.record_count += 1;
      if (r.period_start < existing.period_start) existing.period_start = r.period_start;
      if (r.period_end > existing.period_end) existing.period_end = r.period_end;
    } else {
      map.set(key, {
        asset_name: r.asset_name,
        asset_version: r.asset_version,
        provider: r.provider,
        total_cost: r.cost,
        period_start: r.period_start,
        period_end: r.period_end,
        record_count: 1,
      });
    }
  }

  return Array.from(map.values());
}

/** Round to the nearest cent to avoid floating-point accumulation errors. */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
