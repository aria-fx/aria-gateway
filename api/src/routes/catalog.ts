import { Router } from "express";
import { z } from "zod";
import { v4 as uuidv4 } from "uuid";
import {
  listAssets,
  getAssetVersions,
  getAssetManifest,
  getAllPublishedAssets,
  getAllAssets,
  refreshCatalogAssets,
} from "../services/catalog.service.js";
import {
  checkGovernance,
  parseConsumerContext,
} from "../services/governance.service.js";
import { checkBudgetThreshold } from "../services/cost.service.js";
import { emitBudgetEnforcement } from "../services/observability.service.js";
import { generateMcpbManifest } from "../services/mcpb.service.js";

const router = Router();

function toGovernanceBlockReason(reason?: string): { code: string; message: string } {
  if (!reason) {
    return {
      code: "governance_blocked",
      message: "Access denied by governance policy.",
    };
  }

  const normalized = reason.toLowerCase();
  if (normalized.includes("classified") || normalized.includes("access level")) {
    return { code: "sensitivity_ceiling", message: reason };
  }
  if (normalized.includes("does not have access") || normalized.includes("restricted")) {
    return { code: "consumer_not_allowed", message: reason };
  }
  if (normalized.includes("entra groups")) {
    return { code: "entra_group_required", message: reason };
  }
  if (normalized.includes("entra roles")) {
    return { code: "entra_role_required", message: reason };
  }
  if (normalized.includes("purview roles")) {
    return { code: "purview_role_required", message: reason };
  }
  if (normalized.includes("dependency") && normalized.includes("sensitivity")) {
    return { code: "dependency_ceiling", message: reason };
  }

  return { code: "governance_blocked", message: reason };
}

const listQuerySchema = z.object({
  skill: z.string().optional(),
  domain: z.string().optional(),
  q: z.string().optional(), // Updated from 'keyword' to match spec parameter name
  page: z.coerce.number().int().min(1).default(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(100).default(25).optional(),
  sensitivity: z
    .enum(["public", "internal", "confidential", "highly_confidential"])
    .optional(),
});

// GET /catalog/assets — browse / search catalog (spec: returns paginated results)
router.get("/assets", async (req, res) => {
  const parsed = listQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid query parameters", details: parsed.error.flatten() });
    return;
  }

  const consumer = parseConsumerContext(req.headers as Record<string, string | undefined>, req.identity);
  const catalogAssets = await getAllAssets();
  const catalogAssetsByKey = new Map(
    catalogAssets.map((asset) => [`${asset.record.name}@${asset.record.version}`, asset])
  );
  // Map 'q' to internal 'keyword' parameter for listAssets service
  const listParams = { ...parsed.data, keyword: parsed.data.q };
  const all = await listAssets(listParams);

  // Filter by governance – only show assets the consumer is authorized to see
  const visible = all.filter((item) => {
    const full = catalogAssetsByKey.get(`${item.name}@${item.version}`);
    if (!full) return false;
    return checkGovernance(full, consumer, catalogAssets).allowed;
  });

  // Implement pagination per spec
  const page = parsed.data.page || 1;
  const pageSize = parsed.data.pageSize || 25;
  const startIdx = (page - 1) * pageSize;
  const paged = visible.slice(startIdx, startIdx + pageSize);

  res.json({
    total: visible.length,
    page,
    pageSize,
    assets: paged,
  });
});

// GET /catalog/assets/:name/versions
router.get("/assets/:name/versions", async (req, res) => {
  const { name } = req.params;
  const decoded = decodeURIComponent(name);
  const versions = await getAssetVersions(decoded);

  if (versions.length === 0) {
    res.status(404).json({ error: `Asset "${decoded}" not found` });
    return;
  }

  res.json({ name: decoded, versions });
});

// GET /catalog/assets/:name/:version/manifest
router.get("/assets/:name/:version/manifest", async (req, res) => {
  const { version } = req.params;
  const name = decodeURIComponent(req.params.name);

  const catalogAssets = await getAllAssets();
  const full = catalogAssets.find((a) => a.record.name === name && a.record.version === version);
  if (!full) {
    res.status(404).json({ error: `Asset "${name}@${version}" not found` });
    return;
  }

  const consumer = parseConsumerContext(req.headers as Record<string, string | undefined>, req.identity);
  const check = checkGovernance(full, consumer, catalogAssets);
  if (!check.allowed) {
    res.status(403).json({
      error: "Access denied by governance policy",
      ...check,
    });
    return;
  }

  // Budget threshold check (invoke flow)
  if (full.governance.budget_threshold !== undefined) {
    const currency = full.governance.budget_currency ?? "USD";
    const budget = checkBudgetThreshold(name, full.governance.budget_threshold, currency);
    if (budget.exceeded) {
      emitBudgetEnforcement({
        asset_name: name,
        asset_version: version,
        consumer_id: consumer.consumer_id,
        flow: "invoke",
        current_spend: budget.current_spend,
        threshold: budget.threshold,
        currency: budget.currency,
      });
      res.status(402).json({
        error: "Asset invoke blocked: budget threshold exceeded",
        contract_version: "1.0.0",
        allowed: false,
        reason: {
          code: "budget_exceeded",
          message: `Current spend (${budget.current_spend.toFixed(2)} ${budget.currency}) has reached or exceeded the configured threshold of ${budget.threshold.toFixed(2)} ${budget.currency} for this asset.`,
        },
        current_spend: budget.current_spend,
        threshold: budget.threshold,
        currency: budget.currency,
        action_url: `/cost/assets?asset_name=${encodeURIComponent(name)}`,
      });
      return;
    }
  }

  const manifest = await getAssetManifest(name, version);
  if (!manifest) {
    res.status(404).json({ error: `Asset "${name}@${version}" not found` });
    return;
  }
  res.json(manifest);
});

// GET /catalog/assets/:name/:version/mcpb — download .mcpb bundle
router.get("/assets/:name/:version/mcpb", async (req, res) => {
  const { version } = req.params;
  const name = decodeURIComponent(req.params.name);

  const catalogAssets = await getAllAssets();
  const asset = catalogAssets.find((a) => a.record.name === name && a.record.version === version);
  if (!asset) {
    res.status(404).json({ error: `Asset "${name}@${version}" not found` });
    return;
  }

  const consumer = parseConsumerContext(req.headers as Record<string, string | undefined>, req.identity);
  const check = checkGovernance(asset, consumer, catalogAssets);
  if (!check.allowed) {
    res.status(403).json({
      error: "Access denied by governance policy",
      ...check,
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

// POST /catalog/assets/:name/:version/install (spec: returns 202 Accepted per RFC 7231)
router.post("/assets/:name/:version/install", async (req, res) => {
  const { version } = req.params;
  const name = decodeURIComponent(req.params.name);
  const installRequest = req.body as { target?: string; clientRequestId?: string; parameters?: Record<string, string> };
  const target = installRequest.target ?? "claude_desktop";

  // Validate target enum
  const validTargets = ["claude_desktop", "claude-desktop", "vscode", "cowork", "web_portal", "aria_cli"];
  if (!validTargets.includes(target)) {
    res.status(400).json({
      error: "Invalid target. Must be one of: claude_desktop, claude-desktop, vscode, cowork, web_portal, aria_cli",
    });
    return;
  }

  const catalogAssets = await getAllAssets();
  const asset = catalogAssets.find((a) => a.record.name === name && a.record.version === version);
  if (!asset) {
    res.status(404).json({ error: `Asset "${name}@${version}" not found` });
    return;
  }

  const consumer = parseConsumerContext(req.headers as Record<string, string | undefined>, req.identity);
  const check = checkGovernance(asset, consumer, catalogAssets);
  if (!check.allowed) {
    res.status(403).json({
      error: "Install blocked by governance policy",
      ...check,
      reason: toGovernanceBlockReason(check.reason),
    });
    return;
  }

  // Budget threshold check (install flow)
  if (asset.governance.budget_threshold !== undefined) {
    const currency = asset.governance.budget_currency ?? "USD";
    const budget = checkBudgetThreshold(name, asset.governance.budget_threshold, currency);
    if (budget.exceeded) {
      emitBudgetEnforcement({
        asset_name: name,
        asset_version: version,
        consumer_id: consumer.consumer_id,
        flow: "install",
        current_spend: budget.current_spend,
        threshold: budget.threshold,
        currency: budget.currency,
      });
      res.status(402).json({
        error: "Install blocked: asset budget threshold exceeded",
        contract_version: "1.0.0",
        allowed: false,
        reason: {
          code: "budget_exceeded",
          message: `Current spend (${budget.current_spend.toFixed(2)} ${budget.currency}) has reached or exceeded the configured threshold of ${budget.threshold.toFixed(2)} ${budget.currency} for this asset.`,
        },
        current_spend: budget.current_spend,
        threshold: budget.threshold,
        currency: budget.currency,
        action_url: `/cost/assets?asset_name=${encodeURIComponent(name)}`,
      });
      return;
    }
  }

  // Generate install ID and estimated ready time per spec
  const installId = uuidv4();
  const estimatedReadyAt = new Date(Date.now() + 30000).toISOString(); // 30 seconds from now

  // Return 202 Accepted as per spec (RFC 7231: resource creation is in progress)
  res.status(202).json({
    installId,
    status: "accepted",
    estimatedReadyAt,
  });
});


// POST /catalog/assets/:name/:version/request-access (spec: returns 202)
router.post("/assets/:name/:version/request-access", async (req, res) => {
  const { version } = req.params;
  const name = decodeURIComponent(req.params.name);
  const accessRequest = req.body as { justification?: string; ticketSystem?: string };

  // Validate required justification
  if (!accessRequest.justification || accessRequest.justification.length < 8) {
    res.status(400).json({
      error: "Invalid access request. Justification must be at least 8 characters.",
    });
    return;
  }

  const catalogAssets = await getAllAssets();
  const asset = catalogAssets.find((a) => a.record.name === name && a.record.version === version);
  if (!asset) {
    res.status(404).json({ error: `Asset "${name}@${version}" not found` });
    return;
  }

  const consumer = parseConsumerContext(req.headers as Record<string, string | undefined>, req.identity);
  const check = checkGovernance(asset, consumer, catalogAssets);
  if (check.allowed) {
    res.status(400).json({
      error: "Access request not required. You already have access to this asset.",
    });
    return;
  }

  const requestId = uuidv4();
  const approvalChain = asset.governance.approval_chain ?? ["it-helpdesk"];

  // Return 202 Accepted as per spec
  res.status(202).json({
    requestId,
    status: "submitted",
    approvalChain,
  });
});

// GET /catalog/stats — summary stats for dashboard
router.get("/stats", async (_req, res) => {
  const published = await getAllPublishedAssets();
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

// POST /catalog/cache/refresh — force refresh of registry-backed metadata cache
router.post("/cache/refresh", async (_req, res) => {
  try {
    const metrics = await refreshCatalogAssets();
    res.status(202).json({
      status: "refreshed",
      refreshedAt: metrics.last_refresh_at,
      stalenessWindowSeconds: metrics.staleness_window_seconds,
      freshnessSlaP95Seconds: metrics.freshness_sla_p95_seconds,
      p95FreshnessSeconds: metrics.p95_freshness_seconds,
      refreshSuccessTotal: metrics.refresh_success_total,
      refreshFailureTotal: metrics.refresh_failure_total,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(502).json({
      error: "Catalog cache refresh failed",
      message,
    });
  }
});

export default router;
