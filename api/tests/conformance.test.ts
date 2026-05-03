/**
 * Cross-language policy conformance test runner.
 *
 * Loads `tests/fixtures/conformance-cases.json` and replays each case
 * through the gateway's `checkGovernance` function, asserting that the
 * resulting `PolicyDecision` matches the fixture's `expected` outcome.
 *
 * The same fixture file can be consumed by any auth-core implementation
 * (e.g. the .NET `PolicyEngine`) to verify cross-language policy parity.
 *
 * To add a new case, edit `tests/fixtures/conformance-cases.json` and follow
 * the instructions in `docs/conformance-fixtures.md`.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { checkGovernance, type ConsumerContext } from "../src/services/governance.service.js";
import type { CatalogAsset } from "../src/models/oasf.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Fixture types
// ---------------------------------------------------------------------------

interface ConformanceExpectation {
  /** Whether `checkGovernance` should return `allowed: true` or `allowed: false`. */
  allowed: boolean;
  /**
   * Substring that must appear in `decision.reason` when `allowed` is false.
   * Omit for allow cases or when the exact denial text is not significant.
   */
  reason_contains?: string;
}

interface ConformanceCase {
  /** Unique, stable identifier (e.g. "CF-001"). */
  id: string;
  /** Human-readable description of the scenario. */
  description: string;
  /** Policy dimension tags (e.g. "sensitivity", "allow-list", "groups"). */
  tags: string[];
  /** Asset under evaluation. */
  asset: CatalogAsset;
  /** Consumer requesting access. */
  consumer: ConsumerContext;
  /** Expected outcome of `checkGovernance(asset, consumer)`. */
  expected: ConformanceExpectation;
}

interface ConformanceFixtureFile {
  /** Semver of the fixture schema itself. */
  fixture_version: string;
  /** Policy contract version these fixtures target. */
  policy_contract_version: string;
  /** Human-readable description of this fixture suite. */
  description: string;
  cases: ConformanceCase[];
}

// ---------------------------------------------------------------------------
// Load fixtures
// ---------------------------------------------------------------------------

const fixtureFile: ConformanceFixtureFile = JSON.parse(
  readFileSync(
    join(__dirname, "fixtures", "conformance-cases.json"),
    "utf-8"
  )
);

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

describe(
  `Policy conformance suite (fixture v${fixtureFile.fixture_version}, ` +
    `contract v${fixtureFile.policy_contract_version})`,
  () => {
    it("fixture file contains at least 10 cases", () => {
      expect(fixtureFile.cases.length).toBeGreaterThanOrEqual(10);
    });

    it("all case IDs are unique", () => {
      const ids = fixtureFile.cases.map((c) => c.id);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it("fixture targets the current policy contract version", () => {
      expect(fixtureFile.policy_contract_version).toBe("1.0.0");
    });

    for (const testCase of fixtureFile.cases) {
      it(`[${testCase.id}] ${testCase.description}`, () => {
        const decision = checkGovernance(testCase.asset, testCase.consumer);

        expect(decision.contract_version).toBe("1.0.0");
        expect(decision.allowed).toBe(testCase.expected.allowed);

        if (testCase.expected.reason_contains !== undefined) {
          expect(decision.reason).toBeDefined();
          expect(decision.reason).toContain(testCase.expected.reason_contains);
        }

        if (testCase.expected.allowed === false) {
          // All deny decisions must include a human-readable reason.
          expect(decision.reason).toBeDefined();
          expect(typeof decision.reason).toBe("string");
          expect((decision.reason as string).length).toBeGreaterThan(0);
        }
      });
    }
  }
);
