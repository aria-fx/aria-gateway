import type {
  CatalogAsset,
  GovernanceCheckResult,
  SensitivityTier,
} from "../models/oasf.js";
import { sampleAssets } from "../data/sample-assets.js";

const TIER_ORDER: Record<SensitivityTier, number> = {
  public: 0,
  internal: 1,
  confidential: 2,
  highly_confidential: 3,
};

function tierLevel(tier: SensitivityTier): number {
  return TIER_ORDER[tier] ?? 0;
}

export interface ConsumerContext {
  consumer_id: string;
  sensitivity_ceiling: SensitivityTier;
}

export function checkGovernance(
  asset: CatalogAsset,
  consumer: ConsumerContext
): GovernanceCheckResult {
  const governance = asset.governance;
  const name = asset.record.name;
  const version = asset.record.version;

  // 1. Sensitivity ceiling check
  if (tierLevel(governance.sensitivity_tier) > tierLevel(consumer.sensitivity_ceiling)) {
    return {
      allowed: false,
      reason: `This asset is classified as "${governance.sensitivity_tier}" but your access level only permits "${consumer.sensitivity_ceiling}" assets.`,
      approval_chain: governance.approval_chain,
      action_url: `/catalog/assets/${encodeURIComponent(name)}/${version}/request-access`,
    };
  }

  // 2. Consumer allow-list check
  if (
    governance.allowed_consumers &&
    governance.allowed_consumers.length > 0 &&
    !governance.allowed_consumers.includes(consumer.consumer_id) &&
    !governance.allowed_consumers.includes("all-employees")
  ) {
    return {
      allowed: false,
      reason: `Your team (${consumer.consumer_id}) does not have access to this asset. Access is restricted to: ${governance.allowed_consumers.join(", ")}.`,
      approval_chain: governance.approval_chain,
      action_url: `/catalog/assets/${encodeURIComponent(name)}/${version}/request-access`,
    };
  }

  // 3. Dependency sensitivity ceiling check
  if (governance.dependency_sensitivity_ceiling) {
    const deps = resolveDependencies(asset);
    for (const dep of deps) {
      if (
        tierLevel(dep.governance.sensitivity_tier) >
        tierLevel(governance.dependency_sensitivity_ceiling)
      ) {
        return {
          allowed: false,
          reason: `A dependency (${dep.record.name}) exceeds the allowed sensitivity ceiling of ${governance.dependency_sensitivity_ceiling}.`,
          approval_chain: governance.approval_chain,
          action_url: `/catalog/assets/${encodeURIComponent(name)}/${version}/request-access`,
        };
      }
    }
  }

  return { allowed: true };
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
    consumer_id: "anonymous",
    sensitivity_ceiling: "public",
  };
}

// Parse consumer context from request headers (simplified – no real Entra ID in demo)
export function parseConsumerContext(headers: Record<string, string | string[] | undefined>): ConsumerContext {
  const consumerId = headers["x-consumer-id"];
  const ceiling = headers["x-sensitivity-ceiling"];

  return {
    consumer_id: typeof consumerId === "string" ? consumerId : "all-employees",
    sensitivity_ceiling:
      typeof ceiling === "string" && ceiling in TIER_ORDER
        ? (ceiling as SensitivityTier)
        : "internal",
  };
}
