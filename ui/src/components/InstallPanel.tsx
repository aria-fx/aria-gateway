import { useState } from "react";
import type { AssetManifest } from "../api/types.ts";
import { installAsset, requestAccess } from "../api/catalog.ts";

interface InstallPanelProps {
  manifest: AssetManifest;
}

type Target = "claude-desktop" | "vscode" | "agent-framework";

const TARGET_LABELS: Record<Target, string> = {
  "claude-desktop": "Claude Desktop",
  vscode: "VS Code",
  "agent-framework": "Agent Framework",
};

export function InstallPanel({ manifest }: InstallPanelProps) {
  const [target, setTarget] = useState<Target>("claude-desktop");
  const [state, setState] = useState<"idle" | "loading" | "done" | "blocked" | "requesting" | "requested">("idle");
  const [result, setResult] = useState<string>("");
  const [snippet, setSnippet] = useState<string>("");

  const hasMcp = manifest.record.modules.some((m) => m.type === "mcp_server");

  async function handleInstall() {
    setState("loading");
    try {
      const res = await installAsset(manifest.record.name, manifest.record.version, target);
      setResult(res.message);
      if (res.config_snippet) {
        setSnippet(JSON.stringify(res.config_snippet, null, 2));
      }
      setState("done");
    } catch (err: unknown) {
      const e = err as { status?: number; body?: { reason?: string } };
      if (e.status === 403) {
        setResult(e.body?.reason ?? "Access denied. You may request access below.");
        setState("blocked");
      } else {
        setResult("Something went wrong. Please try again.");
        setState("idle");
      }
    }
  }

  async function handleRequestAccess() {
    setState("requesting");
    try {
      const res = await requestAccess(manifest.record.name, manifest.record.version);
      setResult(res.message);
      setState("requested");
    } catch {
      setResult("Failed to submit access request. Please contact IT.");
      setState("blocked");
    }
  }

  if (!hasMcp) {
    return (
      <div className="rounded-lg bg-gray-50 border border-gray-200 p-4 text-sm text-gray-600">
        This asset does not expose an MCP server and must be installed via the{" "}
        <code className="font-mono text-xs bg-gray-100 px-1 py-0.5 rounded">aria</code> CLI or Agent Framework.
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-gray-200 p-5 space-y-4 bg-white">
      <h3 className="font-semibold text-gray-800">Add to your AI assistant</h3>

      {/* Target selector */}
      <div className="flex gap-2 flex-wrap">
        {(Object.keys(TARGET_LABELS) as Target[]).map((t) => (
          <button
            key={t}
            onClick={() => setTarget(t)}
            className={`px-3 py-1.5 rounded-lg text-sm font-medium border transition-colors ${
              target === t
                ? "bg-aria-700 text-white border-aria-700"
                : "bg-white text-gray-600 border-gray-300 hover:border-aria-300"
            }`}
          >
            {TARGET_LABELS[t]}
          </button>
        ))}
      </div>

      {/* Action */}
      {state === "idle" && (
        <button
          onClick={handleInstall}
          className="w-full py-2.5 bg-aria-700 text-white rounded-lg font-medium hover:bg-aria-800 transition-colors focus:outline-none focus:ring-2 focus:ring-aria-600"
        >
          Add to {TARGET_LABELS[target]} →
        </button>
      )}

      {state === "loading" && (
        <div className="w-full py-2.5 bg-aria-100 text-aria-700 rounded-lg font-medium text-center">
          Preparing…
        </div>
      )}

      {state === "done" && (
        <div className="space-y-3">
          <div className="rounded-lg bg-green-50 border border-green-200 p-3 text-sm text-green-800">
            ✅ {result}
          </div>
          {snippet && (
            <div>
              <p className="text-xs text-gray-500 mb-1">Add this to your config:</p>
              <pre className="bg-gray-900 text-green-400 rounded-lg p-3 text-xs overflow-x-auto whitespace-pre-wrap">
                {snippet}
              </pre>
            </div>
          )}
        </div>
      )}

      {state === "blocked" && (
        <div className="space-y-3">
          <div className="rounded-lg bg-orange-50 border border-orange-200 p-3 text-sm text-orange-800">
            🔒 {result}
          </div>
          <button
            onClick={handleRequestAccess}
            className="w-full py-2.5 bg-white border border-aria-300 text-aria-700 rounded-lg font-medium hover:bg-aria-50 transition-colors"
          >
            Request Access →
          </button>
        </div>
      )}

      {state === "requesting" && (
        <div className="rounded-lg bg-blue-50 border border-blue-200 p-3 text-sm text-blue-800">
          Submitting your request…
        </div>
      )}

      {state === "requested" && (
        <div className="rounded-lg bg-blue-50 border border-blue-200 p-3 text-sm text-blue-800">
          📬 {result}
        </div>
      )}

      {/* MCPB download link */}
      {manifest.mcpb_url && (
        <div className="pt-2 border-t border-gray-100">
          <a
            href={manifest.mcpb_url}
            download
            className="text-xs text-gray-500 hover:text-aria-700 transition-colors"
          >
            ↓ Download .mcpb bundle (for enterprise Claude Desktop)
          </a>
        </div>
      )}
    </div>
  );
}
