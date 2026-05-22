import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  refreshCatalogAssets,
  resetCatalogProviderForTests,
  routeSkillRequest,
} from "../src/services/catalog.service.js";

function responseWithJson(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("model affinity routing", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.restoreAllMocks();
    resetCatalogProviderForTests();
    process.env = { ...originalEnv };
    process.env.NODE_ENV = "production";
    process.env.CATALOG_PROVIDER = "registry";
    process.env.CATALOG_REGISTRY_URL = "https://registry.example.com";
    process.env.CATALOG_REGISTRY_REPOSITORY = "aria/catalog";
    process.env.CATALOG_REGISTRY_REFERENCE = "stable";
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    resetCatalogProviderForTests();
  });

  it("selects the expected optimal model for the configured skill id", async () => {
    const testSkillId = process.env.TEST_SKILL_ID ?? "test/skill";
    const expectedModel = process.env.EXPECTED_MODEL ?? "gpt-4.1-mini";

    const registryAsset = {
      record: {
        name: "aria.dev/skills/model-routing-test",
        version: "1.0.0",
        schema_version: "1.0.0",
        description: "routing test asset",
        skills: [{ id: 1, name: testSkillId }],
        domains: [{ name: "engineering" }],
        modules: [{ type: "mcp_server", transport: "stdio", tools: ["run"] }],
        authors: ["Routing Team <routing@aria.dev>"],
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
        lifecycle_state: "published",
      },
      governance: {
        sensitivity_tier: "public",
      },
    };

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/manifests/stable")) {
        return responseWithJson({
          manifests: [
            {
              digest: "sha256:manifest-1",
              annotations: {
                "io.aria.asset": JSON.stringify(registryAsset),
                "io.aria.model-affinity.json": JSON.stringify({
                  [testSkillId]: expectedModel,
                }),
              },
            },
          ],
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    await refreshCatalogAssets();
    const routed = await routeSkillRequest(testSkillId);

    expect(routed.skillId).toBe(testSkillId);
    expect(routed.model).toBe(expectedModel);
  });
});
