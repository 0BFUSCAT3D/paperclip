import { resolve } from "node:path";

const packageRoot = resolve(import.meta.dirname, "..");
const suite = await import(resolve(packageRoot, "dist/conformance/phase7-eval-suite.js"));
const report = await suite.runPhase7EvalSuite();
const paths = await suite.writePhase7EvalParityReports(report);
process.stdout.write(`Phase 7 eval conformance passed: ${report.cases} cases across ${report.groups.length} groups.\n`);
process.stdout.write(`Parity reports: ${paths.jsonPath} and ${paths.markdownPath}\n`);
