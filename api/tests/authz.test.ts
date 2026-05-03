/**
 * Unified Auth/Authz Enforcement Tests
 *
 * Verifies consistent 401 (auth failure) and 403 (policy denied) behavior
 * across catalog and MCP routes, satisfying the acceptance criteria for the
 * "Enforce unified authz behavior across catalog and MCP routes" issue:
 *
 *   - Auth middleware enforcement on catalog and MCP endpoints
 *   - Governance checks applied unconditionally (no unintentional bypasses)
 *   - Deny responses include actionable reason payload (reason, action_url,
 *     approval_chain, contract_version)
 */

import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import { generateKeyPair } from "node:crypto";
import { promisify } from "node:util";
import { SignJWT, importPKCS8, importSPKI, type KeyLike } from "jose";
import express from "express";
import { createAuthMiddleware } from "../src/middleware/auth.middleware.js";
import catalogRouter from "../src/routes/catalog.js";
import mcpRouter from "../src/routes/mcp.js";
import app from "../src/index.js";

// ---------------------------------------------------------------------------
// Test JWT infrastructure (local key pair — no live network calls)
// ---------------------------------------------------------------------------

const generateKeyPairAsync = promisify(generateKeyPair);

/** Explicit type for an injected JWKS provider (compatible with jose's `jwtVerify`). */
type JwksProvider = (header: { kid?: string; alg?: string }, token?: unknown) => Promise<KeyLike>;

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

async function signTestToken(claims: Record<string, unknown> = {}): Promise<string> {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256" })
    .setIssuedAt()
    .setIssuer("https://login.microsoftonline.com/test-tenant/v2.0")
    .setAudience("test-client-id")
    .setExpirationTime("1h")
    .sign(privateKey);
}

// ---------------------------------------------------------------------------
// Enforcing app factory
//
// Builds a minimal Express app with AUTH_ENFORCE=true using an injected JWKS
// provider so no real tokens are required for the 401 path tests.
// The catalog and MCP routers are shared singletons — safe to reuse.
// ---------------------------------------------------------------------------

function buildEnforcingApp() {
  const enforced = express();
  enforced.use(express.json());
  enforced.use(
    createAuthMiddleware({
      enforce: true,
      issuer: "https://login.microsoftonline.com/test-tenant/v2.0",
      audience: "test-client-id",
      jwksUri: "https://example.invalid/jwks", // never fetched — provider injected
      jwksProvider: jwksProvider as ReturnType<typeof import("jose")["createRemoteJWKSet"]>,
    })
  );
  enforced.use("/catalog", catalogRouter);
  enforced.use("/mcp", mcpRouter);
  return enforced;
}

beforeAll(async () => {
  const pair = await generateKeyPairAsync("rsa", { modulusLength: 2048 });
  const spki = pair.publicKey.export({ type: "spki", format: "pem" }) as string;
  const pkcs8 = pair.privateKey.export({ type: "pkcs8", format: "pem" }) as string;
  privateKey = await importPKCS8(pkcs8, "RS256");
  const pubKey = await importSPKI(spki, "RS256");
  jwksProvider = await buildLocalJwksProvider(pubKey);
});

// ===========================================================================
// 401 — Auth enforcement on catalog routes
// ===========================================================================

describe("401 auth enforcement — catalog routes", () => {
  it("GET /catalog/assets returns 401 when no token and enforce=true", async () => {
    const res = await request(buildEnforcingApp()).get("/catalog/assets");
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("Unauthorized");
  });

  it("GET /catalog/assets/:name/:version/manifest returns 401 when no token and enforce=true", async () => {
    const name = encodeURIComponent("aria.dev/skills/hr-policy-lookup");
    const res = await request(buildEnforcingApp()).get(
      `/catalog/assets/${name}/1.2.0/manifest`
    );
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("Unauthorized");
  });

  it("POST /catalog/assets/:name/:version/install returns 401 when no token and enforce=true", async () => {
    const name = encodeURIComponent("aria.dev/skills/hr-policy-lookup");
    const res = await request(buildEnforcingApp())
      .post(`/catalog/assets/${name}/1.2.0/install`)
      .send({ target: "claude-desktop" });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("Unauthorized");
  });

  it("GET /catalog/assets/:name/:version/mcpb returns 401 when no token and enforce=true", async () => {
    const name = encodeURIComponent("aria.dev/skills/hr-policy-lookup");
    const res = await request(buildEnforcingApp()).get(
      `/catalog/assets/${name}/1.2.0/mcpb`
    );
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("Unauthorized");
  });

  it("returns 200 on catalog assets when a valid token is provided in enforce mode", async () => {
    const token = await signTestToken({
      oid: "test-user",
      roles: ["aria-gateway-internal"],
    });
    const res = await request(buildEnforcingApp())
      .get("/catalog/assets")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.assets)).toBe(true);
  });
});

// ===========================================================================
// 401 — Auth enforcement on MCP routes
// ===========================================================================

describe("401 auth enforcement — MCP routes", () => {
  it("POST /mcp initialize returns 401 when no token and enforce=true", async () => {
    const res = await request(buildEnforcingApp())
      .post("/mcp")
      .send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("Unauthorized");
  });

  it("POST /mcp tools/list returns 401 when no token and enforce=true", async () => {
    const res = await request(buildEnforcingApp())
      .post("/mcp")
      .send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("Unauthorized");
  });

  it("POST /mcp tools/call returns 401 when no token and enforce=true", async () => {
    const res = await request(buildEnforcingApp())
      .post("/mcp")
      .send({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "search_assets", arguments: { keyword: "hr" } },
      });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("Unauthorized");
  });

  it("returns 200 on MCP initialize when a valid token is provided in enforce mode", async () => {
    const token = await signTestToken({
      oid: "mcp-user",
      roles: ["aria-gateway-internal"],
    });
    const res = await request(buildEnforcingApp())
      .post("/mcp")
      .set("Authorization", `Bearer ${token}`)
      .send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    expect(res.status).toBe(200);
    expect(res.body.result.protocolVersion).toBeDefined();
  });
});

// ===========================================================================
// 403 — Governance denial with action-guidance payload
//
// Uses the default non-enforcing app (legacy header auth) to isolate
// governance failures from authentication failures.
// ===========================================================================

describe("403 governance denial — catalog routes include action-guidance payload", () => {
  const restrictedName = encodeURIComponent("aria.dev/skills/financial-analyzer");
  const restrictedVersion = "1.0.0";
  const lowCeilingHeaders = {
    "X-Consumer-Id": "all-employees",
    "X-Sensitivity-Ceiling": "internal",
  };

  it("manifest route: 403 includes reason, action_url, approval_chain, contract_version", async () => {
    const res = await request(app)
      .get(`/catalog/assets/${restrictedName}/${restrictedVersion}/manifest`)
      .set(lowCeilingHeaders);

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("Access denied");
    expect(res.body.reason).toBeTruthy();
    expect(res.body.action_url).toBeTruthy();
    expect(res.body.action_url).toContain("request-access");
    expect(Array.isArray(res.body.approval_chain)).toBe(true);
    expect(res.body.approval_chain.length).toBeGreaterThan(0);
    expect(res.body.contract_version).toBe("1.0.0");
  });

  it("install route: 403 includes reason, action_url, approval_chain, contract_version", async () => {
    const res = await request(app)
      .post(`/catalog/assets/${restrictedName}/${restrictedVersion}/install`)
      .set(lowCeilingHeaders)
      .send({ target: "claude-desktop" });

    expect(res.status).toBe(403);
    expect(res.body.reason).toBeTruthy();
    expect(res.body.action_url).toBeTruthy();
    expect(res.body.action_url).toContain("request-access");
    expect(Array.isArray(res.body.approval_chain)).toBe(true);
    expect(res.body.contract_version).toBe("1.0.0");
  });

  it("mcpb download route: 403 includes reason, action_url, contract_version", async () => {
    const res = await request(app)
      .get(`/catalog/assets/${restrictedName}/${restrictedVersion}/mcpb`)
      .set(lowCeilingHeaders);

    expect(res.status).toBe(403);
    expect(res.body.reason).toBeTruthy();
    expect(res.body.action_url).toBeTruthy();
    expect(res.body.contract_version).toBe("1.0.0");
  });
});

// ===========================================================================
// No unintentional governance bypass — manifest route
// ===========================================================================

describe("Governance bypass prevention — manifest route is always gated", () => {
  it("returns 403 and does NOT expose the manifest record on governance denial", async () => {
    const name = encodeURIComponent("aria.dev/skills/financial-analyzer");
    const res = await request(app)
      .get(`/catalog/assets/${name}/1.0.0/manifest`)
      .set("X-Consumer-Id", "all-employees")
      .set("X-Sensitivity-Ceiling", "internal");

    expect(res.status).toBe(403);
    // The manifest payload must not leak through on a deny
    expect(res.body.record).toBeUndefined();
    expect(res.body.install_url).toBeUndefined();
    expect(res.body.mcpb_url).toBeUndefined();
  });

  it("returns 200 and exposes manifest record when governance allows", async () => {
    const name = encodeURIComponent("aria.dev/skills/hr-policy-lookup");
    const res = await request(app)
      .get(`/catalog/assets/${name}/1.2.0/manifest`)
      .set("X-Consumer-Id", "all-employees")
      .set("X-Sensitivity-Ceiling", "internal");

    expect(res.status).toBe(200);
    expect(res.body.record).toBeDefined();
    expect(res.body.governance).toBeDefined();
  });

  it("returns 404 for a non-existent asset (governance check is not reached)", async () => {
    const name = encodeURIComponent("aria.dev/skills/does-not-exist");
    const res = await request(app)
      .get(`/catalog/assets/${name}/9.9.9/manifest`)
      .set("X-Consumer-Id", "all-employees")
      .set("X-Sensitivity-Ceiling", "highly_confidential");

    expect(res.status).toBe(404);
  });
});

// ===========================================================================
// MCP governance denial includes actionable guidance in tool response text
// ===========================================================================

describe("MCP governance denial — tool responses include actionable guidance", () => {
  const lowCeilingHeaders = {
    "X-Consumer-Id": "all-employees",
    "X-Sensitivity-Ceiling": "internal",
  };

  it("get_asset_detail denial includes 'Access denied' and a request-access URL", async () => {
    const res = await request(app)
      .post("/mcp")
      .set(lowCeilingHeaders)
      .send({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "get_asset_detail",
          arguments: {
            name: "aria.dev/skills/financial-analyzer",
            version: "1.0.0",
          },
        },
      });

    expect(res.status).toBe(200); // MCP always 200 at HTTP level
    const text: string = res.body.result.content[0].text;
    expect(text).toContain("Access denied");
    expect(text).toContain("request-access");
  });

  it("install_asset denial includes permission notice and a request-access URL", async () => {
    const res = await request(app)
      .post("/mcp")
      .set(lowCeilingHeaders)
      .send({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "install_asset",
          arguments: {
            name: "aria.dev/skills/financial-analyzer",
            version: "1.0.0",
            target: "claude-desktop",
          },
        },
      });

    expect(res.status).toBe(200);
    const text: string = res.body.result.content[0].text;
    expect(text).toContain("permission");
    expect(text).toContain("request-access");
  });
});
