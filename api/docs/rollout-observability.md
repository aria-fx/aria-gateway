# Rollout Observability Guide

> **Covers:** Auth enforcement feature flags · Structured log events · In-process counters · Rollout queries · Cutover criteria

---

## Overview

The ARIA Distribution Gateway ships with a two-stage rollout model that lets you safely migrate from legacy header-based auth to full JWT enforcement without interrupting traffic.

| Stage | `AUTH_ENFORCE` | Effect |
|-------|---------------|--------|
| **Observe** | `false` (default) | Invalid / missing tokens are logged and counted but the request proceeds. |
| **Enforce** | `true` | Invalid / missing tokens result in `401 Unauthorized` and the request is blocked. |

---

## Feature Flags

### `AUTH_ENFORCE`

Controls whether the auth middleware blocks unauthenticated requests.

```bash
# Observe mode — log auth failures, never block (default)
AUTH_ENFORCE=false

# Enforce mode — reject invalid/missing tokens with 401
AUTH_ENFORCE=true
```

**Decision guidance:**  
- Start deployments in **observe mode** to validate that all real clients can obtain and present valid JWT tokens.  
- Switch to **enforce mode** only when the `auth.failure.observe.*` counters have been zero (or negligibly small) for a sustained period (e.g. 7 days).

### `LEGACY_HEADERS_MODE`

Controls whether `x-consumer-id` / `x-sensitivity-ceiling` request headers are honoured as a fallback when no JWT is present.

```bash
# Legacy mode enabled — headers used as fallback (default, backward-compatible)
LEGACY_HEADERS_MODE=enabled

# Legacy mode disabled — header-only requests get anonymous / public-only context
LEGACY_HEADERS_MODE=disabled
```

> **Deprecation notice:** Legacy header support is targeted for removal on **2027-01-01**. See the [Migration Guide](#migration-guide) section.

---

## Structured Log Events

All observability events are emitted as **single-line JSON objects** to `stderr` via `console.warn`.  
Emission is **suppressed in `development` and `test` NODE_ENV** to keep local output clean.

### `auth.failure`

Emitted every time a bearer token is missing, malformed, or fails validation.

```json
{
  "event": "auth.failure",
  "mode": "observe",
  "reason": "token_missing",
  "error_message": null,
  "timestamp": "2026-05-03T03:00:00.000Z"
}
```

| Field | Type | Values |
|-------|------|--------|
| `event` | string | `"auth.failure"` |
| `mode` | string | `"observe"` — request not blocked; `"enforce"` — request rejected with 401 |
| `reason` | string | `token_missing` · `token_invalid` · `jwks_unconfigured` |
| `error_message` | string \| undefined | Token validation error message (e.g. JWT expired) |
| `timestamp` | ISO 8601 string | Event time |

### `policy.deny`

Emitted every time `checkGovernance` returns `allowed: false`.

```json
{
  "event": "policy.deny",
  "asset_name": "aria.dev/skills/financial-analyzer",
  "asset_version": "1.0.0",
  "consumer_id": "all-employees",
  "deny_reason": "sensitivity_ceiling",
  "timestamp": "2026-05-03T03:00:00.000Z"
}
```

| Field | Type | Values |
|-------|------|--------|
| `event` | string | `"policy.deny"` |
| `asset_name` | string | Full asset name (e.g. `aria.dev/skills/financial-analyzer`) |
| `asset_version` | string | Semantic version string |
| `consumer_id` | string | Consumer team slug or JWT `principal_id` |
| `deny_reason` | string | See [Deny Reasons](#deny-reasons) table |
| `timestamp` | ISO 8601 string | Event time |

#### Deny Reasons

| `deny_reason` | Cause |
|--------------|-------|
| `sensitivity_ceiling` | Consumer's ceiling is below the asset's sensitivity tier |
| `consumer_not_allowed` | Consumer ID is not in the asset's `allowed_consumers` list |
| `entra_group_required` | Consumer's JWT groups do not satisfy `allowed_entra_groups` |
| `entra_role_required` | Consumer's JWT roles do not satisfy `allowed_entra_roles` |
| `purview_role_required` | Consumer lacks a required Purview role |
| `dependency_ceiling` | An asset dependency exceeds the declared `dependency_sensitivity_ceiling` |

### `auth.legacy_header_used`

Emitted every time a request is served via legacy `x-consumer-id` / `x-sensitivity-ceiling` headers instead of a JWT.

```json
{
  "event": "auth.legacy_header_used",
  "consumer_id": "hr-team",
  "sensitivity_ceiling": "internal",
  "timestamp": "2026-05-03T03:00:00.000Z"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `event` | string | `"auth.legacy_header_used"` |
| `consumer_id` | string | Value of `x-consumer-id` header (or `"(absent)"`) |
| `sensitivity_ceiling` | string | Value of `x-sensitivity-ceiling` header (or `"(absent)"`) |
| `timestamp` | ISO 8601 string | Event time |

---

## In-Process Counters

The gateway maintains **in-process counters** that increment for every event, regardless of `NODE_ENV`.  
Counters accumulate from process start and reset on restart.

### Retrieve counters

```
GET /metrics
```

**Example response:**

```json
{
  "auth_enforce_mode": "observe",
  "legacy_headers_mode": "enabled",
  "counters": {
    "auth.failure.observe.token_missing": 42,
    "auth.failure.observe.token_invalid": 7,
    "auth.failure.enforce.token_missing": 0,
    "policy.deny.sensitivity_ceiling": 15,
    "policy.deny.consumer_not_allowed": 3,
    "auth.legacy_header_used": 128
  }
}
```

### Counter key schema

```
auth.failure.<mode>.<reason>
  mode   = observe | enforce
  reason = token_missing | token_invalid | jwks_unconfigured

policy.deny.<deny_reason>
  deny_reason = sensitivity_ceiling | consumer_not_allowed | entra_group_required |
                entra_role_required | purview_role_required | dependency_ceiling

auth.legacy_header_used
```

---

## Example Queries

The structured JSON log lines can be parsed by any log aggregation system.  
Replace the log filter syntax with the equivalent for your platform (CloudWatch Insights, Datadog, Splunk, Loki, etc.).

### CloudWatch Insights

**Count auth failures in observe mode (last 24 hours):**

```
fields @timestamp, reason, error_message
| filter event = "auth.failure" and mode = "observe"
| stats count(*) as failures by reason
| sort failures desc
```

**Track legacy header migration progress (per consumer team):**

```
fields @timestamp, consumer_id, sensitivity_ceiling
| filter event = "auth.legacy_header_used"
| stats count(*) as requests by consumer_id
| sort requests desc
```

**Policy deny breakdown by asset:**

```
fields @timestamp, asset_name, asset_version, consumer_id, deny_reason
| filter event = "policy.deny"
| stats count(*) as denials by asset_name, deny_reason
| sort denials desc
```

### Datadog Log Query

```
source:aria-gateway event:auth.failure mode:observe
```

```
source:aria-gateway event:auth.legacy_header_used | toplist(10, consumer_id)
```

### Loki / Grafana

```logql
{app="aria-gateway"} | json | event="auth.failure" | mode="observe"
```

---

## Rollout Procedure

### Stage 1 — Observe mode (current default)

1. Deploy with `AUTH_ENFORCE=false` (or unset).
2. Monitor `GET /metrics` and log queries for:
   - `auth.failure.observe.token_missing` — clients that never send a token.
   - `auth.failure.observe.token_invalid` — clients with expired / misconfigured tokens.
   - `auth.legacy_header_used` — clients still using header-based auth.
3. Work with consumer teams to issue Entra tokens and update clients.

### Stage 2 — Pre-enforce validation

Before switching to enforce mode:

- `auth.failure.observe.token_missing` must trend to zero over a 7-day window.
- `auth.failure.observe.token_invalid` must trend to zero.
- `auth.legacy_header_used` must trend to zero (or is acceptable to block).

### Stage 3 — Enforce mode

1. Set `AUTH_ENFORCE=true` in the deployment configuration.
2. Optionally set `LEGACY_HEADERS_MODE=disabled` to block header-only fallback.
3. Monitor `auth.failure.enforce.*` counters — any non-zero value indicates a misconfigured client.

---

## Cutover Criteria

The following conditions must all be met before flipping `AUTH_ENFORCE=true`:

| Criterion | Metric / Log to check | Target |
|-----------|----------------------|--------|
| No unauthenticated clients | `auth.failure.observe.token_missing` counter | 0 for 7 consecutive days |
| No invalid tokens in flight | `auth.failure.observe.token_invalid` counter | 0 for 7 consecutive days |
| Legacy header traffic eliminated | `auth.legacy_header_used` counter | 0 for 7 consecutive days, **or** explicit sign-off that remaining traffic can be blocked |
| Policy deny rate stable | `policy.deny.*` counters | Stable or decreasing trend; no unexpected spikes |
| Rollback plan confirmed | Deployment config allows instant revert to `AUTH_ENFORCE=false` | Documented in runbook |

---

## Migration Guide

1. **Issue Entra tokens** to every consumer (application registrations or managed identities).
2. **Update clients** to send `Authorization: Bearer <token>` instead of `x-consumer-id` / `x-sensitivity-ceiling` headers.
3. **Monitor** `auth.legacy_header_used` and `auth.failure.observe.*` counters until they reach zero.
4. **Set `LEGACY_HEADERS_MODE=disabled`** to ensure no header-only requests slip through.
5. **Set `AUTH_ENFORCE=true`** to enforce JWT authentication for all requests.
6. After **2027-01-01**, support for `LEGACY_HEADERS_MODE=enabled` will be dropped entirely.

---

## Related Documents

- [Policy Contract](./policy-contract.md) — `NormalizedIdentity`, `EffectiveAccessContext`, `PolicyDecision` schema
- [Conformance Fixtures](./conformance-fixtures.md) — Cross-language policy engine test cases
- Source: `api/src/services/observability.service.ts`
