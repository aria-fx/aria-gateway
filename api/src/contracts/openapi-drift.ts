export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export type DriftKind = "missing_in_runtime" | "missing_in_architecture" | "value_mismatch";

export interface DriftDifference {
  pointer: string;
  kind: DriftKind;
  architectureValue?: JsonValue;
  runtimeValue?: JsonValue;
}

export interface DriftException {
  id: string;
  pointer: string;
  reason: string;
  reviewReference: string;
  expiresOn: string;
}

export interface DriftReport {
  differences: DriftDifference[];
  approved: DriftDifference[];
  unapproved: DriftDifference[];
  expiredExceptions: DriftException[];
  invalidExceptions: Array<{ exception: DriftException; issue: string }>;
}

export function collectOpenApiDifferences(
  architectureSpec: JsonValue,
  runtimeSpec: JsonValue,
  pointer = "",
): DriftDifference[] {
  if (isPrimitive(architectureSpec) || isPrimitive(runtimeSpec)) {
    if (Object.is(architectureSpec, runtimeSpec)) {
      return [];
    }
    return [
      {
        pointer: pointer || "/",
        kind: "value_mismatch",
        architectureValue: architectureSpec,
        runtimeValue: runtimeSpec,
      },
    ];
  }

  if (Array.isArray(architectureSpec) || Array.isArray(runtimeSpec)) {
    if (!Array.isArray(architectureSpec) || !Array.isArray(runtimeSpec)) {
      return [
        {
          pointer: pointer || "/",
          kind: "value_mismatch",
          architectureValue: architectureSpec,
          runtimeValue: runtimeSpec,
        },
      ];
    }

    const differences: DriftDifference[] = [];
    const maxLength = Math.max(architectureSpec.length, runtimeSpec.length);
    for (let i = 0; i < maxLength; i += 1) {
      const childPointer = `${pointer}/${i}`;
      if (i >= architectureSpec.length) {
        differences.push({
          pointer: childPointer,
          kind: "missing_in_architecture",
          runtimeValue: runtimeSpec[i],
        });
        continue;
      }
      if (i >= runtimeSpec.length) {
        differences.push({
          pointer: childPointer,
          kind: "missing_in_runtime",
          architectureValue: architectureSpec[i],
        });
        continue;
      }
      differences.push(...collectOpenApiDifferences(architectureSpec[i], runtimeSpec[i], childPointer));
    }
    return differences;
  }

  const architectureKeys = Object.keys(architectureSpec);
  const runtimeKeys = Object.keys(runtimeSpec);
  const keySet = new Set([...architectureKeys, ...runtimeKeys]);
  const differences: DriftDifference[] = [];

  for (const key of Array.from(keySet).sort()) {
    const childPointer = `${pointer}/${escapePointerToken(key)}`;
    if (!(key in runtimeSpec)) {
      differences.push({
        pointer: childPointer,
        kind: "missing_in_runtime",
        architectureValue: architectureSpec[key],
      });
      continue;
    }
    if (!(key in architectureSpec)) {
      differences.push({
        pointer: childPointer,
        kind: "missing_in_architecture",
        runtimeValue: runtimeSpec[key],
      });
      continue;
    }
    differences.push(...collectOpenApiDifferences(architectureSpec[key], runtimeSpec[key], childPointer));
  }

  return differences;
}

export function buildDriftReport(
  differences: DriftDifference[],
  exceptions: DriftException[],
  now = new Date(),
): DriftReport {
  const validExceptions: DriftException[] = [];
  const invalidExceptions: Array<{ exception: DriftException; issue: string }> = [];
  const expiredExceptions: DriftException[] = [];

  for (const exception of exceptions) {
    if (!exception.id?.trim()) {
      invalidExceptions.push({ exception, issue: "id is required" });
      continue;
    }
    if (!exception.pointer?.trim()) {
      invalidExceptions.push({ exception, issue: "pointer is required" });
      continue;
    }
    if (!exception.reason?.trim()) {
      invalidExceptions.push({ exception, issue: "reason is required" });
      continue;
    }
    if (!exception.reviewReference?.trim()) {
      invalidExceptions.push({ exception, issue: "reviewReference is required (link to approving PR/issue)" });
      continue;
    }

    const parsed = Date.parse(exception.expiresOn);
    if (Number.isNaN(parsed)) {
      invalidExceptions.push({ exception, issue: "expiresOn must be a valid date (ISO-8601 recommended)" });
      continue;
    }
    if (parsed < now.getTime()) {
      expiredExceptions.push(exception);
      continue;
    }
    validExceptions.push(exception);
  }

  const approved: DriftDifference[] = [];
  const unapproved: DriftDifference[] = [];
  for (const difference of differences) {
    const isApproved = validExceptions.some((exception) => {
      const prefix = exception.pointer === "/" ? "/" : `${exception.pointer}/`;
      return difference.pointer === exception.pointer || difference.pointer.startsWith(prefix);
    });
    if (isApproved) {
      approved.push(difference);
    } else {
      unapproved.push(difference);
    }
  }

  return {
    differences,
    approved,
    unapproved,
    expiredExceptions,
    invalidExceptions,
  };
}

function isPrimitive(value: JsonValue): value is null | boolean | number | string {
  return value === null || typeof value !== "object";
}

function escapePointerToken(token: string): string {
  return token.replaceAll("~", "~0").replaceAll("/", "~1");
}
