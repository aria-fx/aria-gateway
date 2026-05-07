import { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { getAssetManifest } from "../api/catalog.ts";
import type { AssetManifest } from "../api/types.ts";
import { TrustBadgeTag, SensitivityTag } from "../components/TrustBadge.tsx";
import { InstallPanel } from "../components/InstallPanel.tsx";

// Extract the display name from "Name <email>" formatted author strings.
function extractAuthorName(author: string): string {
  const match = /^([^<]+)/.exec(author);
  return match ? match[1].trim() : author.trim();
}

function getTrustBadge(manifest: AssetManifest) {
  const tier = manifest.governance.sensitivity_tier;
  const frameworks = manifest.governance.compliance_frameworks ?? [];

  if (tier === "public") return "public" as const;
  if (tier === "highly_confidential") return "restricted" as const;
  if (frameworks.includes("HIPAA") || frameworks.includes("SOX")) return "approved-security" as const;
  if (tier === "confidential") return "approved-it" as const;
  return "internal-use" as const;
}

export function AssetDetailPage() {
  const { name, version } = useParams<{ name: string; version: string }>();
  const [manifest, setManifest] = useState<AssetManifest | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!name || !version) return;
    setLoading(true);
    setError(null);
    getAssetManifest(decodeURIComponent(name), version)
      .then(setManifest)
      .catch((err: { status?: number }) => {
        if (err.status === 403) {
          setError("You don't have permission to view this skill. You can request access below.");
        } else if (err.status === 404) {
          setError("This skill could not be found in the catalog.");
        } else {
          setError("Unable to load skill details. Please try again.");
        }
      })
      .finally(() => setLoading(false));
  }, [name, version]);

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center text-gray-400">
        <div className="text-center">
          <div className="text-4xl mb-3">⏳</div>
          <p>Loading skill details…</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
        <div className="bg-white rounded-xl border border-red-200 p-8 max-w-md text-center space-y-4">
          <div className="text-4xl">⚠️</div>
          <p className="text-red-700 font-medium">{error}</p>
          {name && version && error.includes("permission") && (
            <a
              href={`/catalog/assets/${encodeURIComponent(decodeURIComponent(name ?? ""))}/${version}/request-access`}
              className="inline-block px-4 py-2 bg-aria-700 text-white rounded-lg text-sm font-medium hover:bg-aria-800 transition-colors"
            >
              Request Access →
            </a>
          )}
          <div>
            <Link to="/" className="text-sm text-aria-700 hover:underline">
              ← Back to catalog
            </Link>
          </div>
        </div>
      </div>
    );
  }

  if (!manifest) return null;

  const { record, governance } = manifest;
  const displayName =
    record.name.split("/").pop()?.replace(/-/g, " ") ?? record.name;

  const tools = record.modules
    .filter((m) => m.type === "mcp_server")
    .flatMap((m) => m.tools ?? []);

  const updatedDate = new Date(record.updated_at).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });

  const trustBadge = getTrustBadge(manifest);

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Breadcrumb */}
      <div className="bg-white border-b border-gray-200">
        <div className="max-w-5xl mx-auto px-4 py-3 text-sm text-gray-500">
          <Link to="/" className="hover:text-aria-700 transition-colors">
            ← Catalog
          </Link>
          <span className="mx-2">›</span>
          <span className="text-gray-800 font-medium capitalize">{displayName}</span>
        </div>
      </div>

      <main className="max-w-5xl mx-auto px-4 py-8">
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          {/* Left: Details */}
          <div className="lg:col-span-2 space-y-6">
            {/* Header */}
            <div className="bg-white rounded-xl border border-gray-200 p-6">
              <div className="flex items-start gap-4">
                <div className="text-5xl leading-none">🤖</div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <h1 className="text-2xl font-bold text-gray-900 capitalize">
                      {displayName}
                    </h1>
                    <span className="text-sm text-gray-400 bg-gray-100 px-2 py-0.5 rounded-full">
                      v{record.version}
                    </span>
                  </div>
                  <p className="text-sm text-gray-500 mt-1">{record.name}</p>
                  <div className="flex items-center gap-2 mt-2 flex-wrap">
                    <TrustBadgeTag badge={trustBadge} showDescription />
                    <SensitivityTag tier={governance.sensitivity_tier} />
                  </div>
                </div>
              </div>

              <p className="mt-4 text-gray-700 leading-relaxed">{record.description}</p>

              <div className="mt-4 flex flex-wrap gap-2">
                {(record.tags ?? []).map((tag) => (
                  <span
                    key={tag}
                    className="px-2 py-0.5 bg-aria-50 text-aria-700 text-xs rounded-full border border-aria-100"
                  >
                    {tag}
                  </span>
                ))}
              </div>
            </div>

            {/* What it can do */}
            {tools.length > 0 && (
              <div className="bg-white rounded-xl border border-gray-200 p-6">
                <h2 className="font-semibold text-gray-800 mb-3">What this skill can do</h2>
                <ul className="space-y-2">
                  {tools.map((tool) => (
                    <li key={tool} className="flex items-center gap-2 text-sm text-gray-700">
                      <span className="text-aria-500">▸</span>
                      <span className="font-mono bg-gray-50 px-2 py-0.5 rounded text-xs border border-gray-200">
                        {tool}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* Departments */}
            <div className="bg-white rounded-xl border border-gray-200 p-6">
              <h2 className="font-semibold text-gray-800 mb-3">Available for</h2>
              <div className="flex flex-wrap gap-2">
                {record.domains.map((d) => (
                  <span
                    key={d.name}
                    className="px-3 py-1 bg-blue-50 text-blue-700 text-sm rounded-full border border-blue-100"
                  >
                    {d.name.replace(/\//g, " › ").replace(/_/g, " ")}
                  </span>
                ))}
              </div>
            </div>

            {/* Governance */}
            <div className="bg-white rounded-xl border border-gray-200 p-6">
              <h2 className="font-semibold text-gray-800 mb-4">Compliance & Governance</h2>
              <dl className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
                {governance.compliance_frameworks && governance.compliance_frameworks.length > 0 && (
                  <div>
                    <dt className="text-gray-500 text-xs uppercase tracking-wide mb-1">Compliance</dt>
                    <dd className="font-medium text-gray-800">
                      {governance.compliance_frameworks.join(", ")}
                    </dd>
                  </div>
                )}
                {governance.data_classifications && governance.data_classifications.length > 0 && (
                  <div>
                    <dt className="text-gray-500 text-xs uppercase tracking-wide mb-1">Data handled</dt>
                    <dd className="font-medium text-gray-800">
                      {governance.data_classifications.join(", ")}
                    </dd>
                  </div>
                )}
                {governance.audit_level && (
                  <div>
                    <dt className="text-gray-500 text-xs uppercase tracking-wide mb-1">Audit level</dt>
                    <dd className="font-medium text-gray-800 capitalize">{governance.audit_level}</dd>
                  </div>
                )}
                {governance.max_data_retention_days && (
                  <div>
                    <dt className="text-gray-500 text-xs uppercase tracking-wide mb-1">Data retention</dt>
                    <dd className="font-medium text-gray-800">
                      {governance.max_data_retention_days} days max
                    </dd>
                  </div>
                )}
                <div>
                  <dt className="text-gray-500 text-xs uppercase tracking-wide mb-1">Published by</dt>
                  <dd className="font-medium text-gray-800">
                    {record.authors.map((a) => extractAuthorName(a)).join(", ")}
                  </dd>
                </div>
                <div>
                  <dt className="text-gray-500 text-xs uppercase tracking-wide mb-1">Last updated</dt>
                  <dd className="font-medium text-gray-800">{updatedDate}</dd>
                </div>
              </dl>
            </div>
          </div>

          {/* Right: Install */}
          <div className="space-y-4">
            <InstallPanel manifest={manifest} />

            {/* Raw manifest link */}
            <a
              href={`/catalog/assets/${encodeURIComponent(record.name)}/${record.version}/manifest`}
              target="_blank"
              rel="noopener noreferrer"
              className="block text-center text-xs text-gray-400 hover:text-aria-700 transition-colors py-2"
            >
              View raw OASF manifest ↗
            </a>
          </div>
        </div>
      </main>
    </div>
  );
}
