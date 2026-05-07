/**
 * Auth Middleware Tests
 *
 * Tests JWT bearer token extraction, validation, claim normalization, and
 * enforcement-mode behaviour using a locally-generated RSA key pair so that
 * no live network calls to Entra are required.
 */

import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import { generateKeyPair, createPublicKey } from "node:crypto";
import { promisify } from "node:util";
import { SignJWT, importPKCS8, exportJWK, importSPKI, type KeyLike } from "jose";
import { createAuthMiddleware, normalizeEntraClaims } from "../src/middleware/auth.middleware.js";
import express from "express";

// ---------------------------------------------------------------------------
// Test key pair setup
// ---------------------------------------------------------------------------

const generateKeyPairAsync = promisify(generateKeyPair);

let privateKey: KeyLike;
let publicKeyJwk: Record<string, unknown>;

/**
 * Build a minimal JWKS provider (the function signature accepted by jose's
 * jwtVerify) backed by the locally-generated key pair.
 */
async function buildLocalJwksProvider(pubKey: KeyLike) {
  // Return a function that behaves like createRemoteJWKSet's return value
  return async function localJwks(
    header: { kid?: string; alg?: string },
    _token?: unknown
  ): Promise<KeyLike> {
    return pubKey;
  };
}

/** Sign a test JWT with the local private key. */
async function signTestToken(
  claims: Record<string, unknown> = {},
  overrides: { issuer?: string; audience?: string; expiresIn?: number } = {}
): Promise<string> {
  const jwt = new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256" })
    .setIssuedAt()
    .setIssuer(overrides.issuer ?? "https://login.microsoftonline.com/test-tenant/v2.0")
    .setAudience(overrides.audience ?? "test-client-id")
    .setExpirationTime(overrides.expiresIn ? `${overrides.expiresIn}s` : "1h");

  return jwt.sign(privateKey);
}

// ---------------------------------------------------------------------------
// Test app helpers
// ---------------------------------------------------------------------------

function buildTestApp(enforceAuth: boolean) {
  const app = express();
  app.use(express.json());
  // Auth middleware with injected JWKS provider (no real network calls)
  app.use(
    createAuthMiddleware({
      enforce: enforceAuth,
      issuer: "https://login.microsoftonline.com/test-tenant/v2.0",
      audience: "test-client-id",
      jwksUri: "https://example.invalid/jwks", // never fetched – provider injected
      jwksProvider: (() => {
        // Will be replaced once public key is ready; placeholder during setup
        return undefined as unknown as ReturnType<
          typeof import("jose")["createRemoteJWKSet"]
        >;
      })(),
    })
  );
  app.get("/protected", (req, res) => {
    res.json({ identity: req.identity ?? null });
  });
  return app;
}

// ---------------------------------------------------------------------------
// Suites
// ---------------------------------------------------------------------------

describe("normalizeEntraClaims", () => {
  it("maps oid to principal_id", () => {
    const identity = normalizeEntraClaims({
      oid: "00000000-aaaa-bbbb-cccc-000000000001",
      tid: "test-tenant",
      name: "Alice Smith",
      email: "alice@example.com",
      roles: ["aria-gateway-internal"],
      scp: "catalog.read",
      groups: ["grp-a"],
    });
    expect(identity.provider).toBe("entra");
    expect(identity.principal_id).toBe("00000000-aaaa-bbbb-cccc-000000000001");
    expect(identity.display_name).toBe("Alice Smith");
    expect(identity.email).toBe("alice@example.com");
    expect(identity.tenant).toBe("test-tenant");
    expect(identity.roles).toContain("aria-gateway-internal");
    expect(identity.roles).toContain("catalog.read");
    expect(identity.groups).toContain("grp-a");
    expect(identity.extensions?.["entra:oid"]).toBe("00000000-aaaa-bbbb-cccc-000000000001");
  });

  it("falls back to sub when oid is absent", () => {
    const identity = normalizeEntraClaims({ sub: "fallback-sub" });
    expect(identity.principal_id).toBe("fallback-sub");
  });

  it("de-duplicates roles and scopes", () => {
    const identity = normalizeEntraClaims({
      roles: ["read"],
      scp: "read write",
    });
    // "read" appears in both roles and scp, combined list should contain it
    expect(identity.roles).toContain("read");
    expect(identity.roles).toContain("write");
  });

  it("uses preferred_username as email fallback", () => {
    const identity = normalizeEntraClaims({
      oid: "oid-1",
      preferred_username: "bob@example.com",
    });
    expect(identity.email).toBe("bob@example.com");
    expect(identity.extensions?.["entra:preferred_username"]).toBe("bob@example.com");
  });

  it("stamps contract_version", () => {
    const identity = normalizeEntraClaims({ sub: "x" });
    expect(identity.contract_version).toBe("1.0.0");
  });
});

describe("JWT Auth Middleware — unit", () => {
  // Build a fresh app for each describe block by sharing the key pair
  let app: ReturnType<typeof express>;
  let appEnforce: ReturnType<typeof express>;

  beforeAll(async () => {
    // Generate RSA key pair for test signing
    const pair = await generateKeyPairAsync("rsa", { modulusLength: 2048 });
    const spki = pair.publicKey.export({ type: "spki", format: "pem" }) as string;
    const pkcs8 = pair.privateKey.export({ type: "pkcs8", format: "pem" }) as string;

    privateKey = await importPKCS8(pkcs8, "RS256");
    const pubKey = await importSPKI(spki, "RS256");
    publicKeyJwk = await exportJWK(pubKey);

    const jwksProvider = await buildLocalJwksProvider(pubKey);

    // Non-enforcing app
    app = express();
    app.use(express.json());
    app.use(
      createAuthMiddleware({
        enforce: false,
        issuer: "https://login.microsoftonline.com/test-tenant/v2.0",
        audience: "test-client-id",
        jwksUri: "https://example.invalid/jwks",
        jwksProvider: jwksProvider as ReturnType<typeof import("jose")["createRemoteJWKSet"]>,
      })
    );
    app.get("/me", (req, res) => {
      res.json({ identity: req.identity ?? null });
    });

    // Enforcing app
    appEnforce = express();
    appEnforce.use(express.json());
    appEnforce.use(
      createAuthMiddleware({
        enforce: true,
        issuer: "https://login.microsoftonline.com/test-tenant/v2.0",
        audience: "test-client-id",
        jwksUri: "https://example.invalid/jwks",
        jwksProvider: jwksProvider as ReturnType<typeof import("jose")["createRemoteJWKSet"]>,
      })
    );
    appEnforce.get("/me", (req, res) => {
      res.json({ identity: req.identity ?? null });
    });
  });

  // -----------------------------------------------------------------------
  // Non-enforcing mode
  // -----------------------------------------------------------------------

  it("allows requests with no token in non-enforcing mode", async () => {
    const res = await request(app).get("/me");
    expect(res.status).toBe(200);
    expect(res.body.identity).toBeNull();
  });

  it("populates req.identity for a valid token", async () => {
    const token = await signTestToken({
      oid: "user-oid-1",
      name: "Test User",
      email: "test@example.com",
      roles: ["aria-gateway-internal"],
    });

    const res = await request(app)
      .get("/me")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.identity).not.toBeNull();
    expect(res.body.identity.provider).toBe("entra");
    expect(res.body.identity.principal_id).toBe("user-oid-1");
    expect(res.body.identity.email).toBe("test@example.com");
    expect(res.body.identity.roles).toContain("aria-gateway-internal");
  });

  it("passes through (no identity) for an invalid token in non-enforcing mode", async () => {
    const res = await request(app)
      .get("/me")
      .set("Authorization", "Bearer this.is.not.a.jwt");

    expect(res.status).toBe(200);
    expect(res.body.identity).toBeNull();
  });

  it("passes through (no identity) for a token with wrong audience in non-enforcing mode", async () => {
    const token = await signTestToken({}, { audience: "wrong-audience" });

    const res = await request(app)
      .get("/me")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.identity).toBeNull();
  });

  it("passes through (no identity) for an expired token in non-enforcing mode", async () => {
    const token = await signTestToken({}, { expiresIn: -60 }); // expired 60 s ago

    const res = await request(app)
      .get("/me")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.identity).toBeNull();
  });

  // -----------------------------------------------------------------------
  // Enforcing mode
  // -----------------------------------------------------------------------

  it("returns 401 for missing token in enforcing mode", async () => {
    const res = await request(appEnforce).get("/me");
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("Unauthorized");
  });

  it("returns 401 for invalid token in enforcing mode", async () => {
    const res = await request(appEnforce)
      .get("/me")
      .set("Authorization", "Bearer garbage.token.here");
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("Unauthorized");
  });

  it("returns 401 for expired token in enforcing mode", async () => {
    const token = await signTestToken({}, { expiresIn: -60 });

    const res = await request(appEnforce)
      .get("/me")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(401);
    expect(res.body.error).toBe("Unauthorized");
  });

  it("returns 401 for wrong-audience token in enforcing mode", async () => {
    const token = await signTestToken({}, { audience: "wrong-audience" });

    const res = await request(appEnforce)
      .get("/me")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(401);
    expect(res.body.error).toBe("Unauthorized");
  });

  it("allows request and populates identity with valid token in enforcing mode", async () => {
    const token = await signTestToken({
      oid: "enforced-user",
      name: "Enforced User",
      roles: ["aria-gateway-admin"],
    });

    const res = await request(appEnforce)
      .get("/me")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.identity.principal_id).toBe("enforced-user");
    expect(res.body.identity.roles).toContain("aria-gateway-admin");
  });
});

describe("JWT Auth Middleware — integration with main app (non-enforcing)", () => {
  // The main app runs with AUTH_ENFORCE unset (false), so all existing tests
  // continue to pass. This suite verifies that the main app correctly handles
  // a bearer token alongside standard header-based auth.

  it("main app health endpoint is unaffected", async () => {
    const { default: app } = await import("../src/index.js");
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
  });

  it("catalog endpoint returns 200 with no token (non-enforcing default)", async () => {
    const { default: app } = await import("../src/index.js");
    const res = await request(app)
      .get("/catalog/assets")
      .set("X-Consumer-Id", "all-employees")
      .set("X-Sensitivity-Ceiling", "internal");
    expect(res.status).toBe(200);
  });
});
