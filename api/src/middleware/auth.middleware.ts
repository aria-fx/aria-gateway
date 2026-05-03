/**
 * JWT Auth Middleware — Entra-first bearer token validation.
 *
 * Behaviour controlled by environment variables:
 *
 *   AUTH_ENFORCE        - "true" to reject requests with invalid/missing tokens.
 *                         Defaults to "false" (permissive / observability mode).
 *   ENTRA_TENANT_ID     - Azure AD tenant ID used to build the expected issuer URL.
 *   ENTRA_AUDIENCE      - Expected `aud` claim (app/client ID or URI).
 *   LEGACY_HEADERS_MODE - "enabled" (default) to honour x-consumer-id /
 *                         x-sensitivity-ceiling headers when no JWT is present.
 *                         Set to "disabled" to reject header-only requests with
 *                         an anonymous / public-only access context.
 *                         See governance.service.ts for full precedence rules.
 *                         @deprecated Will be removed on 2027-01-01.
 *
 * When AUTH_ENFORCE=false (default) the middleware still validates any token
 * that IS present (attaching req.identity on success) but never blocks a
 * request that has no token or an invalid one.
 */

import type { Request, Response, NextFunction } from "express";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import type { NormalizedIdentity } from "../models/policy-contract.js";
import { POLICY_CONTRACT_VERSION } from "../models/policy-contract.js";
import type { SensitivityTier } from "../models/oasf.js";
import { emitAuthFailure } from "../services/observability.service.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface AuthMiddlewareOptions {
  /**
   * When true, requests with missing or invalid tokens are rejected with 401.
   * Defaults to the AUTH_ENFORCE environment variable (false if unset).
   */
  enforce?: boolean;

  /**
   * Expected `iss` (issuer) claim.
   * Defaults to the Entra v2.0 issuer derived from ENTRA_TENANT_ID env var.
   */
  issuer?: string;

  /**
   * Expected `aud` (audience) claim.
   * Defaults to the ENTRA_AUDIENCE env var.
   */
  audience?: string;

  /**
   * JWKS URI to fetch public keys from.
   * Defaults to the Entra v2.0 JWKS endpoint derived from ENTRA_TENANT_ID.
   */
  jwksUri?: string;

  /**
   * Injected JWKS fetcher — used in tests to avoid live network calls.
   * Must conform to the ReturnType of `createRemoteJWKSet`.
   */
  jwksProvider?: ReturnType<typeof createRemoteJWKSet>;
}

// ---------------------------------------------------------------------------
// Claim-to-identity normalization helpers
// ---------------------------------------------------------------------------

/**
 * Role group names that map to elevated sensitivity ceilings.
 * The highest matching role wins.
 */
const SENSITIVITY_ROLES: Record<string, SensitivityTier> = {
  "aria-gateway-admin": "highly_confidential",
  "aria-gateway-confidential": "confidential",
  "aria-gateway-internal": "internal",
};

/**
 * Derive a sensitivity ceiling from an Entra token's `roles` / `groups` claims.
 * Falls back to "internal" so that authenticated-but-unlabelled users get
 * the same default as the header-based path.
 */
function deriveSensitivityCeiling(roles: string[]): SensitivityTier {
  if (roles.includes("aria-gateway-admin")) return "highly_confidential";
  if (roles.includes("aria-gateway-confidential")) return "confidential";
  return "internal";
}

/**
 * Well-known Entra-specific claims merged into `extensions`.
 */
interface EntraClaims extends JWTPayload {
  /** User's UPN / email */
  upn?: string;
  /** Employee OID, same as `sub` for user tokens */
  oid?: string;
  /** Application roles array */
  roles?: string[];
  /** OAuth scopes (space-separated string) */
  scp?: string;
  /** Group OIDs */
  groups?: string[];
  /** Preferred username */
  preferred_username?: string;
  /** Display name */
  name?: string;
  /** UPN-based email */
  email?: string;
  /** Tenant ID */
  tid?: string;
}

/**
 * Map a validated JWT payload to a {@link NormalizedIdentity}.
 */
export function normalizeEntraClaims(payload: EntraClaims): NormalizedIdentity {
  const roles: string[] = [
    ...(payload.roles ?? []),
    ...(payload.scp ? payload.scp.split(" ").filter(Boolean) : []),
  ];

  const groups: string[] = payload.groups ?? [];

  const extensions: Record<string, unknown> = {};
  if (payload.oid) extensions["entra:oid"] = payload.oid;
  if (payload.tid) extensions["entra:tid"] = payload.tid;
  if (payload.upn) extensions["entra:upn"] = payload.upn;
  if (payload.preferred_username) {
    extensions["entra:preferred_username"] = payload.preferred_username;
  }

  return {
    contract_version: POLICY_CONTRACT_VERSION,
    provider: "entra",
    principal_id: (payload.oid ?? payload.sub) as string,
    display_name: payload.name,
    email: payload.email ?? payload.upn ?? payload.preferred_username,
    groups,
    roles,
    tenant: payload.tid,
    extensions,
  };
}

// ---------------------------------------------------------------------------
// JWKS cache
// ---------------------------------------------------------------------------

// Module-level cache so the same JWKS set is reused across requests.
const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function getJwksProvider(
  jwksUri: string,
  injected?: ReturnType<typeof createRemoteJWKSet>
): ReturnType<typeof createRemoteJWKSet> {
  if (injected) return injected;
  if (!jwksCache.has(jwksUri)) {
    jwksCache.set(
      jwksUri,
      createRemoteJWKSet(new URL(jwksUri), {
        // Re-fetch JWKS after 10 minutes to handle key rotation
        cacheMaxAge: 10 * 60 * 1000,
      })
    );
  }
  return jwksCache.get(jwksUri)!;
}

// ---------------------------------------------------------------------------
// Middleware factory
// ---------------------------------------------------------------------------

/**
 * Create the JWT auth middleware with the given options.
 *
 * @example
 * ```ts
 * app.use(createAuthMiddleware());                       // permissive
 * app.use(createAuthMiddleware({ enforce: true }));      // strict
 * ```
 */
export function createAuthMiddleware(opts: AuthMiddlewareOptions = {}) {
  const enforce =
    opts.enforce ?? process.env.AUTH_ENFORCE === "true";

  const tenantId = process.env.ENTRA_TENANT_ID;

  const issuer =
    opts.issuer ??
    (tenantId
      ? `https://login.microsoftonline.com/${tenantId}/v2.0`
      : undefined);

  const audience =
    opts.audience ?? process.env.ENTRA_AUDIENCE;

  const jwksUri =
    opts.jwksUri ??
    (tenantId
      ? `https://login.microsoftonline.com/${tenantId}/discovery/v2.0/keys`
      : undefined);

  return async function authMiddleware(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    const authHeader = req.headers["authorization"];

    // No token present
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      if (enforce) {
        emitAuthFailure({ mode: "enforce", reason: "token_missing" });
        res.status(401).json({
          error: "Unauthorized",
          message: "Missing or malformed Authorization header.",
        });
        return;
      }
      emitAuthFailure({ mode: "observe", reason: "token_missing" });
      return next();
    }

    const token = authHeader.slice(7); // strip "Bearer "

    // If no JWKS URI is configured we cannot validate the token.
    if (!jwksUri) {
      if (enforce) {
        emitAuthFailure({ mode: "enforce", reason: "jwks_unconfigured" });
        res.status(401).json({
          error: "Unauthorized",
          message: "Auth enforcement is enabled but no JWKS URI is configured.",
        });
        return;
      }
      emitAuthFailure({ mode: "observe", reason: "jwks_unconfigured" });
      return next();
    }

    try {
      const jwks = getJwksProvider(jwksUri, opts.jwksProvider);

      const verifyOptions: Parameters<typeof jwtVerify>[2] = {};
      if (issuer) verifyOptions.issuer = issuer;
      if (audience) verifyOptions.audience = audience;

      const { payload } = await jwtVerify(token, jwks, verifyOptions);
      req.identity = normalizeEntraClaims(payload as EntraClaims);
      return next();
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : "Token validation failed.";
      if (enforce) {
        emitAuthFailure({ mode: "enforce", reason: "token_invalid", error_message: errorMessage });
        res.status(401).json({ error: "Unauthorized", message: errorMessage });
        return;
      }
      // Non-enforcing (observe) mode: log and continue — let downstream decide
      emitAuthFailure({ mode: "observe", reason: "token_invalid", error_message: errorMessage });
      return next();
    }
  };
}

// ---------------------------------------------------------------------------
// Convenience export — derive sensitivity ceiling from identity
// ---------------------------------------------------------------------------

/**
 * Given a {@link NormalizedIdentity} (from a validated Entra token), return
 * the appropriate sensitivity ceiling based on the principal's roles.
 */
export function sensitivityCeilingFromIdentity(
  identity: NormalizedIdentity
): SensitivityTier {
  return deriveSensitivityCeiling(identity.roles);
}
