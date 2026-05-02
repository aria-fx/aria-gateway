import { Router } from "express";
import { z } from "zod";
import { v4 as uuidv4 } from "uuid";
import {
  listAssets,
  getAssetVersions,
  getAssetManifest,
  getAllPublishedAssets,
} from "../services/catalog.service.js";
import {
  checkGovernance,
  parseConsumerContext,
} from "../services/governance.service.js";
import { generateMcpbManifest } from "../services/mcpb.service.js";
import { sampleAssets } from "../data/sample-assets.js";

const router = Router();

const listQuerySchema = z.object({
  skill: z.string().optional(),
  domain: z.string().optional(),
  keyword: z.string().optional(),
  state: z.string().optional(),
  sensitivity: z
    .enum(["public", "internal", "confidential", "highly_confidential"])
    .optional(),
});

// GET /catalog/assets — browse / search catalog
router.get("/assets", (req, res) => {
  const parsed = listQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid query parameters", details: parsed.error.flatten() });
    return;
  }

  const consumer = parseConsumerContext(req.headers as Record<string, string | undefined>, req.identity);
  const all = listAssets(parsed.data);

  // Filter by governance – only show assets the consumer is authorized to see
  const visible = all.filter((item) => {
    const full = sampleAssets.find((a) => a.record.name === item.name);
    if (!full) return false;
    return checkGovernance(full, consumer).allowed;
  });

  res.json({
    total: visible.length,
    assets: visible,
  });
});

// GET /catalog/assets/:name/versions
router.get("/assets/:name/versions", (req, res) => {
  const { name } = req.params;
  const decoded = decodeURIComponent(name);
  const versions = getAssetVersions(decoded);

  if (versions.length === 0) {
    res.status(404).json({ error: `Asset "${decoded}" not found` });
    return;
  }

  res.json({ name: decoded, versions });
});

// GET /catalog/assets/:name/:version/manifest
router.get("/assets/:name/:version/manifest", (req, res) => {
  const { version } = req.params;
  const name = decodeURIComponent(req.params.name);

  const manifest = getAssetManifest(name, version);
  if (!manifest) {
    res.status(404).json({ error: `Asset "${name}@${version}" not found` });
    return;
  }

  const consumer = parseConsumerContext(req.headers as Record<string, string | undefined>, req.identity);
  const full = sampleAssets.find(
    (a) => a.record.name === name && a.record.version === version
  );
  if (full) {
    const check = checkGovernance(full, consumer);
    if (!check.allowed) {
      res.status(403).json({
        error: "Access denied by governance policy",
        reason: check.reason,
        approval_chain: check.approval_chain,
        action_url: check.action_url,
      });
      return;
    }
  }

  res.json(manifest);
});

// GET /catalog/assets/:name/:version/mcpb — download .mcpb bundle
router.get("/assets/:name/:version/mcpb", (req, res) => {
  const { version } = req.params;
  const name = decodeURIComponent(req.params.name);

  const asset = sampleAssets.find(
    (a) => a.record.name === name && a.record.version === version
  );
  if (!asset) {
    res.status(404).json({ error: `Asset "${name}@${version}" not found` });
    return;
  }

  const consumer = parseConsumerContext(req.headers as Record<string, string | undefined>, req.identity);
  const check = checkGovernance(asset, consumer);
  if (!check.allowed) {
    res.status(403).json({
      error: "Access denied by governance policy",
      reason: check.reason,
      action_url: check.action_url,
    });
    return;
  }

  const mcpb = generateMcpbManifest(asset);
  if (!mcpb) {
    res.status(422).json({
      error: "This asset does not have an MCP server module and cannot be packaged as .mcpb",
    });
    return;
  }

  const filename = `${name.replace(/\//g, "-")}-${version}.mcpb.json`;
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.setHeader("Content-Type", "application/json");
  res.json(mcpb);
});

// POST /catalog/assets/:name/:version/install
router.post("/assets/:name/:version/install", (req, res) => {
  const { version } = req.params;
  const name = decodeURIComponent(req.params.name);
  const target = (req.body as Record<string, string>).target ?? "claude-desktop";

  const asset = sampleAssets.find(
    (a) => a.record.name === name && a.record.version === version
  );
  if (!asset) {
    res.status(404).json({ error: `Asset "${name}@${version}" not found` });
    return;
  }

  const consumer = parseConsumerContext(req.headers as Record<string, string | undefined>, req.identity);
  const check = checkGovernance(asset, consumer);
  if (!check.allowed) {
    res.status(403).json({
      error: "Install blocked by governance policy",
      reason: check.reason,
      approval_chain: check.approval_chain,
      action_url: check.action_url,
    });
    return;
  }

  const shortName = name.split("/").pop() ?? name;

  const configSnippet = buildConfigSnippet(target, shortName, version, asset.record.modules.find((m) => m.type === "mcp_server"));

  res.json({
    success: true,
    target,
    asset: name,
    version,
    message: `Successfully prepared "${shortName}" for installation into ${target}. Follow the config snippet below to complete setup.`,
    config_snippet: configSnippet,
  });
});

function buildConfigSnippet(
  target: string,
  shortName: string,
  version: string,
  mcpModule: Record<string, unknown> | undefined
): Record<string, unknown> | null {
  if (!mcpModule) return null;

  const serverKey = shortName.replace(/[^a-z0-9-]/gi, "-");

  if (target === "claude-desktop") {
    return {
      mcpServers: {
        [serverKey]: {
          command: "npx",
          args: ["-y", `@aria-fx/${shortName}@${version}`],
        },
      },
    };
  }

  if (target === "vscode") {
    return {
      servers: {
        [serverKey]: {
          type: "stdio",
          command: "npx",
          args: ["-y", `@aria-fx/${shortName}@${version}`],
        },
      },
    };
  }

  return { ref: `aria.dev/${shortName}:${version}` };
}

// POST /catalog/assets/:name/:version/request-access
router.post("/assets/:name/:version/request-access", (req, res) => {
  const { version } = req.params;
  const name = decodeURIComponent(req.params.name);

  const asset = sampleAssets.find(
    (a) => a.record.name === name && a.record.version === version
  );
  if (!asset) {
    res.status(404).json({ error: `Asset "${name}@${version}" not found` });
    return;
  }

  const requestId = uuidv4();
  const approvalChain = asset.governance.approval_chain ?? ["it-helpdesk"];

  res.status(202).json({
    request_id: requestId,
    status: "pending",
    asset: name,
    version,
    approval_chain: approvalChain,
    message: `Your access request has been submitted (ID: ${requestId}). The following approvers have been notified: ${approvalChain.join(", ")}. You will receive an email when your request is approved.`,
  });
});

// GET /catalog/stats — summary stats for dashboard
router.get("/stats", (_req, res) => {
  const published = getAllPublishedAssets();
  const byTier: Record<string, number> = {};
  const byDomain: Record<string, number> = {};

  for (const a of published) {
    const tier = a.governance.sensitivity_tier;
    byTier[tier] = (byTier[tier] ?? 0) + 1;

    for (const d of a.record.domains) {
      const top = d.name.split("/")[0];
      byDomain[top] = (byDomain[top] ?? 0) + 1;
    }
  }

  res.json({
    total_assets: published.length,
    by_sensitivity: byTier,
    by_domain: byDomain,
  });
});

export default router;
