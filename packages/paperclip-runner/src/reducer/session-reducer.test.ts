import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { parsePrpFixtureText, type PrpFixture } from "../protocol/phase1-contract.js";
import {
  reducePrpFixture,
  reduceSessionEvents,
  type SessionSnapshot,
} from "./session-reducer.js";

const fixtureDirectory = new URL("../../protocol/fixtures/phase-01/", import.meta.url);
const fixtureNames = [
  "happy-path",
  "failed-run",
  "interrupted-run",
  "duplicate-event",
  "source-gap",
  "unknown-optional-fields",
];

async function loadFixture(name: string): Promise<PrpFixture> {
  const result = parsePrpFixtureText(
    await readFile(new URL(`${name}.json`, fixtureDirectory), "utf8"),
  );
  if (!result.ok) {
    throw new Error(result.issues.map((issue) => issue.message).join("; "));
  }
  return result.fixture;
}

async function loadGolden(name: string): Promise<SessionSnapshot> {
  return JSON.parse(
    await readFile(new URL(`golden/${name}.snapshot.json`, fixtureDirectory), "utf8"),
  ) as SessionSnapshot;
}

describe("deterministic PRP session reducer", () => {
  for (const fixtureName of fixtureNames) {
    it(`matches the ${fixtureName} golden snapshot`, async () => {
      expect(reducePrpFixture(await loadFixture(fixtureName))).toEqual(
        await loadGolden(fixtureName),
      );
    });
  }

  it("is deterministic and idempotent when the same batch is replayed", async () => {
    const fixture = await loadFixture("happy-path");
    const first = reducePrpFixture(fixture);
    expect(reducePrpFixture(fixture)).toEqual(first);
    expect(reduceSessionEvents(first, fixture.events)).toEqual(first);
  });

  it("deduplicates at-least-once delivery before projection effects", async () => {
    const snapshot = reducePrpFixture(await loadFixture("duplicate-event"));
    expect(snapshot.duplicateEventIds).toEqual(["event_duplicate_03"]);
    expect(snapshot.items).toHaveLength(1);
    expect(snapshot.timeline).toHaveLength(6);
  });

  it("records a source cursor gap without inventing the missing event", async () => {
    const snapshot = reducePrpFixture(await loadFixture("source-gap"));
    expect(snapshot.integrity).toBe("gap_detected");
    expect(snapshot.gaps).toEqual([
      {
        sourceKey: "runner:runner_phase1",
        expected: 3,
        received: 4,
        missing: [3],
      },
    ]);
  });
});
