import type {
  CatalogAsset,
  AssetListItem,
  AssetManifest,
  TrustBadge,
  SensitivityTier,
} from "../models/oasf.js";
import { sampleAssets } from "../data/sample-assets.js";

const ASSET_BASE_URL = process.env.API_BASE_URL ?? "http://localhost:3001";

function resolveTrustBadge(asset: CatalogAsset): TrustBadge {
  const tier = asset.governance.sensitivity_tier;
  const frameworks = asset.governance.compliance_frameworks ?? [];

  if (tier === "public") return "public";
  if (tier === "highly_confidential") return "restricted";
  if (frameworks.includes("HIPAA") || frameworks.includes("SOX")) {
    return "approved-security";
  }
  if (tier === "confidential") return "approved-it";
  return "internal-use";
}

function toListItem(asset: CatalogAsset): AssetListItem {
  return {
    name: asset.record.name,
    version: asset.record.version,
    description: asset.record.description,
    lifecycle_state: asset.record.lifecycle_state,
    sensitivity_tier: asset.governance.sensitivity_tier,
    domains: asset.record.domains.map((d) => d.name),
    skills: asset.record.skills.map((s) => s.name),
    trust_badge: resolveTrustBadge(asset),
    tags: asset.record.tags ?? [],
    authors: asset.record.authors,
    updated_at: asset.record.updated_at,
  };
}

export interface CatalogFilters {
  skill?: string;
  domain?: string;
  keyword?: string;
  state?: string;
  sensitivity?: SensitivityTier;
}

export function listAssets(filters: CatalogFilters = {}): AssetListItem[] {
  let assets = sampleAssets.filter(
    (a) => a.record.lifecycle_state === "published"
  );

  if (filters.state) {
    assets = sampleAssets.filter((a) => a.record.lifecycle_state === filters.state);
  }

  if (filters.skill) {
    const term = filters.skill.toLowerCase();
    assets = assets.filter((a) =>
      a.record.skills.some((s) => s.name.toLowerCase().includes(term))
    );
  }

  if (filters.domain) {
    const term = filters.domain.toLowerCase();
    assets = assets.filter((a) =>
      a.record.domains.some((d) => d.name.toLowerCase().includes(term))
    );
  }

  if (filters.keyword) {
    const term = filters.keyword.toLowerCase();
    assets = assets.filter(
      (a) =>
        a.record.name.toLowerCase().includes(term) ||
        a.record.description.toLowerCase().includes(term) ||
        (a.record.tags ?? []).some((t) => t.toLowerCase().includes(term))
    );
  }

  if (filters.sensitivity) {
    assets = assets.filter(
      (a) => a.governance.sensitivity_tier === filters.sensitivity
    );
  }

  return assets.map(toListItem);
}

export function getAssetVersions(name: string): string[] {
  return sampleAssets
    .filter((a) => a.record.name === name)
    .map((a) => a.record.version)
    .sort((a, b) => b.localeCompare(a));
}

export function getAssetManifest(
  name: string,
  version: string
): AssetManifest | null {
  const asset = sampleAssets.find(
    (a) => a.record.name === name && a.record.version === version
  );
  if (!asset) return null;

  const hasMcpServer = asset.record.modules.some((m) => m.type === "mcp_server");
  const encodedName = encodeURIComponent(name);

  return {
    record: asset.record,
    governance: asset.governance,
    install_url: `${ASSET_BASE_URL}/catalog/assets/${encodedName}/${version}/install`,
    mcpb_url: hasMcpServer
      ? `${ASSET_BASE_URL}/catalog/assets/${encodedName}/${version}/mcpb`
      : null,
  };
}

export function getAllPublishedAssets(): CatalogAsset[] {
  return sampleAssets.filter((a) => a.record.lifecycle_state === "published");
}
