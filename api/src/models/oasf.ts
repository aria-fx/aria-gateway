// OASF (Open Agentic Schema Framework) type definitions
// Based on: https://github.com/aria-fx/aria

// Policy contract types are defined in ./policy-contract.ts and re-exported
// here for convenience.  New code should import directly from policy-contract.
export type {
  IdentityProvider,
  NormalizedIdentity,
  EffectiveAccessContext,
  PolicyDecision,
  PolicyContractVersion,
} from "./policy-contract.js";
export { POLICY_CONTRACT_VERSION, withContractVersion } from "./policy-contract.js";

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
  /**
   * Entra group object IDs or display names that are permitted to access
   * this asset.  When set, the consumer must present a validated JWT whose
   * `groups` claim contains at least one of the listed values.
   * Omit (or leave empty) to impose no group-level constraint.
   */
  allowed_entra_groups?: string[];
  /**
   * Entra application roles (or OAuth scopes) that are required to access
   * this asset.  When set, the consumer must present a validated JWT whose
   * `roles`/`scp` claims contain at least one of the listed values.
   * Omit (or leave empty) to impose no role-level constraint.
   */
  allowed_entra_roles?: string[];
  /**
   * Purview roles (from `EffectiveAccessContext.purview_roles`) that are
   * required to access this asset.  When set, the consumer must hold at
   * least one of the listed purview roles.
   *
   * Well-known values: "purview:compliance-officer", "purview:export-approver",
   * "purview:audit-reader".  Custom purview roles are allowed.
   * Omit (or leave empty) to impose no purview-role constraint.
   */
  required_purview_roles?: string[];
  /**
   * Maximum cumulative spend (expressed in `budget_currency`) allowed for
   * this asset before install and invoke flows are blocked.  When the total
   * recorded spend from the cost service meets or exceeds this value the
   * gateway returns a 402 response and emits a `budget.enforcement`
   * observability event.
   *
   * Omit (or set to undefined) to impose no budget-based enforcement.
   */
  budget_threshold?: number;
  /**
   * ISO 4217 currency code for `budget_threshold` (e.g. "USD", "EUR").
   * Defaults to "USD" when `budget_threshold` is set but `budget_currency`
   * is omitted.
   */
  budget_currency?: string;
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
  modelAffinity: {
    optimal_model: string | null;
  };
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

/**
 * @deprecated Use {@link PolicyDecision} from `./policy-contract.js` instead.
 * Retained for backward compatibility; will be removed in contract v2.
 */
export interface GovernanceCheckResult {
  allowed: boolean;
  reason?: string;
  approval_chain?: string[];
  action_url?: string;
}
