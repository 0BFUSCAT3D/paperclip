import { runPhase6StandaloneDemo } from "../standalone/phase6-demo.js";

function option(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
}

const scenario = option("--scenario") ?? "happy-path";
const featureFlagEnabled = option("--feature-flag") === "enabled";
const killSwitchEnabled = option("--kill-switch") === "enabled";

if (scenario !== "happy-path") throw new Error(`Unsupported Phase 6 mock scenario: ${scenario}`);

const result = await runPhase6StandaloneDemo({ featureFlagEnabled, killSwitchEnabled });
process.stdout.write(`${JSON.stringify({ ...result, scenario })}\n`);
