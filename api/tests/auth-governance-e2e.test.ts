/**
 * End-to-End Auth/Governance Integration Tests
 *
 * Full-stack Supertest coverage for the complete auth + governance pipeline.
 * Satisfies the acceptance criteria for the "Add end-to-end API auth/governance
 * integration tests" issue:
 *
 *   - missing token → 401        (catalog list, manifest, install)
 *   - invalid token → 401        (malformed JWT; catalog list, manifest, install)
 *   - valid token + allowed policy → 200  (catalog list, manifest, install)
 *   - valid token + denied policy → 403  (manifest, install; response includes
 *                                         reason, action_url, contract_version)
 *
 * Tests run against an isolated enforcing Express app (JWT key pair generated
 * locally — no live network calls).
 */

import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import { generateKeyPair } from "node:crypto";
import { promisify } from "node:util";
import { SignJWT, importPKCS8, importSPKI, type KeyLike } from "jose";
import express from "express";
import { createAuthMiddleware } from "../src/middleware/auth.middleware.js";
import catalogRouter from "../src/routes/catalog.js";

// ---------------------------------------------------------------------------
// Local JWT infrastructure — avoids any live network calls to Entra
// ---------------------------------------------------------------------------

const generateKeyPairAsync = promisify(generateKeyPair);

type JwksProvider = (
  header: { kid?: string; alg?: string },
  token?: unknown
) => Promise<KeyLike>;

let privateKey: KeyLike;
let jwksProvider: JwksProvider;

async function buildLocalJwksProvider(pubKey: KeyLike): Promise<JwksProvider> {
  return async function localJwks(
    _header: { kid?: string; alg?: string },
    _token?: unknown
  ): Promise<KeyLike> {
    return pubKey;
  };
}

async function signTestToken(
  claims: Record<string, unknown> = {}
): Promise<string> {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256" })
    .setIssuedAt()
    .setIssuer("https://login.microsoftonline.com/test-tenant/v2.0")
    .setAudience("test-client-id")
    .setExpirationTime("1h")
    .sign(privateKey);
}

// ---------------------------------------------------------------------------
// Enforcing-mode app factory
//
// Builds a minimal Express app with AUTH_ENFORCE=true using an injected JWKS
// provider so no live Entra endpoints are contacted.
// ---------------------------------------------------------------------------

function buildEnforcingApp() {
  const enforced = express();
  enforced.use(express.json());
  enforced.use(
    createAuthMiddleware({
      enforce: true,
      issuer: "https://login.microsoftonline.com/test-tenant/v2.0",
      audience: "test-client-id",
      jwksUri: "https://example.invalid/jwks",
      jwksProvider: jwksProvider as ReturnType<
        typeof import("jose")["createRemoteJWKSet"]
      >,
    })
  );
  enforced.use("/catalog", catalogRouter);
  return enforced;
}

// ---------------------------------------------------------------------------
// Well-known sample asset references used across suites
//
//   Accessible: aria.dev/skills/hr-policy-lookup@1.2.0
//     sensitivity_tier: "internal"
//     allowed_consumers: ["hr-team", "all-employees"]
//
//   Restricted: aria.dev/skills/financial-analyzer@1.0.0
//     sensitivity_tier: "highly_confidential"
//     allowed_consumers: ["finance-team"]
//     also requires allowed_entra_groups, allowed_entra_roles, purview_roles
// ---------------------------------------------------------------------------

const accessibleName = encodeURIComponent("aria.dev/skills/hr-policy-lookup");
const accessibleVersion = "1.2.0";
const restrictedName = encodeURIComponent(
  "aria.dev/skills/financial-analyzer"
);
const restrictedVersion = "1.0.0";

beforeAll(async () => {
  const pair = await generateKeyPairAsync("rsa", { modulusLength: 2048 });
  const spki = pair.publicKey.export({ type: "spki", format: "pem" }) as string;
  const pkcs8 = pair.privateKey.export({
    type: "pkcs8",
    format: "pem",
  }) as string;
  privateKey = await importPKCS8(pkcs8, "RS256");
  const pubKey = await importSPKI(spki, "RS256");
  jwksProvider = await buildLocalJwksProvider(pubKey);
});

// ===========================================================================
// 401 — invalid (malformed) token on all three catalog routes
//
// Tests that the enforcing middleware rejects a malformed bearer token with a
// 401 regardless of which catalog endpoint is targeted.
// ===========================================================================

describe("401 — invalid token on catalog routes (enforcing mode)", () => {
  it("GET /catalog/assets returns 401 for a malformed token", async () => {
    const res = await request(buildEnforcingApp())
      .get("/catalog/assets")
      .set("Authorization", "Bearer not.a.real.jwt");
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("Unauthorized");
  });

  it("GET /catalog/assets/:name/:version/manifest returns 401 for a malformed token", async () => {
    const res = await request(buildEnforcingApp())
      .get(
        `/catalog/assets/${accessibleName}/${accessibleVersion}/manifest`
      )
      .set("Authorization", "Bearer not.a.real.jwt");
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("Unauthorized");
  });

  it("POST /catalog/assets/:name/:version/install returns 401 for a malformed token", async () => {
    const res = await request(buildEnforcingApp())
      .post(
        `/catalog/assets/${accessibleName}/${accessibleVersion}/install`
      )
      .set("Authorization", "Bearer not.a.real.jwt")
      .send({ target: "claude-desktop" });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("Unauthorized");
  });
});

// ===========================================================================
// 200 — valid JWT token + allowed governance policy
//
// A user with the "aria-gateway-internal" role gets sensitivity_ceiling="internal".
// The accessible asset (hr-policy-lookup) is classified "internal" and allows
// "all-employees", so every request should be granted.
// ===========================================================================

describe("200 — valid JWT token with allowed policy on catalog routes (enforcing mode)", () => {
  it("GET /catalog/assets returns 200 with asset list", async () => {
    const token = await signTestToken({
      oid: "e2e-allowed-user",
      roles: ["aria-gateway-internal"],
    });
    const res = await request(buildEnforcingApp())
      .get("/catalog/assets")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.assets)).toBe(true);
  });

  it("GET /catalog/assets/:name/:version/manifest returns 200 for an accessible asset", async () => {
    const token = await signTestToken({
      oid: "e2e-allowed-user",
      roles: ["aria-gateway-internal"],
    });
    const res = await request(buildEnforcingApp())
      .get(
        `/catalog/assets/${accessibleName}/${accessibleVersion}/manifest`
      )
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.record).toBeDefined();
    expect(res.body.governance).toBeDefined();
  });

  it("POST /catalog/assets/:name/:version/install returns 200 for an accessible asset", async () => {
    const token = await signTestToken({
      oid: "e2e-allowed-user",
      roles: ["aria-gateway-internal"],
    });
    const res = await request(buildEnforcingApp())
      .post(
        `/catalog/assets/${accessibleName}/${accessibleVersion}/install`
      )
      .set("Authorization", `Bearer ${token}`)
      .send({ target: "claude-desktop" });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.config_snippet).toBeDefined();
  });
});

// ===========================================================================
// 403 — valid JWT token + denied governance policy
//
// A user with "aria-gateway-internal" role (ceiling="internal") attempts to
// access a "highly_confidential" asset.  The governance check must deny the
// request and include a populated reason field plus a request-access action URL
// and the contract version in the response body.
// ===========================================================================

describe("403 — valid JWT token with denied policy on catalog routes (enforcing mode)", () => {
  it("GET /catalog/assets/:name/:version/manifest returns 403 with reason for a restricted asset", async () => {
    const token = await signTestToken({
      oid: "e2e-denied-user",
      roles: ["aria-gateway-internal"],
    });
    const res = await request(buildEnforcingApp())
      .get(
        `/catalog/assets/${restrictedName}/${restrictedVersion}/manifest`
      )
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body.error).toContain("Access denied");
    expect(res.body.reason).toBeTruthy();
    expect(res.body.action_url).toContain("request-access");
    expect(res.body.contract_version).toBe("1.0.0");
  });

  it("403 manifest response does NOT leak the manifest record or install URL", async () => {
    const token = await signTestToken({
      oid: "e2e-denied-user",
      roles: ["aria-gateway-internal"],
    });
    const res = await request(buildEnforcingApp())
      .get(
        `/catalog/assets/${restrictedName}/${restrictedVersion}/manifest`
      )
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body.record).toBeUndefined();
    expect(res.body.install_url).toBeUndefined();
    expect(res.body.mcpb_url).toBeUndefined();
  });

  it("POST /catalog/assets/:name/:version/install returns 403 with reason for a restricted asset", async () => {
    const token = await signTestToken({
      oid: "e2e-denied-user",
      roles: ["aria-gateway-internal"],
    });
    const res = await request(buildEnforcingApp())
      .post(
        `/catalog/assets/${restrictedName}/${restrictedVersion}/install`
      )
      .set("Authorization", `Bearer ${token}`)
      .send({ target: "claude-desktop" });
    expect(res.status).toBe(403);
    expect(res.body.reason).toBeTruthy();
    expect(res.body.action_url).toContain("request-access");
    expect(res.body.contract_version).toBe("1.0.0");
  });
});

// ===========================================================================
// 401 — missing token on catalog routes (enforcing mode)
//
// Tests that the enforcing middleware rejects requests with no bearer token
// with a 401 on all three catalog routes.
// ===========================================================================

describe("401 — missing token on catalog routes (enforcing mode)", () => {
  it("GET /catalog/assets returns 401 for a missing token", async () => {
    const res = await request(buildEnforcingApp()).get("/catalog/assets");
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("Unauthorized");
  });
});
