/**
 * Observability Service Tests
 *
 * Validates the structured event emission, in-memory counters, and
 * integration with auth middleware and governance service.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  emitAuthFailure,
  emitPolicyDeny,
  getCounters,
  resetCounters,
} from "../src/services/observability.service.js";
import { checkGovernance } from "../src/services/governance.service.js";
import { generateKeyPair } from "node:crypto";
import { promisify } from "node:util";
import { SignJWT, importPKCS8, importSPKI, type KeyLike } from "jose";
import express from "express";
import { createAuthMiddleware } from "../src/middleware/auth.middleware.js";
import request from "supertest";

// ---------------------------------------------------------------------------
// Counter helpers
// ---------------------------------------------------------------------------

describe("getCounters / resetCounters", () => {
  beforeEach(() => resetCounters());

  it("returns an empty object before any events are emitted", () => {
    expect(getCounters()).toEqual({});
  });

  it("resetCounters clears all counters", () => {
    emitAuthFailure({ mode: "observe", reason: "token_missing" });
    expect(Object.keys(getCounters()).length).toBeGreaterThan(0);
    resetCounters();
    expect(getCounters()).toEqual({});
  });

  it("getCounters returns a snapshot (mutations do not affect internal state)", () => {
    emitAuthFailure({ mode: "observe", reason: "token_missing" });
    const snap = getCounters() as Record<string, number>;
    snap["auth.failure.observe.token_missing"] = 9999;
    // Internal counter unchanged
    expect(getCounters()["auth.failure.observe.token_missing"]).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// emitAuthFailure
// ---------------------------------------------------------------------------

describe("emitAuthFailure — counter increments", () => {
  beforeEach(() => resetCounters());

  it("increments the observe.token_missing counter", () => {
    emitAuthFailure({ mode: "observe", reason: "token_missing" });
    expect(getCounters()["auth.failure.observe.token_missing"]).toBe(1);
  });

  it("increments the enforce.token_invalid counter", () => {
    emitAuthFailure({ mode: "enforce", reason: "token_invalid" });
    expect(getCounters()["auth.failure.enforce.token_invalid"]).toBe(1);
  });

  it("increments the observe.jwks_unconfigured counter", () => {
    emitAuthFailure({ mode: "observe", reason: "jwks_unconfigured" });
    expect(getCounters()["auth.failure.observe.jwks_unconfigured"]).toBe(1);
  });

  it("accumulates across multiple calls", () => {
    emitAuthFailure({ mode: "observe", reason: "token_missing" });
    emitAuthFailure({ mode: "observe", reason: "token_missing" });
    emitAuthFailure({ mode: "observe", reason: "token_missing" });
    expect(getCounters()["auth.failure.observe.token_missing"]).toBe(3);
  });
});

describe("emitAuthFailure — log emission", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    resetCounters();
  });
  afterEach(() => warnSpy.mockRestore());

  it("suppresses log output in test environment", () => {
    // NODE_ENV is "test" in vitest
    emitAuthFailure({ mode: "observe", reason: "token_missing" });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("emits a structured JSON log in production", () => {
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      emitAuthFailure({ mode: "enforce", reason: "token_invalid", error_message: "bad sig" });
      expect(warnSpy).toHaveBeenCalledOnce();
      const emitted = JSON.parse(warnSpy.mock.calls[0][0] as string);
      expect(emitted.event).toBe("auth.failure");
      expect(emitted.mode).toBe("enforce");
      expect(emitted.reason).toBe("token_invalid");
      expect(emitted.error_message).toBe("bad sig");
      expect(typeof emitted.timestamp).toBe("string");
    } finally {
      process.env.NODE_ENV = originalEnv;
    }
  });

  it("emits a structured JSON log in staging (non-dev, non-test)", () => {
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "staging";
    try {
      emitAuthFailure({ mode: "observe", reason: "token_missing" });
      const emitted = JSON.parse(warnSpy.mock.calls[0][0] as string);
      expect(emitted.event).toBe("auth.failure");
      expect(emitted.mode).toBe("observe");
    } finally {
      process.env.NODE_ENV = originalEnv;
    }
  });
});

// ---------------------------------------------------------------------------
// emitPolicyDeny
// ---------------------------------------------------------------------------

describe("emitPolicyDeny — counter increments", () => {
  beforeEach(() => resetCounters());

  it("increments the sensitivity_ceiling counter", () => {
    emitPolicyDeny({
      asset_name: "aria.dev/skills/test",
      asset_version: "1.0.0",
      consumer_id: "all-employees",
      deny_reason: "sensitivity_ceiling",
    });
    expect(getCounters()["policy.deny.sensitivity_ceiling"]).toBe(1);
  });

  it("increments the consumer_not_allowed counter", () => {
    emitPolicyDeny({
      asset_name: "aria.dev/skills/test",
      asset_version: "1.0.0",
      consumer_id: "hr-team",
      deny_reason: "consumer_not_allowed",
    });
    expect(getCounters()["policy.deny.consumer_not_allowed"]).toBe(1);
  });

  it("increments each deny reason independently", () => {
    emitPolicyDeny({ asset_name: "a", asset_version: "1", consumer_id: "c", deny_reason: "sensitivity_ceiling" });
    emitPolicyDeny({ asset_name: "b", asset_version: "1", consumer_id: "c", deny_reason: "entra_group_required" });
    emitPolicyDeny({ asset_name: "b", asset_version: "1", consumer_id: "c", deny_reason: "entra_group_required" });
    expect(getCounters()["policy.deny.sensitivity_ceiling"]).toBe(1);
    expect(getCounters()["policy.deny.entra_group_required"]).toBe(2);
  });
});

describe("emitPolicyDeny — log emission", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    resetCounters();
  });
  afterEach(() => warnSpy.mockRestore());

  it("emits structured JSON in production", () => {
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      emitPolicyDeny({
        asset_name: "aria.dev/skills/financial-analyzer",
        asset_version: "1.0.0",
        consumer_id: "all-employees",
        deny_reason: "sensitivity_ceiling",
      });
      const emitted = JSON.parse(warnSpy.mock.calls[0][0] as string);
      expect(emitted.event).toBe("policy.deny");
      expect(emitted.asset_name).toBe("aria.dev/skills/financial-analyzer");
      expect(emitted.asset_version).toBe("1.0.0");
      expect(emitted.consumer_id).toBe("all-employees");
      expect(emitted.deny_reason).toBe("sensitivity_ceiling");
      expect(typeof emitted.timestamp).toBe("string");
    } finally {
      process.env.NODE_ENV = originalEnv;
    }
  });
});

// ---------------------------------------------------------------------------
// Integration: checkGovernance emits policy deny events
// ---------------------------------------------------------------------------

describe("checkGovernance — emits policy deny counter", () => {
  // We import the sample assets to build a realistic test scenario
  beforeEach(() => resetCounters());

  it("increments policy.deny.sensitivity_ceiling when ceiling check fails", async () => {
    const { checkGovernance } = await import("../src/services/governance.service.js");
    const { sampleAssets } = await import("../src/data/sample-assets.js");

    const restricted = sampleAssets.find(
      (a) => a.record.name === "aria.dev/skills/financial-analyzer"
    )!;
    expect(restricted).toBeDefined();

    checkGovernance(restricted, {
      contract_version: "1.0.0",
      consumer_id: "all-employees",
      sensitivity_ceiling: "internal", // not high enough for highly_confidential
      purview_roles: [],
    });

    expect(getCounters()["policy.deny.sensitivity_ceiling"]).toBe(1);
  });

  it("does not increment any deny counter when access is allowed", async () => {
    const { checkGovernance } = await import("../src/services/governance.service.js");
    const { sampleAssets } = await import("../src/data/sample-assets.js");

    const accessible = sampleAssets.find(
      (a) => a.record.name === "aria.dev/skills/hr-policy-lookup"
    )!;
    expect(accessible).toBeDefined();

    const decision = checkGovernance(accessible, {
      contract_version: "1.0.0",
      consumer_id: "all-employees",
      sensitivity_ceiling: "internal",
      purview_roles: [],
    });

    expect(decision.allowed).toBe(true);
    const cs = getCounters();
    const denyKeys = Object.keys(cs).filter((k) => k.startsWith("policy.deny."));
    expect(denyKeys).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Integration: auth middleware emits auth failure counter
// ---------------------------------------------------------------------------

describe("createAuthMiddleware — emits auth failure counters", () => {
  const generateKeyPairAsync = promisify(generateKeyPair);
  let app: ReturnType<typeof express>;

  beforeEach(async () => {
    resetCounters();
    const pair = await generateKeyPairAsync("rsa", { modulusLength: 2048 });
    const spki = pair.publicKey.export({ type: "spki", format: "pem" }) as string;
    const pkcs8 = pair.privateKey.export({ type: "pkcs8", format: "pem" }) as string;
    const privKey = await importPKCS8(pkcs8, "RS256");
    const pubKey = await importSPKI(spki, "RS256");

    const jwksProvider = async () => pubKey as KeyLike;

    app = express();
    app.use(express.json());
    app.use(
      createAuthMiddleware({
        enforce: false, // observe mode
        issuer: "https://login.microsoftonline.com/test-tenant/v2.0",
        audience: "test-client-id",
        jwksUri: "https://example.invalid/jwks",
        jwksProvider: jwksProvider as ReturnType<typeof import("jose")["createRemoteJWKSet"]>,
      })
    );
    app.get("/probe", (_req, res) => res.json({ ok: true }));
  });

  it("increments auth.failure.observe.token_missing when no token is sent (observe mode)", async () => {
    await request(app).get("/probe");
    expect(getCounters()["auth.failure.observe.token_missing"]).toBe(1);
  });

  it("increments auth.failure.observe.token_invalid when a garbage token is sent", async () => {
    await request(app).get("/probe").set("Authorization", "Bearer garbage.jwt.here");
    expect(getCounters()["auth.failure.observe.token_invalid"]).toBe(1);
  });
});

describe("createAuthMiddleware — enforcing mode emits enforce counters", () => {
  const generateKeyPairAsync = promisify(generateKeyPair);
  let appEnforce: ReturnType<typeof express>;

  beforeEach(async () => {
    resetCounters();
    const pair = await generateKeyPairAsync("rsa", { modulusLength: 2048 });
    const spki = pair.publicKey.export({ type: "spki", format: "pem" }) as string;
    const pkcs8 = pair.privateKey.export({ type: "pkcs8", format: "pem" }) as string;
    const privKey = await importPKCS8(pkcs8, "RS256");
    const pubKey = await importSPKI(spki, "RS256");

    const jwksProvider = async () => pubKey as KeyLike;

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
    appEnforce.get("/probe", (_req, res) => res.json({ ok: true }));
  });

  it("increments auth.failure.enforce.token_missing when no token is sent (enforce mode)", async () => {
    await request(appEnforce).get("/probe");
    expect(getCounters()["auth.failure.enforce.token_missing"]).toBe(1);
  });

  it("increments auth.failure.enforce.token_invalid for an invalid token", async () => {
    await request(appEnforce).get("/probe").set("Authorization", "Bearer garbage.jwt.here");
    expect(getCounters()["auth.failure.enforce.token_invalid"]).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// /metrics endpoint
// ---------------------------------------------------------------------------

describe("GET /metrics endpoint", () => {
  beforeEach(() => resetCounters());

  it("returns auth_enforce_mode and counters", async () => {
    const { default: app } = await import("../src/index.js");
    const res = await request(app).get("/metrics");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("auth_enforce_mode");
    expect(res.body).not.toHaveProperty("legacy_headers_mode");
    expect(res.body).toHaveProperty("counters");
    expect(typeof res.body.counters).toBe("object");
  });

  it("reflects AUTH_ENFORCE=false as observe mode", async () => {
    const savedEnforce = process.env.AUTH_ENFORCE;
    delete process.env.AUTH_ENFORCE;
    try {
      const { default: app } = await import("../src/index.js");
      const res = await request(app).get("/metrics");
      expect(res.body.auth_enforce_mode).toBe("observe");
    } finally {
      if (savedEnforce !== undefined) process.env.AUTH_ENFORCE = savedEnforce;
      else delete process.env.AUTH_ENFORCE;
    }
  });

  it("counters object reflects events emitted since process start", async () => {
    const { default: app } = await import("../src/index.js");
    // Emit one event directly
    emitAuthFailure({ mode: "observe", reason: "token_missing" });
    const res = await request(app).get("/metrics");
    expect(res.body.counters["auth.failure.observe.token_missing"]).toBeGreaterThanOrEqual(1);
  });
});
