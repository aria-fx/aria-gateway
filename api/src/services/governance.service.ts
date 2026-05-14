import type { CatalogAsset, SensitivityTier } from "../models/oasf.js";
import type { EffectiveAccessContext, NormalizedIdentity, PolicyDecision } from "../models/policy-contract.js";
import { POLICY_CONTRACT_VERSION } from "../models/policy-contract.js";
import { sampleAssets } from "../data/sample-assets.js";
import { sensitivityCeilingFromIdentity } from "../middleware/auth.middleware.js";
import {
  emitPolicyDeny,
  type PolicyDenyReason,
} from "./observability.service.js";

const TIER_ORDER: Record<SensitivityTier, number> = {
  public: 0,
  internal: 1,
  confidential: 2,
  highly_confidential: 3,
};

function tierLevel(tier: SensitivityTier): number {
  return TIER_ORDER[tier] ?? 0;
}

/**
 * Consumer context passed to governance checks.
 * Re-exported as an alias of {@link EffectiveAccessContext} from the
 * policy contract so that all service code uses the versioned type.
 */
export type ConsumerContext = EffectiveAccessContext;

export function checkGovernance(
  asset: CatalogAsset,
  consumer: ConsumerContext,
  catalogAssets: CatalogAsset[] = sampleAssets
): PolicyDecision {
  const governance = asset.governance;
  const name = asset.record.name;
  const version = asset.record.version;

  /** Build a deny decision and emit the corresponding observability event. */
  function deny(reason: string, denyReason: PolicyDenyReason): PolicyDecision {
    emitPolicyDeny({
      asset_name: name,
      asset_version: version,
      consumer_id: consumer.consumer_id,
      deny_reason: denyReason,
    });
    return {
      contract_version: POLICY_CONTRACT_VERSION,
      allowed: false,
      reason,
      approval_chain: governance.approval_chain,
      action_url: `/catalog/assets/${encodeURIComponent(name)}/${version}/request-access`,
    };
  }

  // 1. Sensitivity ceiling check
  if (tierLevel(governance.sensitivity_tier) > tierLevel(consumer.sensitivity_ceiling)) {
    return deny(
      `This asset is classified as "${governance.sensitivity_tier}" but your access level only permits "${consumer.sensitivity_ceiling}" assets.`,
      "sensitivity_ceiling"
    );
  }

  // 2. Consumer allow-list check
  if (
    governance.allowed_consumers &&
    governance.allowed_consumers.length > 0 &&
    !governance.allowed_consumers.includes(consumer.consumer_id) &&
    !governance.allowed_consumers.includes("all-employees")
  ) {
    return deny(
      `Your team (${consumer.consumer_id}) does not have access to this asset. Access is restricted to: ${governance.allowed_consumers.join(", ")}.`,
      "consumer_not_allowed"
    );
  }

  // 3. Entra group constraint check
  if (governance.allowed_entra_groups && governance.allowed_entra_groups.length > 0) {
    const consumerGroups = consumer.identity?.groups ?? [];
    const hasGroup = consumerGroups.some((g) =>
      governance.allowed_entra_groups!.includes(g)
    );
    if (!hasGroup) {
      return deny(
        `Access to this asset requires membership in one of the following Entra groups: ${governance.allowed_entra_groups.join(", ")}.`,
        "entra_group_required"
      );
    }
  }

  // 4. Entra role constraint check
  if (governance.allowed_entra_roles && governance.allowed_entra_roles.length > 0) {
    const consumerRoles = consumer.identity?.roles ?? [];
    const hasRole = consumerRoles.some((r) =>
      governance.allowed_entra_roles!.includes(r)
    );
    if (!hasRole) {
      return deny(
        `Access to this asset requires one of the following Entra roles: ${governance.allowed_entra_roles.join(", ")}.`,
        "entra_role_required"
      );
    }
  }

  // 5. Purview role requirements check
  if (governance.required_purview_roles && governance.required_purview_roles.length > 0) {
    const consumerPurview = consumer.purview_roles ?? [];
    const hasPurview = consumerPurview.some((r) =>
      governance.required_purview_roles!.includes(r)
    );
    if (!hasPurview) {
      return deny(
        `Access to this asset requires one of the following purview roles: ${governance.required_purview_roles.join(", ")}.`,
        "purview_role_required"
      );
    }
  }

  // 6. Dependency sensitivity ceiling check
  if (governance.dependency_sensitivity_ceiling) {
    const deps = resolveDependencies(asset, catalogAssets);
    for (const dep of deps) {
      if (
        tierLevel(dep.governance.sensitivity_tier) >
        tierLevel(governance.dependency_sensitivity_ceiling)
      ) {
        return deny(
          `A dependency (${dep.record.name}) exceeds the allowed sensitivity ceiling of ${governance.dependency_sensitivity_ceiling}.`,
          "dependency_ceiling"
        );
      }
    }
  }

  return { contract_version: POLICY_CONTRACT_VERSION, allowed: true };
}

function resolveDependencies(asset: CatalogAsset, sourceAssets: CatalogAsset[]): CatalogAsset[] {
  const deps: CatalogAsset[] = [];
  for (const module of asset.record.modules) {
    if (module.ref && typeof module.ref === "string") {
      const [depName] = module.ref.split(":");
      const dep = sourceAssets.find((a) => a.record.name === depName);
      if (dep) deps.push(dep);
    }
  }
  return deps;
}

// Default consumer context when no auth is provided (public/anonymous)
export function getAnonymousConsumer(): ConsumerContext {
  return {
    contract_version: POLICY_CONTRACT_VERSION,
    consumer_id: "anonymous",
    sensitivity_ceiling: "public",
    purview_roles: [],
  };
}

// Parse consumer context from request headers, enriched by a validated JWT
// identity (produced by the auth middleware).
//
// Precedence rules:
//   1. JWT identity present  → JWT claims always win.
//   2. No JWT               → anonymous / public-only access context returned.
//
// Note: Legacy header-based identity (x-consumer-id / x-sensitivity-ceiling)
// has been removed as of v2.0.0. All callers must use JWT bearer tokens.
export function parseConsumerContext(
  _headers: Record<string, string | string[] | undefined>,
  identity?: NormalizedIdentity
): ConsumerContext {
  // Rule 1: JWT identity takes unconditional precedence.
  if (identity) {
    return {
      contract_version: POLICY_CONTRACT_VERSION,
      consumer_id: identity.principal_id,
      sensitivity_ceiling: sensitivityCeilingFromIdentity(identity),
      purview_roles: [],
      identity,
    };
  }

  // Rule 2: No JWT → anonymous / public-only context.
  return {
    contract_version: POLICY_CONTRACT_VERSION,
    consumer_id: "anonymous",
    sensitivity_ceiling: "public",
    purview_roles: [],
  };
}
