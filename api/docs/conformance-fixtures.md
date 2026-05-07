# Policy Conformance Fixtures

> **Status:** Active  
> **Fixture version:** `1.0.0`  
> **Targets contract version:** `1.0.0`  
> **Location:** `api/tests/fixtures/conformance-cases.json`  
> **Test runner:** `api/tests/conformance.test.ts`

---

## Purpose

The conformance fixture suite validates that **the gateway's TypeScript policy engine produces identical decisions** to any other auth-core implementation (e.g. the .NET `PolicyEngine`) for the same set of inputs.

Each fixture case is a self-contained JSON document that specifies:

1. An **asset** with a governance overlay (sensitivity tier, allow-list, group/role constraints, dependency ceiling).
2. A **consumer** access context (identity, sensitivity ceiling, purview roles).
3. The **expected** `PolicyDecision` outcome (`allowed`, optional `reason_contains` substring).

Running the same cases against every language implementation makes policy drift visible immediately.

---

## Fixture Format

```jsonc
{
  "fixture_version": "1.0.0",          // semver of this fixture schema
  "policy_contract_version": "1.0.0",  // contract version the fixtures target
  "description": "...",
  "cases": [
    {
      "id": "CF-001",                  // unique, stable, never reused
      "description": "...",
      "tags": ["sensitivity"],         // one or more dimension tags
      "asset": { /* CatalogAsset */ },
      "consumer": { /* ConsumerContext (alias for EffectiveAccessContext) */ },
      "expected": {
        "allowed": true,
        "reason_contains": "..."       // optional substring check on decision.reason
      }
    }
  ]
}
```

### Dimension tags

| Tag | Policy dimension |
|-----|-----------------|
| `sensitivity` | Sensitivity tier ceiling check |
| `allow-list` | `allowed_consumers` include/exclude |
| `groups` | `allowed_entra_groups` Entra group check |
| `roles` | `allowed_entra_roles` Entra role check |
| `purview` | `required_purview_roles` purview role check |
| `dependencies` | `dependency_sensitivity_ceiling` check |
| `identity` | Presence or absence of a validated identity |

---

## Current Cases

| ID | Description | Tags | Expected |
|----|-------------|------|----------|
| CF-001 | Public asset with no constraints is accessible by an anonymous consumer | sensitivity | ✅ allow |
| CF-002 | Highly confidential asset is denied to a consumer with only internal ceiling | sensitivity | ❌ deny |
| CF-003 | Confidential asset is accessible when consumer ceiling exactly matches | sensitivity | ✅ allow |
| CF-004 | Internal asset is accessible when consumer ceiling is above the required tier | sensitivity | ✅ allow |
| CF-005 | Consumer not in the asset allow-list is denied access | allow-list | ❌ deny |
| CF-006 | Consumer explicitly included in the asset allow-list is granted access | allow-list | ✅ allow |
| CF-007 | Any authenticated consumer is allowed when the allow-list contains 'all-employees' | allow-list | ✅ allow |
| CF-008 | Consumer without a required Entra group membership is denied access | groups | ❌ deny |
| CF-009 | Consumer holding a required Entra group membership is granted access | groups | ✅ allow |
| CF-010 | Consumer without a required Entra role is denied access | roles | ❌ deny |
| CF-011 | Consumer holding a required Entra role is granted access | roles | ✅ allow |
| CF-012 | Consumer without a required purview role is denied access | purview | ❌ deny |
| CF-013 | Consumer holding a required purview role is granted access | purview | ✅ allow |
| CF-014 | Consumer with no identity is denied when the asset requires Entra group membership | groups, identity | ❌ deny |
| CF-015 | Asset is denied when a dependency's sensitivity tier exceeds the declared ceiling | dependencies | ❌ deny |

---

## Running the Suite

```bash
# Run conformance suite only
cd api
npx vitest run tests/conformance.test.ts

# Run full test suite (includes conformance)
npm test
```

---

## Adding a New Case

1. **Choose a stable case ID** — assign the next sequential `CF-NNN` identifier. IDs are **never reused or renumbered**; if a case becomes obsolete, add `"obsolete": true` and a note rather than removing it.

2. **Describe the scenario** — write a single-sentence description that names the specific policy dimension and the expected outcome.

3. **Pick dimension tags** — choose from the tag table above (multiple allowed).

4. **Define the asset** — use a minimal `CatalogAsset` with only the governance fields relevant to the case. Asset names must follow the `aria.dev/test/cf-NNN-<slug>` convention so they cannot conflict with real catalog entries.

5. **Define the consumer** — use a minimal `EffectiveAccessContext`. Always include `contract_version: "1.0.0"`. For cases that require an identity, embed a `NormalizedIdentity` with `provider: "entra"` and a synthetic `principal_id` (`00000000-0000-0000-0000-000000000NNN`).

6. **Set the expected outcome** — set `allowed` to `true` or `false`. When `allowed` is `false`, add `reason_contains` with a unique substring of the denial message so that cross-language implementations can verify they produce equivalent explanations.

7. **Update the table** in this document.

8. **Run the suite** and confirm all cases pass:

   ```bash
   cd api && npm test
   ```

---

## Updating Cases When the Policy Contract Changes

When the policy contract version is bumped (see `api/docs/policy-contract.md`), the following steps apply:

### PATCH bump (`1.0.x`)

- Wording of `reason` strings may change. Update `reason_contains` values in any affected cases to match the new text.
- No structural changes to the fixture schema are required.

### MINOR bump (`1.x.0`)

- New optional fields may be added to `EffectiveAccessContext`, `NormalizedIdentity`, or `PolicyDecision`. Existing cases remain valid.
- Add new cases to cover any new policy dimensions introduced.
- Update `policy_contract_version` in `conformance-cases.json` to the new version.

### MAJOR bump (`x.0.0`)

- The fixture schema itself likely needs updating. Increment `fixture_version` in `conformance-cases.json`.
- Review all existing cases — rename or retype any fields that changed.
- Update this document and the case table.
- Coordinate with auth-core maintainers so all language implementations adopt the new fixture format simultaneously.

---

## Diffing Results

Because each case has a stable `id` and a fully self-contained input/output pair, results are trivially diffable:

```bash
# Capture current decisions
cd api
node -e "
  const { checkGovernance } = await import('./src/services/governance.service.js');
  const cases = JSON.parse(require('fs').readFileSync('tests/fixtures/conformance-cases.json', 'utf-8')).cases;
  for (const c of cases) {
    const d = checkGovernance(c.asset, c.consumer);
    console.log(JSON.stringify({ id: c.id, allowed: d.allowed, reason: d.reason ?? null }));
  }
" > /tmp/decisions-before.ndjson

# After a change, diff:
# node -e "..." > /tmp/decisions-after.ndjson
# diff /tmp/decisions-before.ndjson /tmp/decisions-after.ndjson
```

Each line is a JSON object keyed by `id`, so the diff pinpoints exactly which cases changed and how.
