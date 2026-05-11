import { Router, type Request, type Response } from "express";
import { getAllAssets } from "../services/catalog.service.js";
import { parseConsumerContext, checkGovernance } from "../services/governance.service.js";

const router = Router();

// MCP (Model Context Protocol) server implementation for Claude Desktop
// Implements JSON-RPC 2.0 over HTTP POST

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: string | number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

function rpcOk(id: string | number, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(
  id: string | number,
  code: number,
  message: string,
  data?: unknown
): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message, data } };
}

// GET /mcp — server info (Claude Desktop discovery endpoint)
router.get("/", (_req: Request, res: Response) => {
  res.json({
    name: "aria-gateway",
    display_name: "ARIA AI Skills Catalog",
    version: "1.0.0",
    description:
      "Browse and install your organization's governed AI skills and agents directly from Claude.",
    protocol_version: "2024-11-05",
    capabilities: {
      tools: { listChanged: false },
    },
    instructions:
      "Use the search_assets tool to find AI skills available to you. Use get_asset_detail to learn more about a specific skill. Use install_asset to get setup instructions.",
  });
});

// POST /mcp — JSON-RPC 2.0 endpoint
router.post("/", (req: Request, res: Response) => {
  const body = req.body as JsonRpcRequest;

  if (!body || body.jsonrpc !== "2.0") {
    res.status(400).json(rpcError(0, -32600, "Invalid JSON-RPC request"));
    return;
  }

  const consumer = parseConsumerContext(req.headers as Record<string, string | undefined>, req.identity);

  switch (body.method) {
    case "initialize":
      res.json(
        rpcOk(body.id, {
          protocolVersion: "2024-11-05",
          capabilities: { tools: { listChanged: false } },
          serverInfo: {
            name: "aria-gateway",
            version: "1.0.0",
          },
          instructions:
            "Use search_assets to find available AI skills. Use get_asset_detail for more info. Use install_asset to get setup instructions.",
        })
      );
      break;

    case "tools/list":
      res.json(
        rpcOk(body.id, {
          tools: [
            {
              name: "search_assets",
              description:
                "Search the organization's catalog of AI skills and agents. Returns a list of available capabilities the user can install.",
              inputSchema: {
                type: "object",
                properties: {
                  keyword: {
                    type: "string",
                    description: "Search by keyword, capability, or topic",
                  },
                  domain: {
                    type: "string",
                    description:
                      "Filter by business domain (e.g., human_resources, engineering, finance)",
                  },
                },
              },
            },
            {
              name: "get_asset_detail",
              description:
                "Get detailed information about a specific AI skill or agent, including what it can do, who published it, and its compliance status.",
              inputSchema: {
                type: "object",
                required: ["name", "version"],
                properties: {
                  name: {
                    type: "string",
                    description: "Asset name (e.g., aria.dev/skills/hr-policy-lookup)",
                  },
                  version: {
                    type: "string",
                    description: "Version number (e.g., 1.2.0)",
                  },
                },
              },
            },
            {
              name: "install_asset",
              description:
                "Get step-by-step installation instructions for adding an AI skill to Claude Desktop or VS Code.",
              inputSchema: {
                type: "object",
                required: ["name", "version"],
                properties: {
                  name: {
                    type: "string",
                    description: "Asset name",
                  },
                  version: {
                    type: "string",
                    description: "Version number",
                  },
                  target: {
                    type: "string",
                    enum: ["claude-desktop", "vscode", "agent-framework"],
                    description: "Target platform (default: claude-desktop)",
                  },
                },
              },
            },
          ],
        })
      );
      break;

    case "tools/call": {
      const toolName = (body.params?.name ?? body.params?.tool) as string;
      const toolArgs = (body.params?.arguments ?? body.params?.input ?? {}) as Record<string, unknown>;
      void handleToolCall(body.id, toolName, toolArgs, consumer, res).catch((error) => {
        const message = error instanceof Error
          ? error.message
          : "An error occurred while processing the tool request";
        res.json(rpcError(body.id, -32000, message));
      });
      break;
    }

    default:
      res.json(rpcError(body.id, -32601, `Method not found: ${body.method}`));
  }
});

async function handleToolCall(
  id: string | number,
  toolName: string,
  args: Record<string, unknown>,
  consumer: { consumer_id: string; sensitivity_ceiling: string },
  res: Response
): Promise<void> {
  switch (toolName) {
    case "search_assets": {
      const allAssets = await getAllAssets();
      const published = allAssets.filter((a) => a.record.lifecycle_state === "published");
      const keyword = (args.keyword as string | undefined)?.toLowerCase();
      const domain = (args.domain as string | undefined)?.toLowerCase();

      let results = published.filter((a) =>
        checkGovernance(
          a,
          consumer as Parameters<typeof checkGovernance>[1],
          allAssets
        ).allowed
      );

      if (keyword) {
        results = results.filter(
          (a) =>
            a.record.name.toLowerCase().includes(keyword) ||
            a.record.description.toLowerCase().includes(keyword) ||
            (a.record.tags ?? []).some((t) => t.toLowerCase().includes(keyword))
        );
      }

      if (domain) {
        results = results.filter((a) =>
          a.record.domains.some((d) => d.name.toLowerCase().includes(domain))
        );
      }

      const text = results
        .map(
          (a) =>
            `• **${a.record.name}** v${a.record.version}\n  ${a.record.description}\n  Domains: ${a.record.domains.map((d) => d.name).join(", ")}`
        )
        .join("\n\n");

      res.json(
        rpcOk(id, {
          content: [
            {
              type: "text",
              text:
                results.length === 0
                  ? "No matching skills found in the catalog for your search."
                  : `Found ${results.length} skill(s):\n\n${text}`,
            },
          ],
        })
      );
      break;
    }

    case "get_asset_detail": {
      const name = args.name as string;
      const version = args.version as string;
      const allAssets = await getAllAssets();
      const asset = allAssets.find((a) => a.record.name === name && a.record.version === version);

      if (!asset) {
        res.json(
          rpcOk(id, {
            content: [{ type: "text", text: `Asset "${name}@${version}" not found in catalog.` }],
          })
        );
        break;
      }

      const govCheck = checkGovernance(
        asset,
        consumer as Parameters<typeof checkGovernance>[1],
        allAssets
      );
      if (!govCheck.allowed) {
        res.json(
          rpcOk(id, {
            content: [
              {
                type: "text",
                text: `Access denied: ${govCheck.reason}\n\nTo request access, visit: ${govCheck.action_url}`,
              },
            ],
          })
        );
        break;
      }

      const tools = asset.record.modules
        .filter((m) => m.type === "mcp_server")
        .flatMap((m) => (m.tools as string[]) ?? []);

      const text = [
        `**${asset.record.name}** v${asset.record.version}`,
        ``,
        asset.record.description,
        ``,
        `**What it can do:** ${tools.join(", ")}`,
        `**Department:** ${asset.record.domains.map((d) => d.name).join(", ")}`,
        `**Published by:** ${asset.record.authors.join(", ")}`,
        `**Compliance:** ${asset.governance.compliance_frameworks?.join(", ") ?? "Standard"}`,
        `**Sensitivity:** ${asset.governance.sensitivity_tier}`,
        `**Last updated:** ${asset.record.updated_at.split("T")[0]}`,
      ].join("\n");

      res.json(rpcOk(id, { content: [{ type: "text", text }] }));
      break;
    }

    case "install_asset": {
      const name = args.name as string;
      const version = args.version as string;
      const target = (args.target as string) ?? "claude-desktop";

      const allAssets = await getAllAssets();
      const asset = allAssets.find((a) => a.record.name === name && a.record.version === version);

      if (!asset) {
        res.json(
          rpcOk(id, {
            content: [{ type: "text", text: `Asset "${name}@${version}" not found.` }],
          })
        );
        break;
      }

      const govCheck = checkGovernance(
        asset,
        consumer as Parameters<typeof checkGovernance>[1],
        allAssets
      );
      if (!govCheck.allowed) {
        res.json(
          rpcOk(id, {
            content: [
              {
                type: "text",
                text: `You don't have permission to install this skill.\n\n${govCheck.reason}\n\nRequest access at: ${govCheck.action_url}`,
              },
            ],
          })
        );
        break;
      }

      const shortName = name.split("/").pop() ?? name;
      let installText: string;

      if (target === "claude-desktop") {
        installText = [
          `To add **${shortName}** to Claude Desktop:`,
          ``,
          `1. Open Claude Desktop → Settings → Developer`,
          `2. Click "Edit Config" to open \`claude_desktop_config.json\``,
          `3. Add the following inside \`"mcpServers"\`:`,
          ``,
          "```json",
          JSON.stringify(
            {
              [shortName]: {
                command: "npx",
                args: ["-y", `@aria-fx/${shortName}@${version}`],
              },
            },
            null,
            2
          ),
          "```",
          ``,
          `4. Save and restart Claude Desktop.`,
          `5. The skill will appear in your tools list. ✓`,
        ].join("\n");
      } else if (target === "vscode") {
        installText = [
          `To add **${shortName}** to VS Code:`,
          ``,
          `1. Open your workspace's \`.vscode/mcp.json\` (create if it doesn't exist)`,
          `2. Add the following to the \`"servers"\` section:`,
          ``,
          "```json",
          JSON.stringify(
            {
              [shortName]: {
                type: "stdio",
                command: "npx",
                args: ["-y", `@aria-fx/${shortName}@${version}`],
              },
            },
            null,
            2
          ),
          "```",
          ``,
          `3. Reload VS Code to activate.`,
        ].join("\n");
      } else {
        installText = `Installation config for ${target}: \`aria.dev/${shortName}:${version}\``;
      }

      res.json(rpcOk(id, { content: [{ type: "text", text: installText }] }));
      break;
    }

    default:
      res.json(rpcError(id, -32601, `Unknown tool: ${toolName}`));
  }
}

export default router;
