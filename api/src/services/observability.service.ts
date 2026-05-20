/**
 * Auth/Policy Observability Service
 *
 * Emits structured JSON log events and maintains in-memory counters for:
 *   - auth failures (token missing, invalid, or JWKS unconfigured)
 *   - policy deny decisions (with deny reason classification)
 *   - legacy header fallback usage
 *
 * ## Feature flags (environment variables)
 *
 *   AUTH_ENFORCE        - "true" = enforce mode (401 on failure).
 *                         Unset / "false" = observe mode (log + continue).
 *   LEGACY_HEADERS_MODE - "enabled" (default) / "disabled".
 *
 * ## Log events
 *
 * All events are emitted as a single-line JSON string to stderr via
 * console.warn so they are captured by standard log collectors.
 * Emission is suppressed in "test" and "development" NODE_ENV values.
 *
 * ## Counters
 *
 * In-process counters are incremented for every event regardless of NODE_ENV.
 * Retrieve them via `getCounters()` or the GET /metrics endpoint.
 * Call `resetCounters()` in tests to isolate counter state.
 */

// ---------------------------------------------------------------------------
// Event types
// ---------------------------------------------------------------------------

export type AuthFailureReason =
  | "token_missing"
  | "token_invalid"
  | "jwks_unconfigured";

export type PolicyDenyReason =
  | "sensitivity_ceiling"
  | "consumer_not_allowed"
  | "entra_group_required"
  | "entra_role_required"
  | "purview_role_required"
  | "dependency_ceiling";

export interface AuthFailureEvent {
  event: "auth.failure";
  /** "observe" = non-enforcing mode (request was not blocked) */
  mode: "observe" | "enforce";
  reason: AuthFailureReason;
  error_message?: string;
  timestamp: string;
}

export interface PolicyDenyEvent {
  event: "policy.deny";
  asset_name: string;
  asset_version: string;
  consumer_id: string;
  deny_reason: PolicyDenyReason;
  timestamp: string;
}

export interface CostIngestionEvent {
  event: "cost.ingestion";
  record_id: string;
  provider: string;
  asset_name: string;
  timestamp: string;
}

export interface BudgetEnforcementEvent {
  event: "budget.enforcement";
  asset_name: string;
  asset_version: string;
  consumer_id: string;
  flow: "install" | "invoke";
  current_spend: number;
  threshold: number;
  currency: string;
  timestamp: string;
}

export type ObservabilityEvent =
  | AuthFailureEvent
  | PolicyDenyEvent
  | CostIngestionEvent
  | BudgetEnforcementEvent;

// ---------------------------------------------------------------------------
// In-memory counters
// ---------------------------------------------------------------------------

/**
 * Counter map keyed by event path, e.g.:
 *   "auth.failure.observe.token_missing"
 *   "auth.failure.enforce.token_invalid"
 *   "policy.deny.sensitivity_ceiling"
 *   "auth.legacy_header_used"
 */
const counters: Record<string, number> = {};

/** Returns a snapshot of all current counter values. */
export function getCounters(): Readonly<Record<string, number>> {
  return { ...counters };
}

/** Resets all counters to zero. Intended for use in tests only. */
export function resetCounters(): void {
  for (const key of Object.keys(counters)) {
    delete counters[key];
  }
}

function inc(key: string): void {
  counters[key] = (counters[key] ?? 0) + 1;
}

// ---------------------------------------------------------------------------
// Log emission
// ---------------------------------------------------------------------------

/**
 * Emits `event` as a JSON line to stderr.
 * Suppressed in "test" and "development" NODE_ENV to keep test output clean.
 */
function emit(event: ObservabilityEvent): void {
  const env = process.env.NODE_ENV ?? "development";
  if (env === "test" || env === "development") return;
  console.warn(JSON.stringify(event));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Emit an auth failure event and increment the corresponding counter.
 *
 * Call this whenever a bearer token is missing, invalid, or cannot be
 * verified.  Pass `mode: "observe"` when the request was not blocked
 * (AUTH_ENFORCE=false) and `mode: "enforce"` when it was rejected (401).
 */
export function emitAuthFailure(opts: {
  mode: "observe" | "enforce";
  reason: AuthFailureReason;
  error_message?: string;
}): void {
  inc(`auth.failure.${opts.mode}.${opts.reason}`);
  emit({
    event: "auth.failure",
    mode: opts.mode,
    reason: opts.reason,
    error_message: opts.error_message,
    timestamp: new Date().toISOString(),
  });
}

/**
 * Emit a policy deny event and increment the corresponding counter.
 *
 * Call this every time `checkGovernance` returns `allowed: false`.
 */
export function emitPolicyDeny(opts: {
  asset_name: string;
  asset_version: string;
  consumer_id: string;
  deny_reason: PolicyDenyReason;
}): void {
  inc(`policy.deny.${opts.deny_reason}`);
  emit({
    event: "policy.deny",
    asset_name: opts.asset_name,
    asset_version: opts.asset_version,
    consumer_id: opts.consumer_id,
    deny_reason: opts.deny_reason,
    timestamp: new Date().toISOString(),
  });
}

/**
 * Emit an audit event for a successfully ingested cost record.
 *
 * Call this after persisting each cost record so that cost ingestion
 * activity is captured in the structured event log.
 */
export function emitCostIngestion(opts: {
  record_id: string;
  provider: string;
  asset_name: string;
}): void {
  inc("cost.ingestion");
  emit({
    event: "cost.ingestion",
    record_id: opts.record_id,
    provider: opts.provider,
    asset_name: opts.asset_name,
    timestamp: new Date().toISOString(),
  });
}

/**
 * Emit a budget enforcement event and increment the corresponding counter.
 *
 * Call this whenever a budget threshold check blocks an install or invoke
 * flow.  The event is auditable and exposes the current spend, threshold,
 * and currency so operators can take remediation action.
 */
export function emitBudgetEnforcement(opts: {
  asset_name: string;
  asset_version: string;
  consumer_id: string;
  flow: "install" | "invoke";
  current_spend: number;
  threshold: number;
  currency: string;
}): void {
  inc(`budget.enforcement.${opts.flow}`);
  emit({
    event: "budget.enforcement",
    asset_name: opts.asset_name,
    asset_version: opts.asset_version,
    consumer_id: opts.consumer_id,
    flow: opts.flow,
    current_spend: opts.current_spend,
    threshold: opts.threshold,
    currency: opts.currency,
    timestamp: new Date().toISOString(),
  });
}
