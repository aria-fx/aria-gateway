import type { CatalogAsset } from "../models/oasf.js";

// Extract the display name from "Name <email>" formatted author strings.
// Uses a prefix match rather than stripping angle-bracket content to avoid
// incomplete sanitization issues.
function extractAuthorName(author: string): string {
  const match = /^([^<]+)/.exec(author);
  return match ? match[1].trim() : author.trim();
}

export interface McpbManifest {
  schema_version: string;
  name: string;
  display_name: string;
  version: string;
  description: string;
  publisher: string;
  sensitivity: string;
  trust_level: string;
  mcp_server: {
    transport: string;
    command?: string;
    args?: string[];
    url?: string;
    tools: string[];
  };
  user_config?: McpbConfigField[];
  install_notes: string;
}

export interface McpbConfigField {
  key: string;
  label: string;
  type: "string" | "password" | "url";
  required: boolean;
  description: string;
}

// Generate a .mcpb manifest (MCP Bundle) from an OASF record
// .mcpb is the Claude Desktop enterprise extension format
export function generateMcpbManifest(asset: CatalogAsset): McpbManifest | null {
  const mcpModule = asset.record.modules.find((m) => m.type === "mcp_server");
  if (!mcpModule) return null;

  const shortName = asset.record.name.split("/").pop() ?? asset.record.name;
  const displayName = shortName
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");

  const publisher =
    extractAuthorName(asset.record.authors[0] ?? "") || "ARIA Platform";

  const baseManifest: McpbManifest = {
    schema_version: "1.0",
    name: asset.record.name,
    display_name: displayName,
    version: asset.record.version,
    description: asset.record.description,
    publisher,
    sensitivity: asset.governance.sensitivity_tier,
    trust_level: resolveTrustLevel(asset),
    mcp_server: {
      transport: mcpModule.transport ?? "stdio",
      tools: (mcpModule.tools as string[]) ?? [],
    },
    install_notes: buildInstallNotes(asset),
  };

  if (mcpModule.transport === "stdio") {
    baseManifest.mcp_server.command = "npx";
    baseManifest.mcp_server.args = [
      "-y",
      `@aria-fx/${shortName}`,
      "--registry",
      process.env.OCI_REGISTRY ?? "ghcr.io/aria-fx/aria-assets",
    ];
  } else {
    const endpoint = process.env.API_BASE_URL ?? "http://localhost:3001";
    baseManifest.mcp_server.url = `${endpoint}/mcp/sse`;
  }

  // Add user configuration fields for any MCP servers that need API tokens
  if (asset.governance.sensitivity_tier !== "public") {
    baseManifest.user_config = [
      {
        key: "aria_consumer_id",
        label: "Your Team ID",
        type: "string",
        required: false,
        description: "Your ARIA consumer identity (e.g., hr-team). Leave blank to use default.",
      },
    ];
  }

  return baseManifest;
}

function resolveTrustLevel(asset: CatalogAsset): string {
  const frameworks = asset.governance.compliance_frameworks ?? [];
  if (frameworks.includes("HIPAA") || frameworks.includes("SOX")) {
    return "verified-enterprise";
  }
  if (asset.governance.sensitivity_tier === "public") return "public";
  return "organization-verified";
}

function buildInstallNotes(asset: CatalogAsset): string {
  const lines: string[] = [
    `This skill was published by your organization through the ARIA catalog.`,
  ];

  if (asset.governance.compliance_frameworks?.length) {
    lines.push(
      `Compliance: ${asset.governance.compliance_frameworks.join(", ")}`
    );
  }

  if (asset.governance.sensitivity_tier !== "public") {
    lines.push(
      "This skill has governance controls applied. Usage is logged and audited."
    );
  }

  if (asset.governance.max_data_retention_days) {
    lines.push(
      `Data retention: ${asset.governance.max_data_retention_days} days maximum.`
    );
  }

  return lines.join(" ");
}
