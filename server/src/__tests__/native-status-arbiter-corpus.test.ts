import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

type Fixture = {
  id: string;
  covers: Record<string, string[]>;
  expected: Record<string, unknown>;
};

type Corpus = {
  schema: string;
  corpusRevision: number;
  fixtures: Fixture[];
};

const corpusPath = fileURLToPath(new URL(
  "../../../packages/paperclip-runner/spec/fixtures/status-authority-phase5.json",
  import.meta.url,
));

const consumerByMatrixPrefix: Record<string, string> = {
  SD: "server/native-status-arbiter-and-committer",
  TC: "package/native-session-runtime",
  ATT: "server/native-interaction-bridge",
  LIVE: "server/atomic-liveness-failpoints",
  REC: "server/native-finalization-recovery",
  COMP: "server/legacy-finalization-regression",
  MIG: "server/native-finalization-migration",
};

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function emitConsumerResults(corpus: Corpus) {
  return corpus.fixtures.flatMap((fixture) => {
    const coveredRows = Object.values(fixture.covers).flat();
    // Revision 2 contains one negative fixture that intentionally has no
    // matrix-row claim. It still needs an independently joinable consumer.
    if (coveredRows.length === 0) {
      return [{
        corpusRevision: corpus.corpusRevision,
        fixtureId: fixture.id,
        matrixRow: "fixture-only",
        consumer: "server/native-finalization-recovery",
        expectedDigest: createHash("sha256").update(canonical(fixture.expected)).digest("hex"),
      }];
    }
    return coveredRows.map((matrixRow) => {
    const prefix = matrixRow.split("-")[0]!;
    const consumer = consumerByMatrixPrefix[prefix];
    if (!consumer) throw new Error(`missing_consumer:${matrixRow}`);
    return {
      corpusRevision: corpus.corpusRevision,
      fixtureId: fixture.id,
      matrixRow,
      consumer,
      expectedDigest: createHash("sha256").update(canonical(fixture.expected)).digest("hex"),
    };
    });
  });
}

describe("P6-31 Section 18.13 status-authority corpus traceability", () => {
  it("emits one result for every Section 18.13 fixture and consumer", () => {
    const corpus = JSON.parse(readFileSync(corpusPath, "utf8")) as Corpus;
    const results = emitConsumerResults(corpus);
    const coveredFixtureIds = new Set(results.map((result) => result.fixtureId));
    const resultKeys = results.map((result) => `${result.fixtureId}:${result.matrixRow}:${result.consumer}`);

    expect(corpus.schema).toBe("paperclip.status-authority-conformance.v1");
    expect(corpus.fixtures).toHaveLength(52);
    expect(coveredFixtureIds).toEqual(new Set(corpus.fixtures.map((fixture) => fixture.id)));
    expect(new Set(resultKeys).size).toBe(resultKeys.length);
    expect(results.every((result) => /^[a-f0-9]{64}$/.test(result.expectedDigest))).toBe(true);
    expect(new Set(results.filter((result) => result.matrixRow !== "fixture-only").map((result) => result.matrixRow))).toEqual(new Set([
      ...Array.from({ length: 19 }, (_, index) => `SD-${String(index + 1).padStart(2, "0")}`),
      ...Array.from({ length: 8 }, (_, index) => `TC-${String(index + 1).padStart(2, "0")}`),
      ...Array.from({ length: 12 }, (_, index) => `ATT-${String(index + 1).padStart(2, "0")}`),
      ...Array.from({ length: 6 }, (_, index) => `LIVE-${String(index + 1).padStart(2, "0")}`),
      ...Array.from({ length: 8 }, (_, index) => `REC-${String(index + 1).padStart(2, "0")}`),
      ...Array.from({ length: 8 }, (_, index) => `COMP-${String(index + 1).padStart(2, "0")}`),
      ...Array.from({ length: 9 }, (_, index) => `MIG-${String(index + 1).padStart(2, "0")}`),
    ]));
  });
});
