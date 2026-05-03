# Auth Migration & Operations Runbook

> **Audience:** Platform engineers and integrator teams migrating to JWT bearer token authentication.  
> **Covers:** Auth-core parity strategy · Environment variables · Provider configuration · Migration guide · Troubleshooting

---

## Overview

The ARIA Distribution Gateway uses a **two-layer auth model**:

1. **Identity layer** — the `auth` middleware validates a JWT bearer token and normalises the result into a [`NormalizedIdentity`](./policy-contract.md#normalizedidentity).
2. **Governance layer** — the governance service evaluates the derived [`EffectiveAccessContext`](./policy-contract.md#effectiveaccesscontext) against each asset's policy overlay to produce a [`PolicyDecision`](./policy-contract.md#policydecision).

Both layers are governed by the versioned **Auth-Core Policy Contract v1.0.0** (see [`policy-contract.md`](./policy-contract.md)), which is shared between this TypeScript gateway and the companion .NET `auth-core` library.

---

## Architecture: Auth-Core Parity Strategy

The gateway and the .NET `auth-core` library are designed to produce **identical policy decisions** for the same inputs. This is enforced by:

### Shared contract types

All three contract objects — `NormalizedIdentity`, `EffectiveAccessContext`, and `PolicyDecision` — are defined in a **single language-neutral schema** that each implementation must implement faithfully:

| Artifact | Location |
|----------|----------|
| TypeScript source | `api/src/models/policy-contract.ts` |
| JSON Schema | `api/docs/policy-contract.schema.json` |
| Contract documentation | `api/docs/policy-contract.md` |

Each object carries a `contract_version` field (`"1.0.0"`) so that consumers can detect schema mismatches at runtime.

### Cross-language conformance fixtures

The [`conformance-cases.json`](../tests/fixtures/conformance-cases.json) fixture suite (see [`conformance-fixtures.md`](./conformance-fixtures.md)) defines 15 self-contained test cases (CF-001 – CF-015) that any conformant policy engine must pass. The TypeScript test runner is `api/tests/conformance.test.ts`.

```
Policy input (asset + consumer)
        │
        ├─── TypeScript gateway (governance.service.ts)  ──┐
        │                                                   ├──▶ Must produce identical PolicyDecision
        └─── .NET auth-core (PolicyEngine.Evaluate())   ──┘
```

When you add a new policy dimension or modify governance logic, add a corresponding fixture case and run the suite against both implementations before merging.

### Entra-first, optional providers later

The gateway ships with first-class support for **Microsoft Entra ID (Azure AD)** bearer tokens. The `IdentityProvider` type in `policy-contract.ts` is an open union that already includes slugs for Okta, GitHub, AWS Cognito, and Google Workspace. Adding a new IDP requires only:

1. Writing a claim-normalisation adapter (mapping token payload → `NormalizedIdentity`).
2. Deriving `EffectiveAccessContext` from the normalized identity.
3. Adding conformance fixture cases for the new IDP's group/role vocabulary.

See the [Extension Points](./policy-contract.md#extension-points-for-future-idps) section of the policy contract for a step-by-step guide.

---

## Environment Variables

### Auth middleware (`api/`)

| Variable | Default | Description |
|----------|---------|-------------|
| `AUTH_ENFORCE` | `false` | Set to `true` to reject requests with a missing or invalid token with `401`. In the default `false` (observe) mode, token failures are logged but requests are not blocked. |
| `ENTRA_TENANT_ID` | — | Azure AD tenant ID. Automatically builds the issuer URL (`https://login.microsoftonline.com/<tid>/v2.0`) and the JWKS endpoint. **Required** for JWT validation. |
| `ENTRA_AUDIENCE` | — | Expected `aud` claim — the App Registration's Application ID URI or client ID (e.g. `api://my-gateway-app`). **Required** for JWT validation. |
| `LEGACY_HEADERS_MODE` | `enabled` | Set to `disabled` to stop honouring `x-consumer-id` / `x-sensitivity-ceiling` headers. **Deprecated — will be removed 2027-01-01.** |

### Derived URLs (set automatically from `ENTRA_TENANT_ID`)

| URL | Pattern |
|-----|---------|
| Issuer | `https://login.microsoftonline.com/<ENTRA_TENANT_ID>/v2.0` |
| JWKS endpoint | `https://login.microsoftonline.com/<ENTRA_TENANT_ID>/discovery/v2.0/keys` |

You can override either URL by passing `issuer` or `jwksUri` directly to `createAuthMiddleware()` (useful for ADFS, national-cloud deployments, or test stubs).

### Entra token role → sensitivity ceiling mapping

| Entra app role | Sensitivity ceiling granted |
|---------------|---------------------------|
| `aria-gateway-admin` | `highly_confidential` |
| `aria-gateway-confidential` | `confidential` |
| `aria-gateway-internal` | `internal` |
| _(any other authenticated principal)_ | `internal` (default for authenticated users) |
| _(no token / anonymous)_ | `public` |

---

## Provider Configuration

### Step 1 — Create an Entra App Registration

1. In the [Azure Portal](https://portal.azure.com), open **Azure Active Directory → App registrations → New registration**.
2. Name it (e.g. `aria-gateway-api`) and leave the redirect URI blank for a back-end service.
3. Note the **Application (client) ID** and **Directory (tenant) ID**.

### Step 2 — Define application roles

In the App Registration, go to **App roles → Create app role** and add:

| Display name | Value | Allowed member types |
|---|---|---|
| Admin | `aria-gateway-admin` | Applications + Users/groups |
| Confidential | `aria-gateway-confidential` | Applications + Users/groups |
| Internal | `aria-gateway-internal` | Applications + Users/groups |

### Step 3 — Set the Application ID URI

In **Expose an API → Set Application ID URI**, set the URI to `api://<client-id>`.  
This URI becomes your `ENTRA_AUDIENCE` value.

### Step 4 — Configure the gateway

```bash
# Minimum required for JWT validation
ENTRA_TENANT_ID=<directory-tenant-id>
ENTRA_AUDIENCE=api://<client-id>

# Optional: flip to enforce mode once all clients are migrated
AUTH_ENFORCE=false

# Optional: disable legacy header fallback after full migration
LEGACY_HEADERS_MODE=enabled
```

### Step 5 — Assign roles to consumer applications

For each consumer application or managed identity that needs access:

1. In Azure Portal, open your **App Registration → Enterprise application → Users and groups**.
2. Assign the appropriate app role (`aria-gateway-internal`, `aria-gateway-confidential`, or `aria-gateway-admin`).

### Obtaining a token (client-credentials flow)

```bash
curl -X POST \
  "https://login.microsoftonline.com/${ENTRA_TENANT_ID}/oauth2/v2.0/token" \
  -d "grant_type=client_credentials" \
  -d "client_id=${CLIENT_ID}" \
  -d "client_secret=${CLIENT_SECRET}" \
  -d "scope=api://${ENTRA_AUDIENCE}/.default"
```

The response includes `access_token`. Pass it in the `Authorization` header:

```bash
curl https://your-gateway-host/catalog/assets \
  -H "Authorization: Bearer ${access_token}"
```

---

## Migration Guide: Headers → Bearer Token Auth

> **Background:** The gateway previously relied on `x-consumer-id` and `x-sensitivity-ceiling` request headers to identify callers. This mechanism is deprecated and will be removed on **2027-01-01**. Follow the steps below to migrate before that date.

### Before: Legacy header-based auth

```http
GET /catalog/assets HTTP/1.1
X-Consumer-Id: hr-team
X-Sensitivity-Ceiling: internal
```

The gateway accepted these headers at face value — there was no cryptographic proof of identity.

### After: JWT bearer token auth

```http
GET /catalog/assets HTTP/1.1
Authorization: Bearer <entra_jwt>
```

The gateway validates the JWT signature against Entra's JWKS endpoint, verifies the issuer and audience claims, and derives the caller's identity and sensitivity ceiling from the token's `roles` claim.

### Migration steps

#### 1. Register your consumer application in Entra

Follow **Steps 1–5** in the [Provider Configuration](#provider-configuration) section above.

#### 2. Switch clients to send a bearer token

Replace any code or configuration that sets `X-Consumer-Id` / `X-Sensitivity-Ceiling` with logic that obtains and forwards an Entra bearer token.

**Before (Python example):**

```python
headers = {
    "X-Consumer-Id": "hr-team",
    "X-Sensitivity-Ceiling": "internal",
}
response = requests.get("https://gateway/catalog/assets", headers=headers)
```

**After:**

```python
import msal

app = msal.ConfidentialClientApplication(
    client_id=CLIENT_ID,
    client_credential=CLIENT_SECRET,
    authority=f"https://login.microsoftonline.com/{TENANT_ID}",
)
result = app.acquire_token_for_client(scopes=[f"api://{ENTRA_AUDIENCE}/.default"])
token = result["access_token"]

headers = {"Authorization": f"Bearer {token}"}
response = requests.get("https://gateway/catalog/assets", headers=headers)
```

**Before (.NET example):**

```csharp
client.DefaultRequestHeaders.Add("X-Consumer-Id", "hr-team");
client.DefaultRequestHeaders.Add("X-Sensitivity-Ceiling", "internal");
```

**After:**

```csharp
var credential = new ClientSecretCredential(tenantId, clientId, clientSecret);
var token = await credential.GetTokenAsync(
    new TokenRequestContext([$"api://{entraAudience}/.default"]));
client.DefaultRequestHeaders.Authorization =
    new AuthenticationHeaderValue("Bearer", token.Token);
```

#### 3. Monitor migration progress

While `AUTH_ENFORCE=false` (default), failed and missing tokens are logged but not blocked.  
Use `GET /metrics` to track how many requests are still using legacy headers:

```bash
curl https://your-gateway-host/metrics
```

Look for:

```json
{
  "counters": {
    "auth.legacy_header_used": 128,      // still on headers — must reach 0
    "auth.failure.observe.token_missing": 42,  // no token at all
    "auth.failure.observe.token_invalid": 7    // token present but invalid
  }
}
```

See [`rollout-observability.md`](./rollout-observability.md) for full log query examples (CloudWatch, Datadog, Loki).

#### 4. Disable legacy headers

Once `auth.legacy_header_used` has been zero for at least 7 consecutive days:

```bash
LEGACY_HEADERS_MODE=disabled
```

This causes any remaining header-only requests to receive a `public`-only access context (not a 401), ensuring existing unauthenticated flows are not immediately broken.

#### 5. Enable enforcement

Once `auth.failure.observe.token_missing` and `auth.failure.observe.token_invalid` have also been zero for 7 consecutive days:

```bash
AUTH_ENFORCE=true
LEGACY_HEADERS_MODE=disabled
```

From this point, any request without a valid bearer token receives `401 Unauthorized`.

---

## Troubleshooting

### 401 Unauthorized

#### `"Missing or malformed Authorization header."`

**Cause:** `AUTH_ENFORCE=true` and the request has no `Authorization: Bearer …` header.

**Fix:**
- Confirm the client is setting the `Authorization` header correctly.
- Check that `AUTH_ENFORCE` is intentionally `true`. If you are still in migration, set it to `false`.
- In observe mode (`AUTH_ENFORCE=false`), missing tokens do not produce 401s — check whether `AUTH_ENFORCE` was accidentally set.

#### `"Auth enforcement is enabled but no JWKS URI is configured."`

**Cause:** `AUTH_ENFORCE=true` but `ENTRA_TENANT_ID` is not set (and no custom `jwksUri` override was provided).

**Fix:** Set `ENTRA_TENANT_ID` in your deployment environment, or pass `jwksUri` directly to `createAuthMiddleware()`.

#### `"JWTExpired"` / `"jwt expired"`

**Cause:** The bearer token has passed its `exp` claim. Entra tokens typically expire after 1 hour.

**Fix:**
- Ensure your client re-acquires a token before the current one expires (proactive refresh).
- Use MSAL's `acquireTokenSilent` or an equivalent SDK method that handles token refresh automatically.
- Check the system clock on the client — clock skew of more than a few minutes will cause premature expiry failures.

#### `"JWTClaimValidationFailed: unexpected 'iss' claim value"`

**Cause:** The token was issued for a different tenant, or the `ENTRA_TENANT_ID` env var does not match the tenant that issued the token.

**Fix:**
- Confirm `ENTRA_TENANT_ID` matches the tenant used to register the application.
- For multi-tenant apps, override `issuer` to `undefined` (skip issuer check) or use the generic `https://login.microsoftonline.com/common/v2.0` issuer — but be aware this weakens tenant isolation.

#### `"JWTClaimValidationFailed: unexpected 'aud' claim value"`

**Cause:** The token's `aud` claim does not match `ENTRA_AUDIENCE`.

**Fix:**
- Confirm `ENTRA_AUDIENCE` matches the **Application ID URI** (e.g. `api://<client-id>`) set in the App Registration.
- When acquiring the token, use `scope=api://<client-id>/.default`. If you used `https://graph.microsoft.com/.default` the token is scoped to Microsoft Graph, not your gateway.

#### `"Unable to resolve signing keys"` / JWKS fetch failures

**Cause:** The gateway cannot reach the Entra JWKS endpoint — typically a network/firewall issue in a private deployment.

**Fix:**
- Confirm the gateway host can reach `https://login.microsoftonline.com`.
- For air-gapped environments, mirror the JWKS document and use the `jwksUri` override option in `createAuthMiddleware()`.
- Check that `ENTRA_TENANT_ID` is a valid GUID (not a domain alias) — the derived JWKS URL uses the GUID form.

---

### 403 Forbidden

#### `"This asset is classified as '…' but your access level only permits '…'"`

**Cause:** The consumer's sensitivity ceiling is below the asset's tier.

**Fix:**
- Assign a higher app role to the consumer's service principal in Entra (`aria-gateway-confidential` or `aria-gateway-admin`).
- Verify the role assignment is reflected in the token's `roles` claim by decoding the JWT at [jwt.ms](https://jwt.ms).
- If the token is correct but the ceiling is still too low, confirm no cached token is in use (force token re-acquisition).

**Role → ceiling reference:**

| Role in token | Ceiling |
|---|---|
| `aria-gateway-admin` | `highly_confidential` |
| `aria-gateway-confidential` | `confidential` |
| `aria-gateway-internal` | `internal` |
| _(no matching role)_ | `internal` (default for authenticated users) |

#### `"Consumer '…' is not in the allow-list for this asset"`

**Cause:** The asset's `allowed_consumers` governance overlay does not include the caller's `consumer_id`.

**Fix:**
- The `consumer_id` is derived from the token's `oid` claim (object ID of the service principal).
- Ask the asset owner to add your service principal's OID (or a team slug that includes it) to the asset's `allowed_consumers` list.
- Use `POST /catalog/assets/{name}/{version}/request-access` to submit a formal access request.

#### `"Consumer does not have the required Entra group membership"`

**Cause:** The asset's `allowed_entra_groups` overlay requires membership in a specific AAD group, but the token's `groups` claim does not contain it.

**Fix:**
- Add the service principal (or the user) to the required AAD group in Azure Portal.
- Entra tokens include `groups` only when the **group claims** optional claim is configured on the App Registration — verify this under **Token configuration → Optional claims → Access token → groups**.
- If the group list is too long for the token (>200 groups), Entra replaces it with a `hasgroups: true` claim. In that case, use the Microsoft Graph API to check group membership server-side, or use **app roles** instead of group claims.

#### `"Consumer does not have the required Entra role"`

**Cause:** The asset's `allowed_entra_roles` overlay requires a specific app role, but the token's `roles` claim does not contain it.

**Fix:**
- Assign the required app role to the service principal in Entra: **App Registration → Enterprise application → Users and groups → Add assignment**.
- App role assignments take effect in the next token issued — existing tokens are not updated.

#### `"Consumer does not have the required purview role"`

**Cause:** The asset's governance overlay requires a `purview_roles` entry (e.g. `purview:export-approver`) that the consumer does not hold.

**Fix:** Contact the asset owner to determine whether the purview role can be granted, or submit an access request via the `request-access` endpoint.

---

## Quick-Reference Checklist

Use this checklist when deploying the gateway or onboarding a new consumer team.

### Gateway deployment checklist

- [ ] `ENTRA_TENANT_ID` set to the correct Azure AD tenant GUID.
- [ ] `ENTRA_AUDIENCE` set to the App Registration's Application ID URI (`api://<client-id>`).
- [ ] App roles (`aria-gateway-admin`, `aria-gateway-confidential`, `aria-gateway-internal`) created on the App Registration.
- [ ] Gateway is deployed in **observe mode** (`AUTH_ENFORCE=false`) initially.
- [ ] `GET /metrics` returns non-error response and counters are visible.

### Consumer team onboarding checklist

- [ ] Service principal / managed identity created (or reused) in Entra.
- [ ] Appropriate app role assigned (`aria-gateway-internal` as minimum).
- [ ] Client updated to acquire and forward a bearer token (`Authorization: Bearer …`).
- [ ] Token validated locally with [jwt.ms](https://jwt.ms) — `aud`, `iss`, and `roles` claims correct.
- [ ] Legacy headers (`X-Consumer-Id`, `X-Sensitivity-Ceiling`) removed from client requests.

### Cutover to enforce mode checklist

- [ ] `auth.failure.observe.token_missing` = 0 for 7 consecutive days.
- [ ] `auth.failure.observe.token_invalid` = 0 for 7 consecutive days.
- [ ] `auth.legacy_header_used` = 0 for 7 consecutive days.
- [ ] `LEGACY_HEADERS_MODE=disabled` deployed and stable.
- [ ] Rollback plan documented (instant revert to `AUTH_ENFORCE=false` via env-var change).
- [ ] `AUTH_ENFORCE=true` deployed.

---

## Related Documents

| Document | Description |
|----------|-------------|
| [`policy-contract.md`](./policy-contract.md) | Auth-Core Policy Contract v1.0.0 — `NormalizedIdentity`, `EffectiveAccessContext`, `PolicyDecision` types, versioning, and IDP extension points |
| [`conformance-fixtures.md`](./conformance-fixtures.md) | Cross-language policy conformance fixture suite (CF-001 – CF-015) |
| [`rollout-observability.md`](./rollout-observability.md) | Structured log events, in-process counters, CloudWatch/Datadog/Loki query examples, rollout procedure |
| `api/src/models/policy-contract.ts` | TypeScript source of all contract types |
| `api/src/middleware/auth.middleware.ts` | JWT validation middleware (Entra-first) |
| `api/src/services/governance.service.ts` | Governance policy evaluation engine |
| `api/tests/fixtures/conformance-cases.json` | Conformance fixture JSON (CF-001 – CF-015) |
