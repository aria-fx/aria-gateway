/**
 * Consumer Context Tests (post legacy-header removal)
 *
 * Validates `parseConsumerContext` after the removal of legacy header
 * compatibility mode (x-consumer-id / x-sensitivity-ceiling).
 *
 * The simplified two-rule precedence is:
 *
 *   1. JWT identity present  → JWT claims always win.
 *   2. No JWT                → anonymous / public-only context returned.
 *
 * Legacy headers (x-consumer-id, x-sensitivity-ceiling) are silently ignored
 * regardless of what values are supplied.
 */

import { describe, it, expect } from "vitest";
import { parseConsumerContext } from "../src/services/governance.service.js";
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

  it("derives sensitivity_ceiling from JWT roles, ignoring any header values", () => {
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

  it("stamps contract_version on the returned context", () => {
    const ctx = parseConsumerContext({}, makeIdentity());
    expect(ctx.contract_version).toBe("1.0.0");
  });

  it("populates purview_roles as an empty array", () => {
    const ctx = parseConsumerContext({}, makeIdentity());
    expect(ctx.purview_roles).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Rule 2: No JWT → anonymous / public-only context
// ---------------------------------------------------------------------------

describe("parseConsumerContext — Rule 2: anonymous context when no JWT", () => {
  it("returns consumer_id='anonymous' when no identity is provided", () => {
    const ctx = parseConsumerContext({});
    expect(ctx.consumer_id).toBe("anonymous");
  });

  it("returns sensitivity_ceiling='public' when no identity is provided", () => {
    const ctx = parseConsumerContext({});
    expect(ctx.sensitivity_ceiling).toBe("public");
  });

  it("returns empty purview_roles", () => {
    const ctx = parseConsumerContext({});
    expect(ctx.purview_roles).toEqual([]);
  });

  it("stamps contract_version on the returned context", () => {
    const ctx = parseConsumerContext({});
    expect(ctx.contract_version).toBe("1.0.0");
  });

  it("does not attach identity to the returned context", () => {
    const ctx = parseConsumerContext({});
    expect(ctx.identity).toBeUndefined();
  });

  it("ignores x-consumer-id header (legacy header — no longer honoured)", () => {
    const ctx = parseConsumerContext({ "x-consumer-id": "hr-team" });
    expect(ctx.consumer_id).toBe("anonymous");
  });

  it("ignores x-sensitivity-ceiling header (legacy header — no longer honoured)", () => {
    const ctx = parseConsumerContext({ "x-sensitivity-ceiling": "highly_confidential" });
    expect(ctx.sensitivity_ceiling).toBe("public");
  });

  it("ignores all legacy headers even when both are provided", () => {
    const ctx = parseConsumerContext({
      "x-consumer-id": "finance-team",
      "x-sensitivity-ceiling": "confidential",
    });
    expect(ctx.consumer_id).toBe("anonymous");
    expect(ctx.sensitivity_ceiling).toBe("public");
  });
});

