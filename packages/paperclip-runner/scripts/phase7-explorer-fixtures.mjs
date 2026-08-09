import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const PHASE7_SCENARIO_MANIFEST_MODULE = "virtual:phase7-scenario-manifest";
export const PHASE7_EVAL_REPORT_MODULE = "virtual:phase7-eval-report";

/**
 * Supplies the Phase 7 explorer's checked-in inputs as declared virtual
 * modules.
 *
 * The explorer is an example consumer: it may not reach into package or spec
 * internals by relative path (`check:forbidden-imports`). Bundling the inputs
 * here keeps that boundary intact and keeps fake mode free of network I/O —
 * the manifest and the optional Phase 7E report are baked into the bundle.
 */
export function phase7ExplorerFixturesPlugin() {
  return {
    name: "phase7-explorer-fixtures",
    resolveId(source) {
      if (source === PHASE7_SCENARIO_MANIFEST_MODULE || source === PHASE7_EVAL_REPORT_MODULE) {
        return `\0${source}`;
      }
      return null;
    },
    async load(id) {
      if (id === `\0${PHASE7_SCENARIO_MANIFEST_MODULE}`) {
        const source = await readFile(
          resolve(packageRoot, "spec/phase-07/eval-traceability.yaml"),
          "utf8",
        );
        return `export default ${JSON.stringify(source)};`;
      }
      if (id === `\0${PHASE7_EVAL_REPORT_MODULE}`) {
        // Phase 7E's report is optional: when it has not been generated the
        // Parity tab renders "Not run" rather than inventing a verdict.
        const report = await readFile(
          resolve(packageRoot, "knowledge/evidence/phase-07/eval-parity-report.json"),
          "utf8",
        ).catch(() => null);
        return `export default ${report ?? "null"};`;
      }
      return null;
    },
  };
}
