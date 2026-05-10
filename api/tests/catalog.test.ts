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
  it("GET /catalog/assets returns published public assets when unauthenticated", async () => {
    const res = await request(app).get("/catalog/assets");

    expect(res.status).toBe(200);
    expect(res.body.total).toBeGreaterThan(0);
    expect(Array.isArray(res.body.assets)).toBe(true);
    // Unauthenticated requests receive public-only context; only public-tier
    // assets should be visible.
    for (const asset of res.body.assets) {
      expect(asset.sensitivity_tier).toBe("public");
    }
  });

  it("GET /catalog/assets filters by query parameter 'q' for public assets", async () => {
    const res = await request(app).get("/catalog/assets?q=code");

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.assets)).toBe(true);
    expect(res.body.assets.length).toBeGreaterThan(0);
    for (const asset of res.body.assets) {
      const haystack =
        asset.name.toLowerCase() +
        asset.description.toLowerCase() +
        asset.tags.join(" ").toLowerCase();
      expect(haystack).toContain("code");
    }
  });

  it("GET /catalog/assets filters by domain for public assets", async () => {
    const res = await request(app).get("/catalog/assets?domain=engineering");

    expect(res.status).toBe(200);
    for (const asset of res.body.assets) {
      expect(asset.domains.some((d: string) => d.includes("engineering"))).toBe(true);
    }
  });

  it("GET /catalog/assets returns only public assets when unauthenticated", async () => {
    const res = await request(app).get("/catalog/assets");

    expect(res.status).toBe(200);
    for (const asset of res.body.assets) {
      expect(asset.sensitivity_tier).toBe("public");
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

  it("GET /catalog/assets/:name/:version/manifest returns full manifest for a public asset", async () => {
    const name = encodeURIComponent("aria.dev/skills/code-review");
    const res = await request(app).get(`/catalog/assets/${name}/1.5.2/manifest`);

    expect(res.status).toBe(200);
    expect(res.body.record).toBeDefined();
    expect(res.body.governance).toBeDefined();
  });

  it("GET /catalog/assets/:name/:version/manifest returns 403 for unauthenticated access to a non-public asset", async () => {
    const name = encodeURIComponent("aria.dev/skills/financial-analyzer");
    const res = await request(app).get(`/catalog/assets/${name}/1.0.0/manifest`);

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("Access denied");
  });

  it("GET /catalog/assets/:name/:version/mcpb returns mcpb bundle for a public asset", async () => {
    const name = encodeURIComponent("aria.dev/skills/code-review");
    const res = await request(app).get(`/catalog/assets/${name}/1.5.2/mcpb`);

    expect(res.status).toBe(200);
    expect(res.body.schema_version).toBe("1.0");
    expect(res.body.mcp_server).toBeDefined();
  });

  it("POST /catalog/assets/:name/:version/install returns 202 Accepted per spec", async () => {
    const name = encodeURIComponent("aria.dev/skills/code-review");
    const res = await request(app)
      .post(`/catalog/assets/${name}/1.5.2/install`)
      .send({ target: "claude_desktop" });

    expect(res.status).toBe(202);
    expect(res.body.installId).toBeDefined();
    expect(res.body.status).toBe("accepted");
    expect(res.body.estimatedReadyAt).toBeDefined();
    // Verify it's a valid ISO date string
    expect(new Date(res.body.estimatedReadyAt).getTime()).toBeGreaterThan(Date.now());
  });

  it("POST /catalog/assets/:name/:version/install returns governance reason code/message when blocked", async () => {
    const name = encodeURIComponent("aria.dev/skills/financial-analyzer");
    const res = await request(app)
      .post(`/catalog/assets/${name}/1.0.0/install`)
      .send({ target: "claude_desktop" });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("Install blocked by governance policy");
    expect(res.body.reason).toBeDefined();
    expect(res.body.reason.code).toBeDefined();
    expect(res.body.reason.message).toBeDefined();
  });

  it("POST /catalog/assets/:name/:version/request-access returns 202 with requestId per spec", async () => {
    const name = encodeURIComponent("aria.dev/skills/financial-analyzer");
    const res = await request(app)
      .post(`/catalog/assets/${name}/1.0.0/request-access`)
      .send({ justification: "Need this for quarterly reporting" });

    expect(res.status).toBe(202);
    expect(res.body.requestId).toBeDefined();
    expect(res.body.status).toBe("submitted");
    expect(Array.isArray(res.body.approvalChain)).toBe(true);
  });

  it("POST /catalog/assets/:name/:version/request-access returns 400 when access is already allowed", async () => {
    const name = encodeURIComponent("aria.dev/skills/code-review");
    const res = await request(app)
      .post(`/catalog/assets/${name}/1.5.2/request-access`)
      .send({ justification: "Requesting anyway for test coverage" });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("already have access");
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

  it("GET /.well-known/ai-plugin.json auth type is service_http bearer (not none)", async () => {
    const res = await request(app).get("/.well-known/ai-plugin.json");
    expect(res.status).toBe(200);
    expect(res.body.auth.type).toBe("service_http");
    expect(res.body.auth.authorization_type).toBe("bearer");
  });

  it("GET /openapi.json returns valid OpenAPI spec", async () => {
    const res = await request(app).get("/openapi.json");
    expect(res.status).toBe(200);
    expect(res.body.openapi).toBe("3.1.0");
    expect(res.body.paths["/catalog/assets"]).toBeDefined();
  });

  it("GET /openapi.json includes BearerAuth security scheme", async () => {
    const res = await request(app).get("/openapi.json");
    expect(res.status).toBe(200);
    expect(res.body.components.securitySchemes.BearerAuth).toBeDefined();
    expect(res.body.components.securitySchemes.BearerAuth.type).toBe("http");
    expect(res.body.components.securitySchemes.BearerAuth.scheme).toBe("bearer");
    expect(res.body.components.securitySchemes.BearerAuth.bearerFormat).toBe("JWT");
  });

  it("GET /openapi.json does not include ConsumerHeaders security scheme (removed)", async () => {
    const res = await request(app).get("/openapi.json");
    expect(res.status).toBe(200);
    expect(res.body.components.securitySchemes.ConsumerHeaders).toBeUndefined();
  });

  it("GET /openapi.json has global security requirement", async () => {
    const res = await request(app).get("/openapi.json");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.security)).toBe(true);
    expect(res.body.security.length).toBeGreaterThan(0);
  });

  it("GET /openapi.json operations include security and 401 response", async () => {
    const res = await request(app).get("/openapi.json");
    expect(res.status).toBe(200);
    const listOp = res.body.paths["/catalog/assets"].get;
    expect(Array.isArray(listOp.security)).toBe(true);
    expect(listOp.responses["401"]).toBeDefined();
    const manifestOp = res.body.paths["/catalog/assets/{name}/{version}/manifest"].get;
    expect(Array.isArray(manifestOp.security)).toBe(true);
    expect(manifestOp.responses["401"]).toBeDefined();
    const installOp = res.body.paths["/catalog/assets/{name}/{version}/install"].post;
    expect(Array.isArray(installOp.security)).toBe(true);
    expect(installOp.responses["401"]).toBeDefined();
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
      .send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });

    expect(res.status).toBe(200);
    expect(res.body.result.protocolVersion).toBeDefined();
    expect(res.body.result.serverInfo.name).toBe("aria-gateway");
  });

  it("POST /mcp tools/list returns tool definitions", async () => {
    const res = await request(app)
      .post("/mcp")
      .send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.result.tools)).toBe(true);
    const toolNames = res.body.result.tools.map((t: { name: string }) => t.name);
    expect(toolNames).toContain("search_assets");
    expect(toolNames).toContain("get_asset_detail");
    expect(toolNames).toContain("install_asset");
  });

  it("POST /mcp tools/call search_assets returns public asset results", async () => {
    const res = await request(app)
      .post("/mcp")
      .send({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "search_assets", arguments: { keyword: "code" } },
      });

    expect(res.status).toBe(200);
    expect(res.body.result.content[0].type).toBe("text");
    expect(res.body.result.content[0].text).toContain("code");
  });

  it("POST /mcp tools/call install_asset returns installation instructions for a public asset", async () => {
    const res = await request(app)
      .post("/mcp")
      .send({
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: {
          name: "install_asset",
          arguments: {
            name: "aria.dev/skills/code-review",
            version: "1.5.2",
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

