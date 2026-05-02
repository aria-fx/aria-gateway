// OASF (Open Agentic Schema Framework) type definitions
// Based on: https://github.com/aria-fx/aria

export interface OasfSkill {
  id: number;
  name: string; // e.g., "nlp/nlu/intent_classification"
}

export interface OasfDomain {
  name: string; // e.g., "human_resources/onboarding"
}

export interface OasfModule {
  type: "mcp_server" | "knowledge_base" | "prompt_bundle" | "orchestration_config" | "evaluation";
  transport?: "stdio" | "http" | "sse";
  tools?: string[];
  ref?: string;
  endpoint?: string;
  [key: string]: unknown;
}

export interface OasfLocator {
  type: "oci" | "github" | "http";
  uri: string;
}

export type LifecycleState = "draft" | "review" | "published" | "deprecated" | "archived";

export type SensitivityTier = "public" | "internal" | "confidential" | "highly_confidential";

export interface OasfRecord {
  name: string;           // domain-based: "aria.dev/agents/onboarding-assistant"
  version: string;        // semver
  schema_version: string;
  description: string;
  skills: OasfSkill[];
  domains: OasfDomain[];
  modules: OasfModule[];
  locators?: OasfLocator[];
  authors: string[];
  created_at: string;
  updated_at: string;
  lifecycle_state: LifecycleState;
  tags?: string[];
}

export interface OasfGovernance {
  sensitivity_tier: SensitivityTier;
  data_classifications?: string[];
  approval_chain?: string[];
  allowed_consumers?: string[];
  max_data_retention_days?: number;
  audit_level?: "minimal" | "standard" | "full";
  dependency_sensitivity_ceiling?: SensitivityTier;
  compliance_frameworks?: string[];
}

export interface CatalogAsset {
  record: OasfRecord;
  governance: OasfGovernance;
}

// Catalog API response shapes
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

export type TrustBadge =
  | "approved-security"
  | "approved-it"
  | "internal-use"
  | "public"
  | "restricted";

export interface AssetManifest {
  record: OasfRecord;
  governance: OasfGovernance;
  install_url: string;
  mcpb_url: string | null;
}

export interface InstallResult {
  success: boolean;
  target: string;
  asset: string;
  version: string;
  message: string;
  config_snippet?: Record<string, unknown>;
}

export interface AccessRequestResult {
  request_id: string;
  status: "pending";
  asset: string;
  version: string;
  approval_chain: string[];
  message: string;
}

export interface GovernanceCheckResult {
  allowed: boolean;
  reason?: string;
  approval_chain?: string[];
  action_url?: string;
}
