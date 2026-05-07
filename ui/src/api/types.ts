export type LifecycleState = "draft" | "review" | "published" | "deprecated" | "archived";
export type SensitivityTier = "public" | "internal" | "confidential" | "highly_confidential";
export type TrustBadge =
  | "approved-security"
  | "approved-it"
  | "internal-use"
  | "public"
  | "restricted";

export interface AssetListItem {
  name: string;
  version: string;
  description: string;
  lifecycle_state: LifecycleState;
  sensitivity_tier: SensitivityTier;
  domains: string[];
  skills: string[];
  trust_badge: TrustBadge;
  tags: string[];
  authors: string[];
  updated_at: string;
}

export interface AssetManifest {
  record: {
    name: string;
    version: string;
    schema_version: string;
    description: string;
    skills: { id: number; name: string }[];
    domains: { name: string }[];
    modules: {
      type: string;
      transport?: string;
      tools?: string[];
      ref?: string;
    }[];
    authors: string[];
    created_at: string;
    updated_at: string;
    lifecycle_state: LifecycleState;
    tags?: string[];
  };
  governance: {
    sensitivity_tier: SensitivityTier;
    data_classifications?: string[];
    approval_chain?: string[];
    allowed_consumers?: string[];
    max_data_retention_days?: number;
    audit_level?: string;
    compliance_frameworks?: string[];
  };
  install_url: string;
  mcpb_url: string | null;
}

export interface CatalogStats {
  total_assets: number;
  by_sensitivity: Record<string, number>;
  by_domain: Record<string, number>;
}

export interface InstallResult {
  success: boolean;
  target: string;
  asset: string;
  version: string;
  message: string;
  config_snippet?: Record<string, unknown>;
}
