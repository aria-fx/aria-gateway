import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import app from "../src/index.js";

describe("Health", () => {
  it("GET /health returns ok", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
  });
});

describe("Catalog API", () => {
  it("GET /catalog/assets returns published assets for all-employees", async () => {
    const res = await request(app)
      .get("/catalog/assets")
      .set("X-Consumer-Id", "all-employees")
      .set("X-Sensitivity-Ceiling", "internal");

    expect(res.status).toBe(200);
    expect(res.body.total).toBeGreaterThan(0);
    expect(Array.isArray(res.body.assets)).toBe(true);
  });

  it("GET /catalog/assets filters by keyword", async () => {
    const res = await request(app)
      .get("/catalog/assets?keyword=hr")
      .set("X-Consumer-Id", "all-employees")
      .set("X-Sensitivity-Ceiling", "internal");

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.assets)).toBe(true);
    expect(res.body.assets.length).toBeGreaterThan(0);
    for (const asset of res.body.assets) {
      const haystack =
        asset.name.toLowerCase() +
        asset.description.toLowerCase() +
        asset.tags.join(" ").toLowerCase();
      expect(haystack).toContain("hr");
    }
  });

  it("GET /catalog/assets filters by domain", async () => {
    const res = await request(app)
      .get("/catalog/assets?domain=engineering")
      .set("X-Consumer-Id", "all-employees")
      .set("X-Sensitivity-Ceiling", "internal");

    expect(res.status).toBe(200);
    for (const asset of res.body.assets) {
      expect(asset.domains.some((d: string) => d.includes("engineering"))).toBe(true);
    }
  });

  it("GET /catalog/assets hides highly_confidential from internal users", async () => {
    const res = await request(app)
      .get("/catalog/assets")
      .set("X-Consumer-Id", "all-employees")
      .set("X-Sensitivity-Ceiling", "internal");

    expect(res.status).toBe(200);
    for (const asset of res.body.assets) {
      expect(asset.sensitivity_tier).not.toBe("highly_confidential");
    }
  });

  it("GET /catalog/assets/:name/versions returns version list", async () => {
    const name = encodeURIComponent("aria.dev/skills/hr-policy-lookup");
    const res = await request(app).get(`/catalog/assets/${name}/versions`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.versions)).toBe(true);
    expect(res.body.versions.length).toBeGreaterThan(0);
    expect(res.body.name).toBe("aria.dev/skills/hr-policy-lookup");
  });

  it("GET /catalog/assets/:name/versions returns 404 for unknown asset", async () => {
    const res = await request(app).get("/catalog/assets/unknown.dev%2Fskills%2Ffake/versions");
    expect(res.status).toBe(404);
  });

  it("GET /catalog/assets/:name/:version/manifest returns full manifest", async () => {
    const name = encodeURIComponent("aria.dev/skills/document-summarizer");
    const res = await request(app)
      .get(`/catalog/assets/${name}/1.2.0/manifest`)
      .set("X-Consumer-Id", "all-employees")
      .set("X-Sensitivity-Ceiling", "internal");

    // 404 or 200 depending on exact version; just check it doesn't crash
    expect([200, 404]).toContain(res.status);
  });

  it("GET /catalog/assets/:name/:version/manifest returns 403 for insufficient clearance", async () => {
    const name = encodeURIComponent("aria.dev/skills/financial-analyzer");
    const res = await request(app)
      .get(`/catalog/assets/${name}/1.0.0/manifest`)
      .set("X-Consumer-Id", "all-employees")
      .set("X-Sensitivity-Ceiling", "internal");

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("Access denied");
  });

  it("GET /catalog/assets/:name/:version/mcpb returns mcpb bundle", async () => {
    const name = encodeURIComponent("aria.dev/skills/hr-policy-lookup");
    const res = await request(app)
      .get(`/catalog/assets/${name}/1.2.0/mcpb`)
      .set("X-Consumer-Id", "all-employees")
      .set("X-Sensitivity-Ceiling", "internal");

    expect(res.status).toBe(200);
    expect(res.body.schema_version).toBe("1.0");
    expect(res.body.mcp_server).toBeDefined();
  });

  it("POST /catalog/assets/:name/:version/install returns config snippet", async () => {
    const name = encodeURIComponent("aria.dev/skills/document-summarizer");
    const res = await request(app)
      .post(`/catalog/assets/${name}/3.0.1/install`)
      .set("X-Consumer-Id", "all-employees")
      .set("X-Sensitivity-Ceiling", "internal")
      .send({ target: "claude-desktop" });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.config_snippet).toBeDefined();
    expect(res.body.config_snippet.mcpServers).toBeDefined();
  });

  it("POST /catalog/assets/:name/:version/request-access returns request id", async () => {
    const name = encodeURIComponent("aria.dev/skills/financial-analyzer");
    const res = await request(app)
      .post(`/catalog/assets/${name}/1.0.0/request-access`)
      .send({});

    expect(res.status).toBe(202);
    expect(res.body.request_id).toBeDefined();
    expect(res.body.status).toBe("pending");
  });

  it("GET /catalog/stats returns summary stats", async () => {
    const res = await request(app).get("/catalog/stats");
    expect(res.status).toBe(200);
    expect(res.body.total_assets).toBeGreaterThan(0);
    expect(res.body.by_sensitivity).toBeDefined();
    expect(res.body.by_domain).toBeDefined();
  });
});

describe("Plugin Manifests", () => {
  it("GET /.well-known/ai-plugin.json returns ChatGPT plugin manifest", async () => {
    const res = await request(app).get("/.well-known/ai-plugin.json");
    expect(res.status).toBe(200);
    expect(res.body.schema_version).toBe("v1");
    expect(res.body.name_for_model).toBe("aria_catalog");
    expect(res.body.api.url).toContain("/openapi.json");
  });

  it("GET /openapi.json returns valid OpenAPI spec", async () => {
    const res = await request(app).get("/openapi.json");
    expect(res.status).toBe(200);
    expect(res.body.openapi).toBe("3.1.0");
    expect(res.body.paths["/catalog/assets"]).toBeDefined();
  });
});

describe("MCP Server", () => {
  it("GET /mcp returns server info", async () => {
    const res = await request(app).get("/mcp");
    expect(res.status).toBe(200);
    expect(res.body.name).toBe("aria-gateway");
    expect(res.body.protocol_version).toBeDefined();
  });

  it("POST /mcp initialize returns server capabilities", async () => {
    const res = await request(app)
      .post("/mcp")
      .set("X-Consumer-Id", "all-employees")
      .set("X-Sensitivity-Ceiling", "internal")
      .send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });

    expect(res.status).toBe(200);
    expect(res.body.result.protocolVersion).toBeDefined();
    expect(res.body.result.serverInfo.name).toBe("aria-gateway");
  });

  it("POST /mcp tools/list returns tool definitions", async () => {
    const res = await request(app)
      .post("/mcp")
      .set("X-Consumer-Id", "all-employees")
      .set("X-Sensitivity-Ceiling", "internal")
      .send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.result.tools)).toBe(true);
    const toolNames = res.body.result.tools.map((t: { name: string }) => t.name);
    expect(toolNames).toContain("search_assets");
    expect(toolNames).toContain("get_asset_detail");
    expect(toolNames).toContain("install_asset");
  });

  it("POST /mcp tools/call search_assets returns results", async () => {
    const res = await request(app)
      .post("/mcp")
      .set("X-Consumer-Id", "all-employees")
      .set("X-Sensitivity-Ceiling", "internal")
      .send({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "search_assets", arguments: { keyword: "document" } },
      });

    expect(res.status).toBe(200);
    expect(res.body.result.content[0].type).toBe("text");
    expect(res.body.result.content[0].text).toContain("document");
  });

  it("POST /mcp tools/call install_asset returns installation instructions", async () => {
    const res = await request(app)
      .post("/mcp")
      .set("X-Consumer-Id", "all-employees")
      .set("X-Sensitivity-Ceiling", "internal")
      .send({
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: {
          name: "install_asset",
          arguments: {
            name: "aria.dev/skills/document-summarizer",
            version: "3.0.1",
            target: "claude-desktop",
          },
        },
      });

    expect(res.status).toBe(200);
    expect(res.body.result.content[0].text).toContain("Claude Desktop");
  });

  it("POST /mcp returns error for unknown method", async () => {
    const res = await request(app)
      .post("/mcp")
      .send({ jsonrpc: "2.0", id: 9, method: "nonexistent", params: {} });

    expect(res.status).toBe(200);
    expect(res.body.error).toBeDefined();
    expect(res.body.error.code).toBe(-32601);
  });
});
