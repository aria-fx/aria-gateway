import { Link } from "react-router-dom";
import type { AssetListItem } from "../api/types.ts";
import { TrustBadgeTag, SensitivityTag } from "./TrustBadge.tsx";

interface AssetCardProps {
  asset: AssetListItem;
}

const DOMAIN_ICON: Record<string, string> = {
  human_resources: "👥",
  engineering: "⚙️",
  finance: "💰",
  sales: "📈",
  productivity: "⚡",
};

function domainIcon(domains: string[]): string {
  const top = domains[0]?.split("/")[0] ?? "";
  return DOMAIN_ICON[top] ?? "🤖";
}

export function AssetCard({ asset }: AssetCardProps) {
  const encodedName = encodeURIComponent(asset.name);
  const tools = asset.skills.length;
  const topDomain = asset.domains[0]?.split("/")[0]?.replace(/_/g, " ") ?? "General";
  const updatedDate = new Date(asset.updated_at).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });

  return (
    <article className="bg-white rounded-xl border border-gray-200 p-5 flex flex-col gap-3 hover:shadow-md hover:border-aria-300 transition-all group">
      <div className="flex items-start gap-3">
        <div className="text-3xl leading-none mt-0.5" aria-hidden="true">
          {domainIcon(asset.domains)}
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap mb-1">
            <Link
              to={`/assets/${encodedName}/${asset.version}`}
              className="font-semibold text-gray-900 group-hover:text-aria-700 transition-colors truncate"
            >
              {asset.name.split("/").pop()?.replace(/-/g, " ") ?? asset.name}
            </Link>
            <span className="text-xs text-gray-400 shrink-0">v{asset.version}</span>
          </div>
          <p className="text-gray-500 text-xs capitalize">{topDomain}</p>
        </div>

        <TrustBadgeTag badge={asset.trust_badge} showDescription />
      </div>

      <p className="text-sm text-gray-600 line-clamp-2 leading-relaxed">
        {asset.description}
      </p>

      <div className="flex items-center justify-between mt-auto pt-2 border-t border-gray-100">
        <div className="flex items-center gap-3 text-xs text-gray-400">
          <SensitivityTag tier={asset.sensitivity_tier} />
          {tools > 0 && (
            <span title="Number of AI capabilities">
              🛠 {tools} {tools === 1 ? "skill" : "skills"}
            </span>
          )}
          <span title="Last updated">Updated {updatedDate}</span>
        </div>

        <Link
          to={`/assets/${encodedName}/${asset.version}`}
          className="text-xs font-medium text-aria-700 hover:text-aria-900 transition-colors"
        >
          Details →
        </Link>
      </div>
    </article>
  );
}
