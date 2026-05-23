import { describe, it, expect } from "vitest";

const CONTRACT_BASE_URL = process.env.CONTRACT_BASE_URL ?? "http://127.0.0.1:8080";
const CATALOG_RETRY_ATTEMPTS = 12;
const CATALOG_RETRY_DELAY_MS = 5000;

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function fetchWithRetry(url: string): Promise<Response> {
  let lastResponse: Response | null = null;
  let lastError: unknown;
  for (let attempt = 1; attempt <= CATALOG_RETRY_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.status === 200) {
        return response;
      }
      lastResponse = response;
    } catch (error) {
      lastError = error;
    }
    if (attempt < CATALOG_RETRY_ATTEMPTS) {
      await sleep(CATALOG_RETRY_DELAY_MS);
    }
  }
  if (lastResponse) {
    return lastResponse;
  }
  if (lastError instanceof Error) {
    throw new Error(`Request failed after retries: ${lastError.message}`);
  }
  throw new Error("Request failed after retries");
}

async function fetchCatalogWithRetry(): Promise<Response> {
  return fetchWithRetry(`${CONTRACT_BASE_URL}/api/catalog`);
}

describe("Gateway live contract", () => {
  it("GET /api/catalog returns 200 with parseable JSON and model affinity metadata", async () => {
    const res = await fetchCatalogWithRetry();
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      assets?: Array<{
        name?: string;
        modelAffinity?: {
          optimal_model?: string | null;
        };
      }>;
    };

    expect(Array.isArray(body.assets)).toBe(true);
    expect((body.assets ?? []).length).toBeGreaterThan(0);

    for (const asset of body.assets ?? []) {
      expect(typeof asset.name).toBe("string");
      expect(asset.modelAffinity).toBeDefined();
      expect(typeof asset.modelAffinity?.optimal_model).toBe("string");
      expect(asset.modelAffinity?.optimal_model?.trim().length).toBeGreaterThan(0);
    }
  });

  it("MCP endpoint contract responds to discovery and initialize", async () => {
    const infoResponse = await fetchWithRetry(`${CONTRACT_BASE_URL}/mcp`);
    expect(infoResponse.status).toBe(200);
    const info = (await infoResponse.json()) as { name?: string; protocol_version?: string };
    expect(info.name).toBe("aria-gateway");
    expect(typeof info.protocol_version).toBe("string");

    const initResponse = await fetch(`${CONTRACT_BASE_URL}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "contract-init",
        method: "initialize",
        params: {},
      }),
    });
    expect(initResponse.status).toBe(200);
    const initBody = (await initResponse.json()) as {
      result?: {
        protocolVersion?: string;
        serverInfo?: { name?: string };
      };
    };
    expect(typeof initBody.result?.protocolVersion).toBe("string");
    expect(initBody.result?.serverInfo?.name).toBe("aria-gateway");
  });
});
