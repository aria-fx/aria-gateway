/**
 * Legacy Header Compatibility Mode Tests
 *
 * Validates the LEGACY_HEADERS_MODE feature flag and its interaction with
 * JWT identity, warning log emission, and the three precedence rules:
 *
 *   1. JWT present  → JWT claims always win (headers ignored).
 *   2. No JWT, mode=enabled (default) → headers used; warning in non-dev/test.
 *   3. No JWT, mode=disabled → anonymous / public-only context returned.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { parseConsumerContext, isLegacyHeadersMode } from "../src/services/governance.service.js";
import { resetCounters, getCounters } from "../src/services/observability.service.js";
import type { NormalizedIdentity } from "../src/models/policy-contract.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeIdentity(overrides: Partial<NormalizedIdentity> = {}): NormalizedIdentity {
  return {
    contract_version: "1.0.0",
    provider: "entra",
    principal_id: "user-oid-test",
    groups: [],
    roles: ["aria-gateway-internal"],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// isLegacyHeadersMode
// ---------------------------------------------------------------------------

describe("isLegacyHeadersMode", () => {
  const originalEnv = process.env.LEGACY_HEADERS_MODE;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.LEGACY_HEADERS_MODE;
    } else {
      process.env.LEGACY_HEADERS_MODE = originalEnv;
    }
  });

  it("returns true when LEGACY_HEADERS_MODE is unset (default enabled)", () => {
    delete process.env.LEGACY_HEADERS_MODE;
    expect(isLegacyHeadersMode()).toBe(true);
  });

  it("returns true when LEGACY_HEADERS_MODE=enabled", () => {
    process.env.LEGACY_HEADERS_MODE = "enabled";
    expect(isLegacyHeadersMode()).toBe(true);
  });

  it("returns false when LEGACY_HEADERS_MODE=disabled", () => {
    process.env.LEGACY_HEADERS_MODE = "disabled";
    expect(isLegacyHeadersMode()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Rule 1: JWT identity takes unconditional precedence
// ---------------------------------------------------------------------------

describe("parseConsumerContext — Rule 1: JWT identity takes precedence", () => {
  it("uses JWT principal_id as consumer_id when identity is present", () => {
    const ctx = parseConsumerContext(
      { "x-consumer-id": "header-team", "x-sensitivity-ceiling": "public" },
      makeIdentity({ principal_id: "jwt-principal" })
    );
    expect(ctx.consumer_id).toBe("jwt-principal");
  });

  it("derives sensitivity_ceiling from JWT roles, ignoring header value", () => {
    const ctx = parseConsumerContext(
      { "x-sensitivity-ceiling": "public" },
      makeIdentity({ roles: ["aria-gateway-admin"] })
    );
    expect(ctx.sensitivity_ceiling).toBe("highly_confidential");
  });

  it("attaches the identity object to the returned context", () => {
    const identity = makeIdentity();
    const ctx = parseConsumerContext({}, identity);
    expect(ctx.identity).toBe(identity);
  });

  it("works the same regardless of LEGACY_HEADERS_MODE when JWT is present", () => {
    const identity = makeIdentity({ principal_id: "jwt-user" });

    process.env.LEGACY_HEADERS_MODE = "disabled";
    const ctxDisabled = parseConsumerContext(
      { "x-consumer-id": "hdr-user" },
      identity
    );

    process.env.LEGACY_HEADERS_MODE = "enabled";
    const ctxEnabled = parseConsumerContext(
      { "x-consumer-id": "hdr-user" },
      identity
    );

    delete process.env.LEGACY_HEADERS_MODE;

    expect(ctxDisabled.consumer_id).toBe("jwt-user");
    expect(ctxEnabled.consumer_id).toBe("jwt-user");
  });
});

// ---------------------------------------------------------------------------
// Rule 2: legacy mode enabled — headers honoured when no JWT
// ---------------------------------------------------------------------------

describe("parseConsumerContext — Rule 2: legacy mode enabled (default)", () => {
  beforeEach(() => {
    delete process.env.LEGACY_HEADERS_MODE; // default = enabled
  });

  it("uses x-consumer-id header as consumer_id", () => {
    const ctx = parseConsumerContext({ "x-consumer-id": "hr-team" });
    expect(ctx.consumer_id).toBe("hr-team");
  });

  it("uses x-sensitivity-ceiling header when valid", () => {
    const ctx = parseConsumerContext({ "x-sensitivity-ceiling": "confidential" });
    expect(ctx.sensitivity_ceiling).toBe("confidential");
  });

  it("falls back to 'all-employees' when x-consumer-id is absent", () => {
    const ctx = parseConsumerContext({});
    expect(ctx.consumer_id).toBe("all-employees");
  });

  it("falls back to 'internal' when x-sensitivity-ceiling is absent or invalid", () => {
    expect(parseConsumerContext({}).sensitivity_ceiling).toBe("internal");
    expect(
      parseConsumerContext({ "x-sensitivity-ceiling": "ultra-secret" }).sensitivity_ceiling
    ).toBe("internal");
  });

  it("stamps contract_version on the returned context", () => {
    const ctx = parseConsumerContext({ "x-consumer-id": "sales-team" });
    expect(ctx.contract_version).toBe("1.0.0");
  });

  it("identity is undefined in the returned context", () => {
    const ctx = parseConsumerContext({ "x-consumer-id": "sales-team" });
    expect(ctx.identity).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Rule 3: legacy mode disabled — anonymous context when no JWT
// ---------------------------------------------------------------------------

describe("parseConsumerContext — Rule 3: legacy mode disabled", () => {
  beforeEach(() => {
    process.env.LEGACY_HEADERS_MODE = "disabled";
  });

  afterEach(() => {
    delete process.env.LEGACY_HEADERS_MODE;
  });

  it("returns consumer_id='anonymous' regardless of x-consumer-id header", () => {
    const ctx = parseConsumerContext({ "x-consumer-id": "hr-team" });
    expect(ctx.consumer_id).toBe("anonymous");
  });

  it("returns sensitivity_ceiling='public' regardless of x-sensitivity-ceiling header", () => {
    const ctx = parseConsumerContext({ "x-sensitivity-ceiling": "highly_confidential" });
    expect(ctx.sensitivity_ceiling).toBe("public");
  });

  it("returns empty purview_roles", () => {
    const ctx = parseConsumerContext({});
    expect(ctx.purview_roles).toEqual([]);
  });

  it("still honours JWT identity even when legacy mode is disabled", () => {
    const identity = makeIdentity({ principal_id: "jwt-user-disabled" });
    const ctx = parseConsumerContext(
      { "x-consumer-id": "should-be-ignored" },
      identity
    );
    expect(ctx.consumer_id).toBe("jwt-user-disabled");
  });
});

// ---------------------------------------------------------------------------
// Warning log emission (structured JSON via observability service)
// ---------------------------------------------------------------------------

describe("parseConsumerContext — warning log in non-dev environments", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    resetCounters();
    delete process.env.LEGACY_HEADERS_MODE; // ensure default (enabled)
  });

  afterEach(() => {
    warnSpy.mockRestore();
    delete process.env.LEGACY_HEADERS_MODE;
  });

  it("emits a structured JSON warning when legacy headers are used in production", () => {
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      parseConsumerContext({ "x-consumer-id": "hr-team" });
      expect(warnSpy).toHaveBeenCalledOnce();
      const emitted = JSON.parse(warnSpy.mock.calls[0][0] as string);
      expect(emitted.event).toBe("auth.legacy_header_used");
      expect(emitted.consumer_id).toBe("hr-team");
      expect(emitted.sensitivity_ceiling).toBe("(absent)");
      expect(typeof emitted.timestamp).toBe("string");
    } finally {
      process.env.NODE_ENV = originalEnv;
    }
  });

  it("increments the auth.legacy_header_used counter in production", () => {
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      parseConsumerContext({ "x-consumer-id": "hr-team" });
      expect(getCounters()["auth.legacy_header_used"]).toBe(1);
    } finally {
      process.env.NODE_ENV = originalEnv;
    }
  });

  it("does not emit a warning in test environment", () => {
    // NODE_ENV is already "test" in vitest
    parseConsumerContext({ "x-consumer-id": "hr-team" });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("still increments the counter even in test environment", () => {
    parseConsumerContext({ "x-consumer-id": "hr-team" });
    // Counter increments regardless of NODE_ENV (unlike the log)
    expect(getCounters()["auth.legacy_header_used"]).toBe(1);
  });

  it("does not emit a warning in development environment", () => {
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "development";
    try {
      parseConsumerContext({ "x-consumer-id": "hr-team" });
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      process.env.NODE_ENV = originalEnv;
    }
  });

  it("does not emit a warning when JWT identity is present (no legacy headers used)", () => {
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      parseConsumerContext(
        { "x-consumer-id": "hr-team" },
        makeIdentity()
      );
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      process.env.NODE_ENV = originalEnv;
    }
  });

  it("does not emit a warning when no legacy headers are present", () => {
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      parseConsumerContext({}); // no x-consumer-id or x-sensitivity-ceiling
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      process.env.NODE_ENV = originalEnv;
    }
  });

  it("includes the header values in the structured warning", () => {
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      parseConsumerContext({
        "x-consumer-id": "sales-team",
        "x-sensitivity-ceiling": "confidential",
      });
      const emitted = JSON.parse(warnSpy.mock.calls[0][0] as string);
      expect(emitted.consumer_id).toBe("sales-team");
      expect(emitted.sensitivity_ceiling).toBe("confidential");
    } finally {
      process.env.NODE_ENV = originalEnv;
    }
  });

  it("does not emit a warning when legacy mode is disabled (no headers used)", () => {
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    process.env.LEGACY_HEADERS_MODE = "disabled";
    try {
      parseConsumerContext({ "x-consumer-id": "hr-team" });
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      process.env.NODE_ENV = originalEnv;
      delete process.env.LEGACY_HEADERS_MODE;
    }
  });
});
