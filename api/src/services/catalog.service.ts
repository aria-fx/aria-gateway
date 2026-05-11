import type {
  CatalogAsset,
  AssetListItem,
  AssetManifest,
  TrustBadge,
  SensitivityTier,
} from "../models/oasf.js";
import { sampleAssets } from "../data/sample-assets.js";

const ASSET_BASE_URL = process.env.API_BASE_URL ?? "http://localhost:3001";
const OCI_INDEX_MEDIA_TYPE = "application/vnd.oci.image.index.v1+json";
const OCI_MANIFEST_MEDIA_TYPE = "application/vnd.oci.image.manifest.v1+json";
const DEFAULT_CACHE_TTL_SECONDS = 300;

export type CatalogProviderMode = "registry" | "sample";

interface CatalogProvider {
  getAssets(): Promise<CatalogAsset[]>;
}

interface RegistryIndexManifest {
  digest?: string;
  annotations?: Record<string, string>;
}

interface RegistryIndex {
  manifests?: RegistryIndexManifest[];
}

interface RegistryManifest {
  config?: {
    digest?: string;
  };
}

const CATALOG_ASSET_ANNOTATION_KEYS = [
  "io.aria.asset",
  "io.aria.catalog.asset",
  "org.opencontainers.image.description",
];

function isLocalDevelopment(): boolean {
  return process.env.NODE_ENV === "development" || process.env.NODE_ENV === "test";
}

function isSampleModeEnabled(): boolean {
  return process.env.CATALOG_SAMPLE_MODE === "true";
}

export function resolveCatalogProviderMode(): CatalogProviderMode {
  if (process.env.CATALOG_PROVIDER === "sample") {
    return isLocalDevelopment() && isSampleModeEnabled() ? "sample" : "registry";
  }
  return "registry";
}

function isCatalogAsset(candidate: unknown): candidate is CatalogAsset {
  if (!candidate || typeof candidate !== "object") return false;
  const maybe = candidate as Partial<CatalogAsset>;
  return Boolean(maybe.record?.name && maybe.record?.version && maybe.governance?.sensitivity_tier);
}

function parseAssetAnnotation(annotations?: Record<string, string>): CatalogAsset | null {
  if (!annotations) return null;
  for (const key of CATALOG_ASSET_ANNOTATION_KEYS) {
    const raw = annotations[key];
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (isCatalogAsset(parsed)) {
        return parsed;
      }
    } catch {
      // ignore malformed annotation and try other keys
    }
  }
  return null;
}

function extractAssetsFromBlob(blob: unknown): CatalogAsset[] {
  if (isCatalogAsset(blob)) {
    return [blob];
  }
  if (Array.isArray(blob)) {
    return blob.filter(isCatalogAsset);
  }
  if (
    blob &&
    typeof blob === "object" &&
    "assets" in blob &&
    Array.isArray((blob as { assets: unknown[] }).assets)
  ) {
    return (blob as { assets: unknown[] }).assets.filter(isCatalogAsset);
  }
  return [];
}

function buildRegistryHeaders(accept: string): Record<string, string> {
  const headers: Record<string, string> = { Accept: accept };
  const token = process.env.CATALOG_REGISTRY_TOKEN;
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

async function fetchJson<T>(url: string, accept: string): Promise<T> {
  const response = await fetch(url, { headers: buildRegistryHeaders(accept) });
  if (!response.ok) {
    throw new Error(`Catalog registry request failed (${response.status}): ${url}`);
  }
  return (await response.json()) as T;
}

class SampleCatalogProvider implements CatalogProvider {
  async getAssets(): Promise<CatalogAsset[]> {
    return sampleAssets;
  }
}

class RegistryCatalogProvider implements CatalogProvider {
  private cache: CatalogAsset[] | null = null;

  private cacheExpiresAt = 0;

  private inflightLoad?: Promise<CatalogAsset[]>;

  async getAssets(): Promise<CatalogAsset[]> {
    const now = Date.now();
    if (this.cache && now < this.cacheExpiresAt) {
      return this.cache;
    }

    if (!this.inflightLoad) {
      this.inflightLoad = this.loadAssetsFromRegistry()
        .then((assets) => {
          const ttlSeconds = Number(process.env.CATALOG_CACHE_TTL_SECONDS ?? DEFAULT_CACHE_TTL_SECONDS);
          const cacheTtl =
            Number.isFinite(ttlSeconds) && ttlSeconds > 0
              ? ttlSeconds
              : DEFAULT_CACHE_TTL_SECONDS;
          this.cache = assets;
          this.cacheExpiresAt = Date.now() + cacheTtl * 1000;
          return assets;
        })
        .finally(() => {
          this.inflightLoad = undefined;
        });
    }

    return this.inflightLoad;
  }

  private async loadAssetsFromRegistry(): Promise<CatalogAsset[]> {
    const registry = (process.env.CATALOG_REGISTRY_URL ?? "https://ghcr.io").replace(/\/+$/, "");
    const repository = process.env.CATALOG_REGISTRY_REPOSITORY ?? "aria-fx/aria-assets/catalog";
    const reference = process.env.CATALOG_REGISTRY_REFERENCE ?? "latest";

    const indexUrl = `${registry}/v2/${repository}/manifests/${reference}`;
    const index = await fetchJson<RegistryIndex>(indexUrl, OCI_INDEX_MEDIA_TYPE);
    const manifests = index.manifests ?? [];
    const manifestAssets = await Promise.all(
      manifests.map(async (descriptor) => {
        const fromAnnotation = parseAssetAnnotation(descriptor.annotations);
        if (fromAnnotation) {
          return [fromAnnotation];
        }

        if (!descriptor.digest) return [];
        const manifestUrl = `${registry}/v2/${repository}/manifests/${descriptor.digest}`;
        const manifest = await fetchJson<RegistryManifest>(manifestUrl, OCI_MANIFEST_MEDIA_TYPE);
        const configDigest = manifest.config?.digest;
        if (!configDigest) return [];

        const configUrl = `${registry}/v2/${repository}/blobs/${configDigest}`;
        const blob = await fetchJson<unknown>(configUrl, "application/json");
        return extractAssetsFromBlob(blob);
      })
    );

    return manifestAssets.flat();
  }
}

class RegistryWithSampleFallbackProvider implements CatalogProvider {
  constructor(
    private readonly registryProvider: RegistryCatalogProvider,
    private readonly sampleProvider: SampleCatalogProvider
  ) {}

  async getAssets(): Promise<CatalogAsset[]> {
    try {
      return await this.registryProvider.getAssets();
    } catch (error) {
      if (isLocalDevelopment() && isSampleModeEnabled()) {
        return this.sampleProvider.getAssets();
      }
      throw error;
    }
  }
}

let providerInstance: CatalogProvider | null = null;

function createCatalogProvider(): CatalogProvider {
  if (resolveCatalogProviderMode() === "sample") {
    return new SampleCatalogProvider();
  }
  return new RegistryWithSampleFallbackProvider(
    new RegistryCatalogProvider(),
    new SampleCatalogProvider()
  );
}

async function getCatalogAssets(): Promise<CatalogAsset[]> {
  if (!providerInstance) {
    providerInstance = createCatalogProvider();
  }
  return providerInstance.getAssets();
}

export function resetCatalogProviderForTests(): void {
  providerInstance = null;
}

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

function listAssetsFromSource(
  source: CatalogAsset[],
  filters: CatalogFilters = {}
): AssetListItem[] {
  let assets = source.filter(
    (a) => a.record.lifecycle_state === "published"
  );

  if (filters.state) {
    assets = source.filter((a) => a.record.lifecycle_state === filters.state);
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

export async function listAssets(filters: CatalogFilters = {}): Promise<AssetListItem[]> {
  const assets = await getCatalogAssets();
  return listAssetsFromSource(assets, filters);
}

export async function getAssetVersions(name: string): Promise<string[]> {
  const assets = await getCatalogAssets();
  return assets
    .filter((a) => a.record.name === name)
    .map((a) => a.record.version)
    .sort((a, b) => b.localeCompare(a));
}

export async function getAssetManifest(
  name: string,
  version: string
): Promise<AssetManifest | null> {
  const assets = await getCatalogAssets();
  const asset = assets.find(
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

export async function getAllAssets(): Promise<CatalogAsset[]> {
  return getCatalogAssets();
}

export async function getAllPublishedAssets(): Promise<CatalogAsset[]> {
  const assets = await getCatalogAssets();
  return assets.filter((a) => a.record.lifecycle_state === "published");
}
