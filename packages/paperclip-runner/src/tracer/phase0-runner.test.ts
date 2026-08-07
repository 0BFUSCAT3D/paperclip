import { describe, expect, it } from "vitest";

import { MockControlPlaneAdapter } from "../mock-core/mock-control-plane-adapter.js";
import { runPhase0Tracer } from "./phase0-runner.js";

const EXPECTED_OUTPUT =
  '{"schemaVersion":"paperclip.runner.phase0.output.v1","runIdentity":{"runId":"run_phase0_0001","sessionId":"session_phase0_0001"},"result":{"status":"succeeded","summary":"Standalone Phase 0 fixture accepted."}}';

describe("Phase 0 tracer", () => {
  it("prints a stable identity and result and stops the mock core", async () => {
    const mockCore = new MockControlPlaneAdapter();

    await expect(runPhase0Tracer(mockCore)).resolves.toBe(EXPECTED_OUTPUT);
    expect(mockCore.snapshot().lifecycle).toBe("stopped");
  });
});
