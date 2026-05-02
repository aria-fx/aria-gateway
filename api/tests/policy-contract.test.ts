import { describe, it, expect } from "vitest";
import {
  POLICY_CONTRACT_VERSION,
  withContractVersion,
  type NormalizedIdentity,
  type EffectiveAccessContext,
  type PolicyDecision,
} from "../src/models/policy-contract.js";
import {
  checkGovernance,
  getAnonymousConsumer,
  parseConsumerContext,
} from "../src/services/governance.service.js";
import { sampleAssets } from "../src/data/sample-assets.js";

describe("Policy Contract", () => {
  it("POLICY_CONTRACT_VERSION is '1.0.0'", () => {
    expect(POLICY_CONTRACT_VERSION).toBe("1.0.0");
  });

  it("withContractVersion stamps contract_version onto an object", () => {
    const result = withContractVersion({ allowed: true });
    expect(result.contract_version).toBe("1.0.0");
    expect(result.allowed).toBe(true);
  });

  describe("NormalizedIdentity shape", () => {
    it("accepts a minimal valid identity", () => {
      const identity: NormalizedIdentity = {
        contract_version: "1.0.0",
        provider: "entra",
        principal_id: "00000000-0000-0000-0000-000000000001",
        groups: ["hr-team"],
        roles: ["User"],
      };
      expect(identity.provider).toBe("entra");
      expect(identity.groups).toHaveLength(1);
      expect(identity.roles).toHaveLength(1);
    });

    it("accepts optional fields", () => {
      const identity: NormalizedIdentity = {
        contract_version: "1.0.0",
        provider: "github",
        principal_id: "gh-user-42",
        display_name: "Jane Smith",
        email: "jane@example.com",
        groups: ["aria-fx/engineering"],
        roles: ["read:catalog"],
        tenant: "aria-fx",
        extensions: { "github:company": "ARIA" },
      };
      expect(identity.display_name).toBe("Jane Smith");
      expect(identity.tenant).toBe("aria-fx");
      expect(identity.extensions?.["github:company"]).toBe("ARIA");
    });

    it("accepts a custom IDP slug", () => {
      const identity: NormalizedIdentity = {
        contract_version: "1.0.0",
        provider: "ping",
        principal_id: "ping-001",
        groups: [],
        roles: [],
      };
      expect(identity.provider).toBe("ping");
    });
  });

  describe("EffectiveAccessContext shape", () => {
    it("has required purview_roles field", () => {
      const ctx: EffectiveAccessContext = {
        contract_version: "1.0.0",
        consumer_id: "hr-team",
        sensitivity_ceiling: "internal",
        purview_roles: [],
      };
      expect(ctx.purview_roles).toEqual([]);
    });

    it("accepts purview roles", () => {
      const ctx: EffectiveAccessContext = {
        contract_version: "1.0.0",
        consumer_id: "security-team",
        sensitivity_ceiling: "highly_confidential",
        purview_roles: ["purview:export-approver", "purview:audit-reader"],
      };
      expect(ctx.purview_roles).toContain("purview:export-approver");
    });
  });

  describe("PolicyDecision shape", () => {
    it("has contract_version when allowed", () => {
      const decision: PolicyDecision = {
        contract_version: "1.0.0",
        allowed: true,
      };
      expect(decision.contract_version).toBe("1.0.0");
      expect(decision.allowed).toBe(true);
    });

    it("has reason and action_url when denied", () => {
      const decision: PolicyDecision = {
        contract_version: "1.0.0",
        allowed: false,
        reason: "Sensitivity tier too high",
        approval_chain: ["security-team"],
        action_url: "/catalog/assets/foo/1.0.0/request-access",
      };
      expect(decision.reason).toBe("Sensitivity tier too high");
      expect(decision.approval_chain).toContain("security-team");
    });
  });
});

describe("Governance service – policy contract integration", () => {
  it("getAnonymousConsumer returns EffectiveAccessContext with contract_version", () => {
    const ctx = getAnonymousConsumer();
    expect(ctx.contract_version).toBe("1.0.0");
    expect(ctx.consumer_id).toBe("anonymous");
    expect(ctx.sensitivity_ceiling).toBe("public");
    expect(ctx.purview_roles).toEqual([]);
  });

  it("parseConsumerContext returns EffectiveAccessContext with contract_version", () => {
    const ctx = parseConsumerContext({
      "x-consumer-id": "hr-team",
      "x-sensitivity-ceiling": "internal",
    });
    expect(ctx.contract_version).toBe("1.0.0");
    expect(ctx.consumer_id).toBe("hr-team");
    expect(ctx.sensitivity_ceiling).toBe("internal");
    expect(ctx.purview_roles).toEqual([]);
  });

  it("parseConsumerContext defaults correctly with missing headers", () => {
    const ctx = parseConsumerContext({});
    expect(ctx.consumer_id).toBe("all-employees");
    expect(ctx.sensitivity_ceiling).toBe("internal");
  });

  it("checkGovernance returns PolicyDecision with contract_version when allowed", () => {
    const publicAsset = sampleAssets.find(
      (a) => a.governance.sensitivity_tier === "public"
    );
    expect(publicAsset).toBeDefined();
    const ctx = getAnonymousConsumer();
    const decision = checkGovernance(publicAsset!, ctx);
    expect(decision.contract_version).toBe("1.0.0");
    expect(decision.allowed).toBe(true);
  });

  it("checkGovernance returns PolicyDecision with reason when denied", () => {
    const restrictedAsset = sampleAssets.find(
      (a) => a.governance.sensitivity_tier === "highly_confidential"
    );
    expect(restrictedAsset).toBeDefined();
    const ctx = getAnonymousConsumer(); // public ceiling — should be denied
    const decision = checkGovernance(restrictedAsset!, ctx);
    expect(decision.contract_version).toBe("1.0.0");
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBeDefined();
    expect(typeof decision.reason).toBe("string");
    expect(decision.action_url).toContain("/request-access");
  });
});
