import { PHASE7_COMMAND_REQUIRED_CLAIMS } from "../mock-core/phase7-control-plane-types.js";

const PHASE7_FIXTURE_ADAPTER_CLAIMS = Object.freeze(
  [...new Set(Object.values(PHASE7_COMMAND_REQUIRED_CLAIMS).flat())].sort(),
);

/**
 * Gives package-owned Phase 7 fixtures the adapter claims needed to exercise
 * the accepted mock control plane. Model-visible semantic grants remain the
 * scenario claims; this union does not widen the tool catalog exposed to the
 * fake agent or Codex.
 */
export function phase7FixtureRunCapabilities(
  scenarioClaims: readonly string[],
): string[] {
  return [...new Set([...scenarioClaims, ...PHASE7_FIXTURE_ADAPTER_CLAIMS])].sort();
}
