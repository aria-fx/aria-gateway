import type { NormalizedIdentity } from "../models/policy-contract.js";

declare global {
  namespace Express {
    interface Request {
      /**
       * Normalized identity resolved from a validated bearer token.
       * Populated by the JWT auth middleware when a valid token is present.
       * Absent for unauthenticated or header-only requests.
       */
      identity?: NormalizedIdentity;
    }
  }
}
