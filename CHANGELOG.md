# Changelog

All notable changes to the ARIA Distribution Gateway are documented in this file.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

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
