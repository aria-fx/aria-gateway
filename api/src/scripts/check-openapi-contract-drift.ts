import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildOpenApiSpec } from "../routes/plugins.js";
import {
  buildDriftReport,
  collectOpenApiDifferences,
  type DriftDifference,
  type DriftException,
  type JsonValue,
} from "../contracts/openapi-drift.js";

const CURRENT_DIR = fileURLToPath(new URL(".", import.meta.url));
const API_DIR = resolve(CURRENT_DIR, "..", "..");
const ARCHITECTURE_SPEC_PATH = resolve(API_DIR, "docs", "catalog-api.architecture.openapi.json");
const EXCEPTIONS_PATH = resolve(API_DIR, "docs", "catalog-api.drift-exceptions.json");

function readJsonFile<T>(filePath: string): T {
  return JSON.parse(readFileSync(filePath, "utf-8")) as T;
}

function readExceptions(filePath: string): DriftException[] {
  const parsed = readJsonFile<unknown>(filePath);
  if (!Array.isArray(parsed)) {
    throw new Error(`Exceptions file must be a JSON array: ${filePath}`);
  }
  return parsed as DriftException[];
}

function formatDifference(diff: DriftDifference): string {
  const architecture = diff.architectureValue === undefined ? "—" : JSON.stringify(diff.architectureValue);
  const runtime = diff.runtimeValue === undefined ? "—" : JSON.stringify(diff.runtimeValue);
  return `- [${diff.kind}] ${diff.pointer}\n  architecture: ${truncate(architecture)}\n  runtime:      ${truncate(runtime)}`;
}

function truncate(value: string, maxLength = 180): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`;
}

function main(): void {
  try {
    const architectureSpec = readJsonFile<JsonValue>(ARCHITECTURE_SPEC_PATH);
    const runtimeSpec = buildOpenApiSpec() as unknown as JsonValue;
    const exceptions = readExceptions(EXCEPTIONS_PATH);

    const differences = collectOpenApiDifferences(architectureSpec, runtimeSpec);
    const report = buildDriftReport(differences, exceptions, new Date());

    console.log("OpenAPI contract sync gate");
    console.log(`- architecture spec: ${ARCHITECTURE_SPEC_PATH}`);
    console.log(`- exceptions file:   ${EXCEPTIONS_PATH}`);
    console.log(`- total diffs:       ${report.differences.length}`);
    console.log(`- approved diffs:    ${report.approved.length}`);
    console.log(`- unapproved diffs:  ${report.unapproved.length}`);
    console.log(`- expired exceptions:${report.expiredExceptions.length}`);
    console.log(`- invalid exceptions:${report.invalidExceptions.length}`);

    if (report.expiredExceptions.length > 0) {
      console.error("\nExpired exceptions:");
      for (const exception of report.expiredExceptions) {
        console.error(`- ${exception.id} (${exception.pointer}) expired on ${exception.expiresOn} — ${exception.reason}`);
      }
    }

    if (report.invalidExceptions.length > 0) {
      console.error("\nInvalid exceptions:");
      for (const entry of report.invalidExceptions) {
        console.error(`- ${entry.exception.id} (${entry.exception.pointer}): ${entry.issue}`);
      }
    }

    if (report.unapproved.length > 0) {
      console.error("\nUnapproved OpenAPI drift:");
      for (const diff of report.unapproved) {
        console.error(formatDifference(diff));
      }
      process.exitCode = 1;
      return;
    }

    if (report.expiredExceptions.length > 0 || report.invalidExceptions.length > 0) {
      process.exitCode = 1;
      return;
    }

    console.log("\n✅ OpenAPI contract is in sync or fully covered by active exceptions.");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`OpenAPI contract sync gate failed to run: ${message}`);
    process.exitCode = 1;
  }
}

main();
