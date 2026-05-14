import { describe, expect, it } from "vitest";
import { buildDriftReport, collectOpenApiDifferences, type DriftException } from "../src/contracts/openapi-drift.js";

describe("OpenAPI drift gate", () => {
  it("reports unapproved drift between architecture and runtime specs", () => {
    const architecture = {
      openapi: "3.1.0",
      paths: { "/catalog/assets": { get: { responses: { "200": { description: "ok" } } } } },
    } as const;
    const runtime = {
      openapi: "3.1.0",
      paths: { "/catalog/assets": { get: { responses: { "200": { description: "ok" }, "401": { description: "nope" } } } } },
    } as const;

    const differences = collectOpenApiDifferences(architecture, runtime);
    const report = buildDriftReport(differences, [], new Date("2026-05-14T00:00:00.000Z"));

    expect(report.unapproved).toHaveLength(1);
    expect(report.unapproved[0]?.pointer).toBe("/paths/~1catalog~1assets/get/responses/401");
    expect(report.unapproved[0]?.kind).toBe("missing_in_architecture");
  });

  it("allows approved drift and rejects expired exception entries", () => {
    const architecture = { paths: { "/catalog/assets": { get: { summary: "A" } } } } as const;
    const runtime = { paths: { "/catalog/assets": { get: { summary: "B" } } } } as const;
    const differences = collectOpenApiDifferences(architecture, runtime);

    const exceptions: DriftException[] = [
      {
        id: "valid-summary-drift",
        pointer: "/paths/~1catalog~1assets/get/summary",
        reason: "Temporary architecture update lag",
        reviewReference: "https://github.com/aria-fx/aria-gateway/pull/28",
        expiresOn: "2026-06-01T00:00:00.000Z",
      },
      {
        id: "expired-example",
        pointer: "/paths/~1catalog~1assets/get",
        reason: "Should fail once expired",
        reviewReference: "https://github.com/aria-fx/aria-gateway/pull/28",
        expiresOn: "2026-01-01T00:00:00.000Z",
      },
    ];
    const report = buildDriftReport(differences, exceptions, new Date("2026-05-14T00:00:00.000Z"));

    expect(report.approved).toHaveLength(1);
    expect(report.unapproved).toHaveLength(0);
    expect(report.expiredExceptions).toHaveLength(1);
    expect(report.expiredExceptions[0]?.id).toBe("expired-example");
  });

  it("marks exception entries without reviewReference as invalid", () => {
    const differences = collectOpenApiDifferences({ info: { title: "A" } }, { info: { title: "B" } });
    const exceptions = [
      {
        id: "missing-review",
        pointer: "/info/title",
        reason: "pending review metadata",
        reviewReference: "",
        expiresOn: "2026-06-01T00:00:00.000Z",
      },
    ] satisfies DriftException[];

    const report = buildDriftReport(differences, exceptions, new Date("2026-05-14T00:00:00.000Z"));

    expect(report.invalidExceptions).toHaveLength(1);
    expect(report.invalidExceptions[0]?.exception.id).toBe("missing-review");
    expect(report.unapproved).toHaveLength(1);
  });
});
