import { describe, it, expect } from "vitest";
import contract from "../docs/catalog-api.contract.json";
import { buildOpenApiSpec } from "../src/routes/plugins.js";

type ContractOperation = {
  path: string;
  method: string;
  requiredResponseStatuses: string[];
};

describe("OpenAPI contract drift", () => {
  it("keeps required security schemes", () => {
    const spec = buildOpenApiSpec();
    const schemes = spec.components?.securitySchemes ?? {};

    for (const scheme of contract.requiredSecuritySchemes) {
      expect(schemes[scheme]).toBeDefined();
    }
  });

  it("keeps required operations and response statuses", () => {
    const spec = buildOpenApiSpec();

    for (const operation of contract.requiredOperations as ContractOperation[]) {
      const pathItem = spec.paths?.[operation.path] as
        | Record<string, { responses?: Record<string, unknown> }>
        | undefined;
      expect(pathItem).toBeDefined();

      const method = operation.method.toLowerCase();
      const op = pathItem?.[method];
      expect(op).toBeDefined();

      const responses = op?.responses ?? {};
      for (const status of operation.requiredResponseStatuses) {
        expect(responses[status]).toBeDefined();
      }
    }
  });
});
