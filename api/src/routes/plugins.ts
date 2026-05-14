import { Router } from "express";
import { listAssets, getAllPublishedAssets } from "../services/catalog.service.js";

const router = Router();
const API_BASE_URL = process.env.API_BASE_URL ?? "http://localhost:3001";

// ChatGPT / GPT Actions plugin manifest
// Served at /.well-known/ai-plugin.json
router.get("/.well-known/ai-plugin.json", (_req, res) => {
  res.json({
    schema_version: "v1",
    name_for_human: "ARIA AI Skills Catalog",
    name_for_model: "aria_catalog",
    description_for_human:
      "Browse and install AI skills and agents from your organization's governed catalog. Search by capability or department.",
    description_for_model:
      "Use this plugin to search the organization's ARIA catalog of governed AI skills and agents. You can list available skills, search by capability or domain, get details about specific skills including their tools and governance status, and get installation instructions for Claude Desktop or VS Code.",
    auth: {
      type: "service_http",
      authorization_type: "bearer",
      verification_tokens: {},
    },
    api: {
      type: "openapi",
      url: `${API_BASE_URL}/openapi.json`,
    },
    logo_url: `${API_BASE_URL}/logo.png`,
    contact_email: "platform@aria.dev",
    legal_info_url: `${API_BASE_URL}/legal`,
  });
});

// OpenAPI 3.1 spec – consumed by ChatGPT, Claude, and other AI platforms
router.get("/openapi.json", (_req, res) => {
  res.json(buildOpenApiSpec());
});

// Claude-compatible: serve openapi.yaml path as well
router.get("/.well-known/openapi.yaml", (req, res) => {
  res.redirect("/openapi.json");
});

export function buildOpenApiSpec() {
  return {
    openapi: "3.1.0",
    info: {
      title: "ARIA Distribution Gateway — Catalog API",
      description:
        "Browse, search, and install governed AI skills and agents from the ARIA catalog. AI platforms can use this API to discover capabilities and install them for end users.",
      version: "1.0.0",
      contact: {
        name: "ARIA Platform Team",
        email: "platform@aria.dev",
        url: "https://aria.dev",
      },
    },
    servers: [
      { url: API_BASE_URL, description: "ARIA Distribution Gateway" },
    ],
    security: [{ BearerAuth: [] }],
    paths: {
      "/catalog/assets": {
        get: {
          operationId: "listAssets",
          summary: "List or search available AI skills and agents",
          description:
            "Returns catalog assets the caller is authorized to see. Supports free-text search and pagination.",
          security: [{ BearerAuth: [] }],
          parameters: [
            {
              name: "skill",
              in: "query",
              description: "Filter by OASF skill taxonomy (e.g., knowledge_retrieval/rag)",
              schema: { type: "string" },
            },
            {
              name: "domain",
              in: "query",
              description: "Filter by business domain (e.g., human_resources, engineering)",
              schema: { type: "string" },
            },
            {
              name: "q",
              in: "query",
              description: "Free-text search across name, description, and tags",
              schema: { type: "string" },
            },
            {
              name: "page",
              in: "query",
              description: "1-based page index",
              schema: { type: "integer", minimum: 1, default: 1 },
            },
            {
              name: "pageSize",
              in: "query",
              description: "Number of items per page",
              schema: { type: "integer", minimum: 1, maximum: 100, default: 25 },
            },
            {
              name: "sensitivity",
              in: "query",
              description: "Filter by sensitivity tier",
              schema: { type: "string", enum: ["public", "internal", "confidential", "highly_confidential"] },
            },
          ],
          responses: {
            "200": {
              description: "List of available assets",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      total: { type: "integer" },
                      page: { type: "integer" },
                      pageSize: { type: "integer" },
                      assets: {
                        type: "array",
                        items: { $ref: "#/components/schemas/AssetListItem" },
                      },
                    },
                  },
                },
              },
            },
            "400": { description: "Invalid query parameters" },
            "401": { description: "Missing or invalid bearer token (when auth enforcement is enabled)" },
          },
        },
      },
      "/catalog/assets/{name}/{version}/manifest": {
        get: {
          operationId: "getAssetManifest",
          summary: "Get full OASF record and governance details for an asset",
          security: [{ BearerAuth: [] }],
          parameters: [
            {
              name: "name",
              in: "path",
              required: true,
              description: "Asset name (URL-encoded), e.g., aria.dev%2Fskills%2Fhr-policy-lookup",
              schema: { type: "string" },
            },
            {
              name: "version",
              in: "path",
              required: true,
              description: "Semantic version, e.g., 1.2.0",
              schema: { type: "string" },
            },
          ],
          responses: {
            "200": {
              description: "Full asset manifest",
              content: { "application/json": { schema: { $ref: "#/components/schemas/AssetManifest" } } },
            },
            "401": { description: "Missing or invalid bearer token (when auth enforcement is enabled)" },
            "403": { description: "Access denied by governance policy" },
            "404": { description: "Asset not found" },
          },
        },
      },
      "/catalog/assets/{name}/{version}/install": {
        post: {
          operationId: "installAsset",
          summary: "Submit an install request for an asset",
          description: "Starts asynchronous install processing and returns a queued install identifier.",
          security: [{ BearerAuth: [] }],
          parameters: [
            {
              name: "name",
              in: "path",
              required: true,
              schema: { type: "string" },
            },
            {
              name: "version",
              in: "path",
              required: true,
              schema: { type: "string" },
            },
          ],
          requestBody: {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                    properties: {
                      target: {
                        type: "string",
                        enum: ["claude_desktop", "claude-desktop", "vscode", "cowork", "web_portal", "aria_cli"],
                        default: "claude_desktop",
                      },
                    },
                },
              },
            },
          },
          responses: {
            "202": {
              description: "Install request accepted",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["installId", "status", "estimatedReadyAt"],
                    properties: {
                      installId: { type: "string" },
                      status: { type: "string", enum: ["accepted"] },
                      estimatedReadyAt: { type: "string", format: "date-time" },
                    },
                  },
                },
              },
            },
            "400": { description: "Invalid request parameters" },
            "401": { description: "Missing or invalid bearer token (when auth enforcement is enabled)" },
            "403": { description: "Install blocked by governance policy" },
            "404": { description: "Asset not found" },
          },
        },
      },
      "/catalog/assets/{name}/{version}/request-access": {
        post: {
          operationId: "requestAssetAccess",
          summary: "Request access to a governed asset",
          description: "Submits an access request for an asset that the caller is not currently authorised to install.",
          security: [{ BearerAuth: [] }],
          parameters: [
            {
              name: "name",
              in: "path",
              required: true,
              schema: { type: "string" },
            },
            {
              name: "version",
              in: "path",
              required: true,
              schema: { type: "string" },
            },
          ],
          requestBody: {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["justification"],
                  properties: {
                    justification: {
                      type: "string",
                      description: "Business justification for access (min 8 characters)",
                    },
                    ticketSystem: {
                      type: "string",
                      description: "Ticket system to use for the access request",
                    },
                  },
                },
              },
            },
          },
          responses: {
            "202": {
              description: "Access request submitted",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["requestId", "status", "approvalChain"],
                    properties: {
                      requestId: { type: "string" },
                      status: { type: "string", enum: ["submitted"] },
                      approvalChain: { type: "array", items: { type: "string" } },
                    },
                  },
                },
              },
            },
            "400": { description: "Invalid request (e.g. missing justification or caller already has access)" },
            "401": { description: "Missing or invalid bearer token (when auth enforcement is enabled)" },
            "404": { description: "Asset not found" },
          },
        },
      },
    },
    components: {
      securitySchemes: {
        BearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "JWT",
          description:
            "Entra (Azure AD) JWT bearer token. Obtain via OAuth 2.0 client-credentials or authorization-code flow against your tenant. " +
            "Roles `aria-gateway-admin`, `aria-gateway-confidential`, and `aria-gateway-internal` control the sensitivity ceiling. " +
            "Set AUTH_ENFORCE=true on the gateway to require this header.",
        },
      },
      schemas: {
        AssetListItem: {
          type: "object",
          properties: {
            name: { type: "string", description: "Unique asset identifier" },
            version: { type: "string" },
            description: { type: "string" },
            lifecycle_state: { type: "string" },
            sensitivity_tier: { type: "string", enum: ["public", "internal", "confidential", "highly_confidential"] },
            domains: { type: "array", items: { type: "string" } },
            skills: { type: "array", items: { type: "string" } },
            trust_badge: { type: "string" },
            tags: { type: "array", items: { type: "string" } },
          },
        },
        AssetManifest: {
          type: "object",
          properties: {
            record: { type: "object" },
            governance: { type: "object" },
            install_url: { type: "string" },
            mcpb_url: { type: "string", nullable: true },
          },
        },
      },
    },
  };
}

export default router;
