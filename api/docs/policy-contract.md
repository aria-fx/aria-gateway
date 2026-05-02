# Auth-Core Policy Contract

> **Version:** `1.0.0`  
> **Status:** Active  
> **Location:** `api/src/models/policy-contract.ts` (TypeScript) · `api/docs/policy-contract.schema.json` (JSON Schema)

---

## Overview

This document defines the **versioned, language-neutral policy contract** used by the ARIA Distribution Gateway and the companion `.NET auth-core` library to exchange identity and governance information.

The contract ensures that both implementations stay aligned across three concerns:

| Concern | Contract Object | Description |
|---------|----------------|-------------|
| Identity input | `NormalizedIdentity` | Authenticated principal as resolved from an upstream IDP |
| Effective access | `EffectiveAccessContext` | Resolved access rights used during governance evaluation |
| Governance decision | `PolicyDecision` | Result of evaluating an asset's policy overlay |

All three objects carry a `contract_version` field (semver string) so that consumers can detect schema mismatches at runtime.

---

## Versioning Strategy

### Scheme

The contract follows **Semantic Versioning 2.0.0**:

- **PATCH** (`1.0.x`) — documentation fixes, non-breaking clarifications, typo corrections in `reason` strings.
- **MINOR** (`1.x.0`) — additive changes: new _optional_ fields, new well-known `IdentityProvider` slug values, new well-known `purview_roles` strings. Consumers that ignore unknown fields remain compatible.
- **MAJOR** (`x.0.0`) — breaking changes: field renames, type narrowing, removed fields, changed semantics of `allowed`.

### Compatibility Rules

1. **Forward compatibility** — A consumer built against contract `1.0.0` **must** tolerate objects produced by any `1.x.y` version (unknown optional fields are ignored).
2. **Backward compatibility** — A producer at `1.x.y` **must** include all fields that were required in `1.0.0`.
3. **Version detection** — If a consumer receives a `contract_version` with a different MAJOR, it **must** reject the object with a clear error rather than silently misinterpreting it.

### Current Version

```typescript
export const POLICY_CONTRACT_VERSION = "1.0.0";
```

The constant is exported from `api/src/models/policy-contract.ts` and stamped onto every object produced by the gateway.

---

## Contract Objects

### `NormalizedIdentity`

Represents an authenticated principal as resolved from an identity provider, normalised to IDP-agnostic fields.

```typescript
interface NormalizedIdentity {
  contract_version: "1.0.0";   // required — schema version
  provider: IdentityProvider;  // required — IDP slug
  principal_id: string;        // required — immutable subject/object ID
  display_name?: string;       // optional — human-readable name
  email?: string;              // optional — verified email
  groups: string[];            // required — group memberships
  roles: string[];             // required — application roles + OAuth scopes
  tenant?: string;             // optional — tenant/org identifier
  extensions?: Record<string, unknown>; // optional — IDP-specific claims
}
```

**Field mapping to OIDC claims:**

| Field | OIDC / OAuth claim | Notes |
|-------|-------------------|-------|
| `principal_id` | `sub` | Use provider's object ID when `sub` is opaque |
| `display_name` | `name` | |
| `email` | `email` | Only if `email_verified: true` |
| `groups` | `groups` | Provider-dependent format (see IDP notes below) |
| `roles` | `roles` + `scp` | De-duplicated union of both claims |
| `tenant` | `tid` (Entra) / `org` | |

---

### `EffectiveAccessContext`

The resolved access context that the governance engine evaluates against an asset's policy overlay.

```typescript
interface EffectiveAccessContext {
  contract_version: "1.0.0";         // required
  consumer_id: string;               // required — team/app slug
  sensitivity_ceiling: SensitivityTier; // required
  purview_roles: string[];           // required — may be empty []
  identity?: NormalizedIdentity;     // optional — originating identity
}
```

**`sensitivity_ceiling` values** (ordered, lowest → highest):

| Value | Who can see assets at this tier |
|-------|--------------------------------|
| `public` | Everyone, including unauthenticated callers |
| `internal` | All employees / authenticated principals |
| `confidential` | Specific teams with explicit approval |
| `highly_confidential` | Named consumers only |

**Well-known `purview_roles`:**

| Role string | Grants |
|------------|--------|
| `purview:export-approver` | May approve data-export requests |
| `purview:audit-reader` | Read access to audit logs |
| `purview:compliance-officer` | Can override data-residency restrictions |

Custom purview roles are allowed; prefix with a namespace to avoid collisions (e.g. `acme:data-steward`).

---

### `PolicyDecision`

The result of evaluating an asset's governance overlay against an `EffectiveAccessContext`.

```typescript
interface PolicyDecision {
  contract_version: "1.0.0";  // required
  allowed: boolean;            // required
  reason?: string;             // required when allowed === false
  approval_chain?: string[];   // ordered approver list
  action_url?: string;         // URL to request access
}
```

When `allowed` is `false`, both `reason` (human-readable explanation) and `action_url` (the gateway's `/request-access` endpoint) are populated so the consumer can surface actionable guidance.

---

## Wire Format

All three objects serialize to JSON.  Example of a full `PolicyDecision` response body from the gateway:

```json
{
  "contract_version": "1.0.0",
  "allowed": false,
  "reason": "This asset is classified as \"confidential\" but your access level only permits \"internal\" assets.",
  "approval_chain": ["hr-manager", "it-security"],
  "action_url": "/catalog/assets/aria.dev%2Fskills%2Ffinancial-analyzer/1.0.0/request-access"
}
```

---

## Extension Points for Future IDPs

The contract is designed to remain IDP-agnostic.  To add support for a new identity provider:

### 1. Register a new `IdentityProvider` slug

Add the slug to the `IdentityProvider` union type in `policy-contract.ts` as a MINOR version bump:

```typescript
// Before (1.0.0)
export type IdentityProvider = "entra" | "okta" | "github" | "cognito" | "google" | (string & {});

// After (1.1.0)
export type IdentityProvider = "entra" | "okta" | "github" | "cognito" | "google" | "ping" | (string & {});
```

The `(string & {})` catch-all means any slug already works at runtime — the union update is for documentation and IDE autocomplete only.

### 2. Map IDP claims to `NormalizedIdentity`

Write an IDP-specific adapter that maps the token payload to `NormalizedIdentity`.  Claims that do not map to a canonical field go into `extensions`:

```typescript
// Example: Ping Identity adapter
function normalizePingIdentity(token: PingTokenPayload): NormalizedIdentity {
  return withContractVersion({
    provider: "ping",
    principal_id: token.sub,
    display_name: token.cn,
    email: token.mail,
    groups: token.memberOf ?? [],
    roles: token.appRoles ?? [],
    tenant: token.orgId,
    extensions: {
      "ping:employee_type": token.employeeType,
    },
  });
}
```

### 3. Derive `EffectiveAccessContext` from the normalized identity

The gateway's `parseConsumerContext` function (and the .NET `PolicyEngine`) must be updated to populate `sensitivity_ceiling` and `purview_roles` from the new IDP's group/role vocabulary.

### 4. No changes needed for `PolicyDecision`

The decision shape is IDP-agnostic and requires no changes.

---

## Compatibility Notes

| Scenario | Behaviour |
|----------|-----------|
| `contract_version` absent | Treat as pre-1.0 legacy object; log a warning |
| MAJOR version mismatch | Reject with `400 Bad Request` or throw |
| MINOR version ahead of consumer | Ignore unknown optional fields |
| New `purview_roles` value unknown to consumer | Treat as no-op (ignore unknown roles, do not deny access) |
| `identity` absent in `EffectiveAccessContext` | Valid for header-only / service-account flows |

---

## Changelog

See [CHANGELOG.md](../../../CHANGELOG.md) for the full history.

| Version | Date | Summary |
|---------|------|---------|
| `1.0.0` | 2026-05-02 | Initial contract: `NormalizedIdentity`, `EffectiveAccessContext`, `PolicyDecision` |
