import type { CatalogAsset, SensitivityTier } from "../models/oasf.js";
import type { EffectiveAccessContext, NormalizedIdentity, PolicyDecision } from "../models/policy-contract.js";
import { POLICY_CONTRACT_VERSION } from "../models/policy-contract.js";
import { sampleAssets } from "../data/sample-assets.js";
import { sensitivityCeilingFromIdentity } from "../middleware/auth.middleware.js";
import {
  emitLegacyHeaderUsed,
  emitPolicyDeny,
  type PolicyDenyReason,
} from "./observability.service.js";

// ---------------------------------------------------------------------------
// Legacy header compatibility mode
// ---------------------------------------------------------------------------

/**
 * Returns true when legacy header compatibility mode is active.
 *
 * Controlled by the LEGACY_HEADERS_MODE environment variable:
 *   "enabled"  (default) — x-consumer-id / x-sensitivity-ceiling headers are
 *               honoured as a fallback when no JWT identity is present.
 *   "disabled" — headers are ignored; unauthenticated requests receive an
 *               anonymous / public-only access context.
 *
 * @deprecated Legacy header mode will be removed on 2027-01-01.
 *             Migrate all callers to JWT bearer token authentication.
 */
export function isLegacyHeadersMode(): boolean {
  return process.env.LEGACY_HEADERS_MODE !== "disabled";
}

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
  consumer: ConsumerContext
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
    const deps = resolveDependencies(asset);
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

function resolveDependencies(asset: CatalogAsset): CatalogAsset[] {
  const deps: CatalogAsset[] = [];
  for (const module of asset.record.modules) {
    if (module.ref && typeof module.ref === "string") {
      const [depName] = module.ref.split(":");
      const dep = sampleAssets.find((a) => a.record.name === depName);
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

// Parse consumer context from request headers, optionally enriched by a
// validated JWT identity (produced by the auth middleware).
//
// Precedence rules:
//   1. JWT identity present  → JWT claims always win; legacy headers are ignored.
//   2. No JWT, LEGACY_HEADERS_MODE=enabled (default)
//                            → legacy x-consumer-id / x-sensitivity-ceiling
//                              headers are used with sensible defaults.
//                              A warning is emitted outside dev/test environments.
//   3. No JWT, LEGACY_HEADERS_MODE=disabled
//                            → headers are ignored; anonymous / public-only
//                              access context is returned.
export function parseConsumerContext(
  headers: Record<string, string | string[] | undefined>,
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

  // No JWT — check legacy header compatibility mode.
  if (!isLegacyHeadersMode()) {
    // Rule 3: legacy mode disabled → anonymous / public-only context.
    return {
      contract_version: POLICY_CONTRACT_VERSION,
      consumer_id: "anonymous",
      sensitivity_ceiling: "public",
      purview_roles: [],
    };
  }

  // Rule 2: legacy mode enabled → honour x-consumer-id / x-sensitivity-ceiling.
  const consumerId = headers["x-consumer-id"];
  const ceiling = headers["x-sensitivity-ceiling"];

  const hasLegacyHeaders =
    typeof consumerId === "string" || typeof ceiling === "string";

  // Emit a structured event when legacy headers are in active use so that
  // operators can track migration progress via log aggregation / alerting.
  // Counters increment in all environments; log emission is suppressed in
  // "development" and "test" by the observability service itself.
  if (hasLegacyHeaders) {
    emitLegacyHeaderUsed({
      consumer_id: typeof consumerId === "string" ? consumerId : "(absent)",
      sensitivity_ceiling: typeof ceiling === "string" ? ceiling : "(absent)",
    });
  }

  const resolvedConsumerId =
    typeof consumerId === "string" ? consumerId : "all-employees";

  const resolvedCeiling: SensitivityTier =
    typeof ceiling === "string" && ceiling in TIER_ORDER
      ? (ceiling as SensitivityTier)
      : "internal";

  return {
    contract_version: POLICY_CONTRACT_VERSION,
    consumer_id: resolvedConsumerId,
    sensitivity_ceiling: resolvedCeiling,
    purview_roles: [],
  };
}
