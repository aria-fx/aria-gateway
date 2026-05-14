import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sampleAssets } from "../src/data/sample-assets.js";
import {
  getAllAssets,
  getCatalogCacheMetrics,
  refreshCatalogAssets,
  resetCatalogProviderForTests,
  resolveCatalogProviderMode,
} from "../src/services/catalog.service.js";

function responseWithJson(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function buildPublishedAsset(name: string, version: string) {
  return {
    record: {
      name,
      version,
      schema_version: "1.0.0",
      description: "registry asset",
      skills: [{ id: 1, name: "test/skill" }],
      domains: [{ name: "engineering" }],
      modules: [{ type: "mcp_server", transport: "stdio", tools: ["run"] }],
      authors: ["Registry Team <registry@aria.dev>"],
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
      lifecycle_state: "published",
      tags: ["registry"],
    },
    governance: {
      sensitivity_tier: "public",
      allowed_consumers: ["all-employees"],
    },
  };
}

describe("catalog provider selection", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.restoreAllMocks();
    resetCatalogProviderForTests();
    process.env = { ...originalEnv };
    delete process.env.CATALOG_PROVIDER;
    delete process.env.CATALOG_SAMPLE_MODE;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    resetCatalogProviderForTests();
  });

  it("uses sample provider only when sample mode is explicitly enabled in development", () => {
    process.env.NODE_ENV = "development";
    process.env.CATALOG_PROVIDER = "sample";
    process.env.CATALOG_SAMPLE_MODE = "true";

    expect(resolveCatalogProviderMode()).toBe("sample");
  });

  it("disables sample provider outside local development", () => {
    process.env.NODE_ENV = "production";
    process.env.CATALOG_PROVIDER = "sample";
    process.env.CATALOG_SAMPLE_MODE = "true";

    expect(resolveCatalogProviderMode()).toBe("registry");
  });

  it("falls back to sample assets when registry fetch fails in local development sample mode", async () => {
    process.env.NODE_ENV = "development";
    process.env.CATALOG_SAMPLE_MODE = "true";
    process.env.CATALOG_PROVIDER = "registry";

    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("registry unavailable"));

    const assets = await getAllAssets();
    expect(assets).toEqual(sampleAssets);
  });

  it("does not fall back to sample assets outside local development", async () => {
    process.env.NODE_ENV = "production";
    process.env.CATALOG_SAMPLE_MODE = "true";
    process.env.CATALOG_PROVIDER = "registry";

    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("registry unavailable"));

    await expect(getAllAssets()).rejects.toThrow("registry unavailable");
  });

  it("caches registry-backed assets within the configured ttl", async () => {
    process.env.NODE_ENV = "production";
    process.env.CATALOG_PROVIDER = "registry";
    process.env.CATALOG_REGISTRY_URL = "https://registry.example.com";
    process.env.CATALOG_REGISTRY_REPOSITORY = "aria/catalog";
    process.env.CATALOG_REGISTRY_REFERENCE = "stable";
    process.env.CATALOG_CACHE_TTL_SECONDS = "300";

    const registryAsset = buildPublishedAsset("aria.dev/skills/registry-backed", "1.0.0");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/manifests/stable")) {
        return responseWithJson({
          manifests: [{ digest: "sha256:manifest-1" }],
        });
      }
      if (url.endsWith("/manifests/sha256:manifest-1")) {
        return responseWithJson({
          config: { digest: "sha256:config-1" },
        });
      }
      if (url.endsWith("/blobs/sha256:config-1")) {
        return responseWithJson(registryAsset);
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    const first = await getAllAssets();
    const second = await getAllAssets();

    expect(first).toEqual([registryAsset]);
    expect(second).toEqual([registryAsset]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("forces refresh and invalidates cached metadata before ttl expiry", async () => {
    process.env.NODE_ENV = "production";
    process.env.CATALOG_PROVIDER = "registry";
    process.env.CATALOG_REGISTRY_URL = "https://registry.example.com";
    process.env.CATALOG_REGISTRY_REPOSITORY = "aria/catalog";
    process.env.CATALOG_REGISTRY_REFERENCE = "stable";
    process.env.CATALOG_CACHE_TTL_SECONDS = "300";
    process.env.CATALOG_FRESHNESS_SLA_P95_SECONDS = "300";

    const firstAsset = buildPublishedAsset("aria.dev/skills/registry-backed", "1.0.0");
    const secondAsset = buildPublishedAsset("aria.dev/skills/registry-backed", "2.0.0");
    let activeAsset = firstAsset;

    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/manifests/stable")) {
        return responseWithJson({
          manifests: [{ digest: "sha256:manifest-1" }],
        });
      }
      if (url.endsWith("/manifests/sha256:manifest-1")) {
        return responseWithJson({
          config: { digest: "sha256:config-1" },
        });
      }
      if (url.endsWith("/blobs/sha256:config-1")) {
        return responseWithJson(activeAsset);
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    const first = await getAllAssets();
    const second = await getAllAssets();
    activeAsset = secondAsset;

    await refreshCatalogAssets();
    const afterRefresh = await getAllAssets();
    const metrics = getCatalogCacheMetrics();

    expect(first).toEqual([firstAsset]);
    expect(second).toEqual([firstAsset]);
    expect(afterRefresh).toEqual([secondAsset]);
    expect(fetchMock).toHaveBeenCalledTimes(6);
    expect(metrics.staleness_window_seconds).toBe(300);
    expect(metrics.refresh_success_total).toBeGreaterThanOrEqual(2);
    expect(metrics.p95_freshness_seconds).not.toBeNull();
    expect(metrics.p95_freshness_seconds!).toBeLessThanOrEqual(metrics.freshness_sla_p95_seconds);
  });

  it("tracks refresh failures in cache freshness metrics", async () => {
    process.env.NODE_ENV = "production";
    process.env.CATALOG_PROVIDER = "registry";
    process.env.CATALOG_REGISTRY_URL = "https://registry.example.com";
    process.env.CATALOG_REGISTRY_REPOSITORY = "aria/catalog";
    process.env.CATALOG_REGISTRY_REFERENCE = "stable";

    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("registry unavailable"));

    await expect(refreshCatalogAssets()).rejects.toThrow("registry unavailable");

    const metrics = getCatalogCacheMetrics();
    expect(metrics.last_refresh_status).toBe("error");
    expect(metrics.last_refresh_error).toContain("registry unavailable");
    expect(metrics.refresh_failure_total).toBe(1);
  });
});
