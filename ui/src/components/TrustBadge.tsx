import type { TrustBadge, SensitivityTier } from "../api/types.ts";

interface TrustBadgeConfig {
  label: string;
  color: string;
  icon: string;
  description: string;
}

const TRUST_BADGE_CONFIG: Record<TrustBadge, TrustBadgeConfig> = {
  "approved-security": {
    label: "Approved by Security",
    color: "bg-green-100 text-green-800 border-green-200",
    icon: "🛡️",
    description: "Reviewed and approved by the security team",
  },
  "approved-it": {
    label: "Approved by IT",
    color: "bg-blue-100 text-blue-800 border-blue-200",
    icon: "✅",
    description: "Reviewed and approved by IT",
  },
  "internal-use": {
    label: "Internal Use",
    color: "bg-yellow-100 text-yellow-800 border-yellow-200",
    icon: "🏢",
    description: "For organization employees only",
  },
  public: {
    label: "Public",
    color: "bg-gray-100 text-gray-700 border-gray-200",
    icon: "🌐",
    description: "Available to everyone",
  },
  restricted: {
    label: "Restricted",
    color: "bg-red-100 text-red-800 border-red-200",
    icon: "🔒",
    description: "Requires special approval to access",
  },
};

const SENSITIVITY_LABELS: Record<SensitivityTier, { label: string; color: string }> = {
  public: { label: "Public", color: "text-gray-500" },
  internal: { label: "Internal", color: "text-blue-600" },
  confidential: { label: "Confidential", color: "text-orange-600" },
  highly_confidential: { label: "Highly Confidential", color: "text-red-600" },
};

interface TrustBadgeProps {
  badge: TrustBadge;
  showDescription?: boolean;
}

export function TrustBadgeTag({ badge, showDescription }: TrustBadgeProps) {
  const config = TRUST_BADGE_CONFIG[badge];
  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border ${config.color}`}
      title={showDescription ? config.description : undefined}
    >
      <span>{config.icon}</span>
      {config.label}
    </span>
  );
}

interface SensitivityTagProps {
  tier: SensitivityTier;
}

export function SensitivityTag({ tier }: SensitivityTagProps) {
  const config = SENSITIVITY_LABELS[tier];
  return (
    <span className={`text-xs font-medium ${config.color}`}>
      {config.label}
    </span>
  );
}
