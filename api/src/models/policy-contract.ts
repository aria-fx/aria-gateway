/**
 * ARIA Gateway – Auth-Core Policy Contract
 *
 * Version: 1.0.0
 *
 * Language-neutral contract for identity input, effective access, and
 * governance decisions shared between the .NET auth-core library and
 * this TypeScript gateway implementation.
 *
 * Schema location: api/docs/policy-contract.schema.json
 * Documentation:   api/docs/policy-contract.md
 */

import type { SensitivityTier } from "./oasf.js";

// ---------------------------------------------------------------------------
// Versioning
// ---------------------------------------------------------------------------

/** Current contract schema version (semver). */
export const POLICY_CONTRACT_VERSION = "1.0.0" as const;

/** Type alias for the version literal. */
export type PolicyContractVersion = typeof POLICY_CONTRACT_VERSION;

// ---------------------------------------------------------------------------
// Identity providers
// ---------------------------------------------------------------------------

/**
 * Well-known identity provider slugs.
 * Use a free-form string for custom/enterprise IDPs (see extension points in
 * api/docs/policy-contract.md).
 */
export type IdentityProvider =
  | "entra"      // Microsoft Entra ID (Azure AD)
  | "okta"       // Okta Workforce Identity
  | "github"     // GitHub OAuth / GitHub Actions OIDC
  | "cognito"    // AWS Cognito
  | "google"     // Google Workspace / Cloud Identity
  | (string & {}); // extensible: any IDP slug

// ---------------------------------------------------------------------------
// NormalizedIdentity
// ---------------------------------------------------------------------------

/**
 * Normalized identity resolved from an upstream identity provider.
 *
 * All fields map directly to standard OIDC/OAuth claims so that the
 * consuming code remains IDP-agnostic.  IDP-specific claims that have
 * no canonical mapping belong in the `extensions` bag.
 */
export interface NormalizedIdentity {
  /** Contract schema version that produced this object. */
  contract_version: PolicyContractVersion;

  /** Identity provider that authenticated this principal. */
  provider: IdentityProvider;

  /**
   * Immutable principal identifier.
   * Maps to the OIDC `sub` claim or the provider's object/user ID.
   */
  principal_id: string;

  /** Human-readable display name (`name` claim). Optional. */
  display_name?: string;

  /** Verified email address (`email` claim). Optional. */
  email?: string;

  /**
   * Group memberships expressed as stable identifiers.
   * For Entra this is the list of AAD group object IDs or display names.
   * For GitHub this is the list of team slugs.
   */
  groups: string[];

  /**
   * Application roles and/or OAuth scopes granted to this principal.
   * Combines the OIDC `roles` claim and the `scp`/`scope` claim into
   * a single de-duplicated list.
   */
  roles: string[];

  /**
   * Tenant or organization identifier.
   * For Entra this is the AAD tenant ID.
   * For GitHub this is the org slug.
   * Optional for single-tenant deployments.
   */
  tenant?: string;

  /**
   * Arbitrary IDP-specific extensions.
   * Use this bag for claims that have no canonical mapping above (e.g.
   * department, cost-center, custom attributes).  Keys should be
   * namespaced to avoid collisions: `"entra:employee_id"`.
   */
  extensions?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// EffectiveAccessContext
// ---------------------------------------------------------------------------

/**
 * Effective access context derived from an authenticated identity and the
 * gateway's policy engine.
 *
 * This is the "resolved" form of a consumer's access rights that the
 * governance service evaluates against each asset's policy overlay.
 */
export interface EffectiveAccessContext {
  /** Contract schema version that produced this object. */
  contract_version: PolicyContractVersion;

  /**
   * Consumer team / application identifier.
   * Matches the `allowed_consumers` list in OASF governance overlays.
   * Sourced from the `X-Consumer-Id` header or derived from `identity`.
   */
  consumer_id: string;

  /**
   * Maximum sensitivity tier this consumer is cleared to access.
   * Sourced from the `X-Sensitivity-Ceiling` header or derived from
   * group/role membership during token validation.
   */
  sensitivity_ceiling: SensitivityTier;

  /**
   * Fine-grained purview roles that control cross-cutting governance
   * decisions such as export approval, audit bypass, or data residency
   * overrides.  An empty array means no elevated purview is granted.
   *
   * Well-known values: "purview:export-approver", "purview:audit-reader",
   * "purview:compliance-officer".
   */
  purview_roles: string[];

  /**
   * Originating normalized identity (if available).
   * Populated when the gateway has a validated bearer token; absent for
   * header-only or anonymous requests.
   */
  identity?: NormalizedIdentity;
}

// ---------------------------------------------------------------------------
// PolicyDecision
// ---------------------------------------------------------------------------

/**
 * Result of a governance policy evaluation for a single asset + consumer
 * pair.
 *
 * Returned by the gateway's `checkGovernance` function and by the
 * auth-core `PolicyEngine.Evaluate()` method in .NET.
 */
export interface PolicyDecision {
  /** Contract schema version that produced this object. */
  contract_version: PolicyContractVersion;

  /** `true` if the consumer is permitted to access the asset. */
  allowed: boolean;

  /**
   * Human-readable explanation of why access was denied.
   * Always set when `allowed` is `false`; omitted otherwise.
   */
  reason?: string;

  /**
   * Ordered list of approver identifiers that must grant access before
   * the consumer can proceed.  Each entry is a team slug or a named
   * individual.
   */
  approval_chain?: string[];

  /**
   * URL the consumer can visit (or POST to) to submit an access request.
   * Points to the gateway's `/catalog/assets/{name}/{version}/request-access`
   * endpoint when the denial was caused by a governance policy.
   */
  action_url?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Stamp `contract_version` onto any partial object.
 * Utility used by service layer functions that build contract objects.
 */
export function withContractVersion<T extends object>(
  obj: T
): T & { contract_version: PolicyContractVersion } {
  return { ...obj, contract_version: POLICY_CONTRACT_VERSION };
}
