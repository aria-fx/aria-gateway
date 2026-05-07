# Changelog

All notable changes to the ARIA Distribution Gateway are documented in this file.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

---

## [2.0.0] – 2026-05-03

### Removed — Legacy Header Auth Path (Breaking Change)

**Closes:** Auth Core: Final cutover and legacy auth path removal

#### What changed

The deprecated `x-consumer-id` / `x-sensitivity-ceiling` header-based identity path
has been permanently removed.  All consumers **must** use JWT bearer tokens.

| Component | Change |
|-----------|--------|
| `governance.service.ts` | `isLegacyHeadersMode()` removed. `parseConsumerContext()` now accepts only JWT identity; unauthenticated requests receive anonymous / public-only context. The `LEGACY_HEADERS_MODE` environment variable is no longer read. |
| `observability.service.ts` | `emitLegacyHeaderUsed()` and the `LegacyHeaderEvent` type removed. The `auth.legacy_header_used` counter will no longer appear in `/metrics` output. |
| `index.ts` | `X-Consumer-Id` and `X-Sensitivity-Ceiling` removed from CORS `allowedHeaders`. The `legacy_headers_mode` field removed from the `/metrics` response. |
| `routes/plugins.ts` | `ConsumerHeaders` security scheme removed from the OpenAPI spec. All catalog operations now require `BearerAuth` only. |
| `auth.middleware.ts` | `LEGACY_HEADERS_MODE` environment variable documentation removed. |

#### Migration

If you have not yet migrated to JWT bearer tokens, refer to the
[Auth Migration Runbook](api/docs/auth-migration-runbook.md).

**Post-cutover environment variables to clean up:**

```bash
# Remove these — they are no longer read:
LEGACY_HEADERS_MODE=enabled   # ← delete this line
```

**Post-cutover recommended settings:**

```bash
AUTH_ENFORCE=true   # Require a valid JWT on every request
```

#### Tightened defaults for governed routes

Unauthenticated requests now receive an **anonymous / public-only** access context
(`consumer_id="anonymous"`, `sensitivity_ceiling="public"`).  Assets classified
as `internal`, `confidential`, or `highly_confidential` will return `403` for
unauthenticated callers.

To require a valid JWT on every request (recommended for production), set:

```bash
AUTH_ENFORCE=true
```

---

## [1.0.0] – 2026-05-02

### Added

#### Auth-Core Policy Contract v1.0.0

Introduces a versioned, language-neutral policy contract for identity input,
effective access, and governance decisions.  The contract keeps the TypeScript
gateway and the companion `.NET auth-core` library aligned without tight
coupling.

**Contract location:**
- TypeScript types: [`api/src/models/policy-contract.ts`](api/src/models/policy-contract.ts)
- JSON Schema: [`api/docs/policy-contract.schema.json`](api/docs/policy-contract.schema.json)
- Documentation: [`api/docs/policy-contract.md`](api/docs/policy-contract.md)

**New types exported from `api/src/models/policy-contract.ts`:**

| Type | Description |
|------|-------------|
| `NormalizedIdentity` | Authenticated principal normalised from any IDP |
| `EffectiveAccessContext` | Resolved access rights used during governance evaluation |
| `PolicyDecision` | Result of evaluating an asset's policy overlay |
| `IdentityProvider` | Union of well-known IDP slugs (extensible) |
| `PolicyContractVersion` | Literal type `"1.0.0"` |
| `POLICY_CONTRACT_VERSION` | Runtime constant `"1.0.0"` |
| `withContractVersion` | Helper to stamp `contract_version` onto any object |

**Updated:**
- `governance.service.ts` — `ConsumerContext` is now a type alias for
  `EffectiveAccessContext` (adds optional `purview_roles`).  `checkGovernance`
  returns `PolicyDecision`.  All existing API behaviour is preserved.
- `oasf.ts` — re-exports the contract types for convenience; `GovernanceCheckResult`
  is retained with a `@deprecated` notice.

**Versioning strategy:**
- PATCH bumps for documentation fixes.
- MINOR bumps for additive optional fields or new IDP slugs.
- MAJOR bumps for breaking changes (field renames, removed fields).
- Consumers must reject objects where the MAJOR version differs.
