/**
 * Cost ingestion data model for per-asset spend attribution.
 *
 * ProviderCostRecord — schema for raw cost records pushed by a provider integration.
 * StoredCostRecord   — persisted record with auto-generated id and ingestion timestamp.
 * AssetCostSummary   — aggregated spend for a single asset over a query window.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Ingestion schema
// ---------------------------------------------------------------------------

export const providerCostRecordSchema = z.object({
  /** Cloud or AI provider identifier, e.g. "azure", "aws", "openai". */
  provider: z.string().min(1).max(64),

  /** OASF asset name this cost is attributed to, e.g. "aria.dev/skills/hr-policy-lookup". */
  asset_name: z.string().min(1).max(256),

  /** Optional semver asset version. Omit when the cost is provider-level only. */
  asset_version: z.string().optional(),

  /** Total spend for the period in the reported currency (non-negative). */
  cost_usd: z.number().nonnegative(),

  /** Inclusive start of the billing period (ISO 8601). */
  period_start: z.string().datetime({ offset: true }),

  /** Inclusive end of the billing period (ISO 8601). */
  period_end: z.string().datetime({ offset: true }),

  /** ISO 4217 currency code. Defaults to "USD". */
  currency: z.string().length(3).default("USD"),

  /** Optional free-form tags for grouping, e.g. { team: "hr", env: "prod" }. */
  tags: z.record(z.string()).optional(),
}).refine(
  (r) => r.period_end >= r.period_start,
  { message: "period_end must be >= period_start", path: ["period_end"] },
);

export type ProviderCostRecord = z.infer<typeof providerCostRecordSchema>;

// ---------------------------------------------------------------------------
// Stored record (adds server-generated fields)
// ---------------------------------------------------------------------------

export interface StoredCostRecord extends ProviderCostRecord {
  /** Server-generated UUID for this record. */
  id: string;
  /** ISO 8601 timestamp when the record was ingested by the gateway. */
  ingested_at: string;
}

// ---------------------------------------------------------------------------
// Aggregated read model
// ---------------------------------------------------------------------------

export interface AssetCostSummary {
  asset_name: string;
  asset_version?: string;
  provider: string;
  /** Sum of cost_usd for all matching records. */
  total_cost_usd: number;
  /** Earliest period_start across matched records. */
  period_start: string;
  /** Latest period_end across matched records. */
  period_end: string;
  /** Number of raw records aggregated. */
  record_count: number;
}
