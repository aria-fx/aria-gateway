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
const DEFAULT_FRESHNESS_SLA_P95_SECONDS = 300;
const DEFAULT_CATALOG_REGISTRY_URL = "https://ghcr.io";
const MAX_FRESHNESS_SAMPLES = 200;

export type CatalogProviderMode = "registry" | "sample";

interface CatalogProvider {
  getAssets(): Promise<CatalogAsset[]>;
  refreshAssets(): Promise<CatalogAsset[]>;
  getCacheMetrics(): CatalogCacheMetrics;
  resolveOptimalModelForSkill(skillId: string | number): Promise<string | null>;
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

export interface CatalogCacheMetrics {
  provider_mode: CatalogProviderMode;
  cache_ttl_seconds: number;
  staleness_window_seconds: number;
  freshness_sla_p95_seconds: number;
  p95_freshness_seconds: number | null;
  current_freshness_seconds: number | null;
  last_refresh_at: string | null;
  last_refresh_status: "never" | "ok" | "error";
  last_refresh_error: string | null;
  last_refresh_duration_ms: number | null;
  refresh_success_total: number;
  refresh_failure_total: number;
}

const CATALOG_ASSET_ANNOTATION_KEYS = [
  "io.aria.asset",
  "io.aria.catalog.asset",
  "org.opencontainers.image.description",
];
const MODEL_AFFINITY_ANNOTATION_KEYS = [
  "io.aria.model-affinity.json",
  "io.aria.model-affinity",
  "io.aria.model_affinity",
];

function normalizeSkillKey(skillId: string | number): string {
  return String(skillId).trim().toLowerCase();
}

function extractModelFromCandidate(candidate: unknown): string | null {
  if (typeof candidate === "string" && candidate.trim().length > 0) {
    return candidate.trim();
  }
  if (!candidate || typeof candidate !== "object") return null;
  const record = candidate as Record<string, unknown>;
  const model =
    record.model ??
    record.optimalModel ??
    record.optimal_model ??
    record.modelId ??
    record.model_id;
  return typeof model === "string" && model.trim().length > 0 ? model.trim() : null;
}

function parseModelAffinityAnnotation(
  annotations?: Record<string, string>
): Map<string, string> {
  const affinities = new Map<string, string>();
  if (!annotations) return affinities;

  for (const key of MODEL_AFFINITY_ANNOTATION_KEYS) {
    const raw = annotations[key];
    if (!raw) continue;
    const sizeBefore = affinities.size;
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) {
        for (const entry of parsed) {
          if (!entry || typeof entry !== "object") continue;
          const row = entry as Record<string, unknown>;
          const skill =
            typeof row.skillId === "string" || typeof row.skillId === "number"
              ? row.skillId
              : typeof row.skill === "string" || typeof row.skill === "number"
                ? row.skill
                : undefined;
          const model = extractModelFromCandidate(row);
          if (skill !== undefined && model) {
            affinities.set(normalizeSkillKey(skill), model);
          }
        }
      } else if (parsed && typeof parsed === "object") {
        for (const [skill, value] of Object.entries(parsed as Record<string, unknown>)) {
          const model = extractModelFromCandidate(value);
          if (model) {
            affinities.set(normalizeSkillKey(skill), model);
          }
        }
      }
    } catch {
      // ignore malformed annotation and try other keys
    }
    if (affinities.size > sizeBefore) break;
  }

  return affinities;
}

function isLocalDevelopment(): boolean {
  return process.env.NODE_ENV === "development" || process.env.NODE_ENV === "test";
}

function isSampleModeEnabled(): boolean {
  return process.env.CATALOG_SAMPLE_MODE === "true";
}

function resolvePositiveSeconds(value: string | undefined, fallback: number): number {
  const seconds = Number(value ?? fallback);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return fallback;
  }
  return seconds;
}

function resolveCacheTtlSeconds(): number {
  return resolvePositiveSeconds(process.env.CATALOG_CACHE_TTL_SECONDS, DEFAULT_CACHE_TTL_SECONDS);
}

function resolveFreshnessSlaP95Seconds(): number {
  return resolvePositiveSeconds(
    process.env.CATALOG_FRESHNESS_SLA_P95_SECONDS,
    DEFAULT_FRESHNESS_SLA_P95_SECONDS
  );
}

function toP95(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.floor(sorted.length * 0.95);
  return sorted[Math.min(sorted.length - 1, Math.max(0, index))];
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

function buildRegistryHeaders(accept: string, forceBasicAuth = false): Record<string, string> {
  const headers: Record<string, string> = { Accept: accept };
  const token = process.env.CATALOG_REGISTRY_TOKEN;
  if (token) {
    if (forceBasicAuth) {
      const username = process.env.CATALOG_REGISTRY_USERNAME ?? "x-access-token";
      headers.Authorization = `Basic ${Buffer.from(`${username}:${token}`).toString("base64")}`;
    } else {
      headers.Authorization = `Bearer ${token}`;
    }
  }
  return headers;
}

async function fetchJson<T>(url: string, accept: string): Promise<T> {
  let response = await fetch(url, { headers: buildRegistryHeaders(accept) });
  if (response.status === 401 && process.env.CATALOG_REGISTRY_TOKEN) {
    response = await fetch(url, { headers: buildRegistryHeaders(accept, true) });
  }
  if (!response.ok) {
    throw new Error(`Catalog registry request failed (${response.status}): ${url}`);
  }
  return (await response.json()) as T;
}

class SampleCatalogProvider implements CatalogProvider {
  async getAssets(): Promise<CatalogAsset[]> {
    return sampleAssets;
  }

  async refreshAssets(): Promise<CatalogAsset[]> {
    return sampleAssets;
  }

  getCacheMetrics(): CatalogCacheMetrics {
    const ttlSeconds = resolveCacheTtlSeconds();
    return {
      provider_mode: "sample",
      cache_ttl_seconds: ttlSeconds,
      staleness_window_seconds: ttlSeconds,
      freshness_sla_p95_seconds: resolveFreshnessSlaP95Seconds(),
      p95_freshness_seconds: 0,
      current_freshness_seconds: 0,
      last_refresh_at: null,
      last_refresh_status: "never",
      last_refresh_error: null,
      last_refresh_duration_ms: null,
      refresh_success_total: 0,
      refresh_failure_total: 0,
    };
  }

  async resolveOptimalModelForSkill(_skillId: string | number): Promise<string | null> {
    return null;
  }
}

class RegistryCatalogProvider implements CatalogProvider {
  private cache: CatalogAsset[] | null = null;

  private cacheExpiresAt = 0;

  private inflightLoad?: Promise<CatalogAsset[]>;

  private refreshSuccessTotal = 0;

  private refreshFailureTotal = 0;

  private lastRefreshAt = 0;

  private lastRefreshStatus: "never" | "ok" | "error" = "never";

  private lastRefreshError: string | null = null;

  private lastRefreshDurationMs: number | null = null;

  private freshnessSamplesSeconds: number[] = [];

  private modelAffinityBySkill = new Map<string, string>();

  async getAssets(): Promise<CatalogAsset[]> {
    const now = Date.now();
    if (this.cache && now < this.cacheExpiresAt) {
      this.observeFreshness(now);
      return this.cache;
    }

    if (!this.inflightLoad) {
      this.inflightLoad = this.loadAndCacheAssets();
    }

    const assets = await this.inflightLoad;
    this.observeFreshness();
    return assets;
  }

  async refreshAssets(): Promise<CatalogAsset[]> {
    this.cacheExpiresAt = 0;
    if (!this.inflightLoad) {
      this.inflightLoad = this.loadAndCacheAssets();
    }
    const assets = await this.inflightLoad;
    this.observeFreshness();
    return assets;
  }

  getCacheMetrics(): CatalogCacheMetrics {
    const now = Date.now();
    const ttlSeconds = resolveCacheTtlSeconds();
    const currentFreshnessSeconds =
      this.lastRefreshAt > 0 ? Math.max(0, (now - this.lastRefreshAt) / 1000) : null;
    return {
      provider_mode: "registry",
      cache_ttl_seconds: ttlSeconds,
      staleness_window_seconds: ttlSeconds,
      freshness_sla_p95_seconds: resolveFreshnessSlaP95Seconds(),
      p95_freshness_seconds: toP95(this.freshnessSamplesSeconds),
      current_freshness_seconds: currentFreshnessSeconds,
      last_refresh_at: this.lastRefreshAt > 0 ? new Date(this.lastRefreshAt).toISOString() : null,
      last_refresh_status: this.lastRefreshStatus,
      last_refresh_error: this.lastRefreshError,
      last_refresh_duration_ms: this.lastRefreshDurationMs,
      refresh_success_total: this.refreshSuccessTotal,
      refresh_failure_total: this.refreshFailureTotal,
    };
  }

  async resolveOptimalModelForSkill(skillId: string | number): Promise<string | null> {
    await this.getAssets();
    return this.modelAffinityBySkill.get(normalizeSkillKey(skillId)) ?? null;
  }

  private observeFreshness(now = Date.now()): void {
    if (!this.lastRefreshAt) return;
    const freshnessSeconds = Math.max(0, (now - this.lastRefreshAt) / 1000);
    this.freshnessSamplesSeconds.push(freshnessSeconds);
    if (this.freshnessSamplesSeconds.length > MAX_FRESHNESS_SAMPLES) {
      this.freshnessSamplesSeconds.shift();
    }
  }

  private async loadAndCacheAssets(): Promise<CatalogAsset[]> {
    const startedAt = Date.now();
    try {
      const assets = await this.loadAssetsFromRegistry();
      const ttlSeconds = resolveCacheTtlSeconds();
      this.cache = assets;
      this.cacheExpiresAt = Date.now() + ttlSeconds * 1000;
      this.refreshSuccessTotal += 1;
      this.lastRefreshAt = Date.now();
      this.lastRefreshStatus = "ok";
      this.lastRefreshError = null;
      this.lastRefreshDurationMs = Date.now() - startedAt;
      this.observeFreshness(this.lastRefreshAt);
      return assets;
    } catch (error) {
      this.refreshFailureTotal += 1;
      this.lastRefreshStatus = "error";
      this.lastRefreshError = error instanceof Error ? error.message : String(error);
      this.lastRefreshDurationMs = Date.now() - startedAt;
      throw error;
    } finally {
      this.inflightLoad = undefined;
    }
  }

  private async loadAssetsFromRegistry(): Promise<CatalogAsset[]> {
    const registry = (process.env.CATALOG_REGISTRY_URL ?? DEFAULT_CATALOG_REGISTRY_URL).replace(
      /\/+$/,
      ""
    );
    const repository = process.env.CATALOG_REGISTRY_REPOSITORY ?? "aria-fx/aria-assets";
    const reference = process.env.CATALOG_REGISTRY_REFERENCE ?? "latest";

    const indexUrl = `${registry}/v2/${repository}/manifests/${reference}`;
    const index = await fetchJson<RegistryIndex>(indexUrl, OCI_INDEX_MEDIA_TYPE);
    const manifests = index.manifests ?? [];
    const modelAffinityBySkill = new Map<string, string>();
    const manifestAssets = await Promise.all(
      manifests.map(async (descriptor) => {
        const affinities = parseModelAffinityAnnotation(descriptor.annotations);
        for (const [skill, model] of affinities.entries()) {
          modelAffinityBySkill.set(skill, model);
        }

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

    this.modelAffinityBySkill = modelAffinityBySkill;
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

  async refreshAssets(): Promise<CatalogAsset[]> {
    try {
      return await this.registryProvider.refreshAssets();
    } catch (error) {
      if (isLocalDevelopment() && isSampleModeEnabled()) {
        return this.sampleProvider.refreshAssets();
      }
      throw error;
    }
  }

  getCacheMetrics(): CatalogCacheMetrics {
    return this.registryProvider.getCacheMetrics();
  }

  async resolveOptimalModelForSkill(skillId: string | number): Promise<string | null> {
    try {
      return await this.registryProvider.resolveOptimalModelForSkill(skillId);
    } catch (error) {
      if (isLocalDevelopment() && isSampleModeEnabled()) {
        return this.sampleProvider.resolveOptimalModelForSkill(skillId);
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

export async function refreshCatalogAssets(): Promise<CatalogCacheMetrics> {
  if (!providerInstance) {
    providerInstance = createCatalogProvider();
  }
  await providerInstance.refreshAssets();
  return providerInstance.getCacheMetrics();
}

export function getCatalogCacheMetrics(): CatalogCacheMetrics {
  if (!providerInstance) {
    providerInstance = createCatalogProvider();
  }
  return providerInstance.getCacheMetrics();
}

export async function resolveOptimalModelForSkill(skillId: string | number): Promise<string | null> {
  if (!providerInstance) {
    providerInstance = createCatalogProvider();
  }
  return providerInstance.resolveOptimalModelForSkill(skillId);
}

export async function routeSkillRequest(
  skillId: string | number
): Promise<{ skillId: string; model: string | null }> {
  const model = await resolveOptimalModelForSkill(skillId);
  return {
    skillId: String(skillId),
    model,
  };
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
    modelAffinity: {
      optimal_model: null,
    },
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
