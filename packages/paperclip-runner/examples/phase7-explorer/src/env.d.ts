/// <reference types="vite/client" />

/**
 * Declared build-time inputs for the explorer, supplied by
 * `scripts/phase7-explorer-fixtures.mjs`. The explorer is an example consumer
 * and reaches package or spec files only through these entry points.
 */
declare module "virtual:phase7-scenario-manifest" {
  /** The checked-in Phase 7A traceability derivative, verbatim. */
  const manifestSource: string;
  export default manifestSource;
}

declare module "virtual:phase7-eval-report" {
  /** Phase 7E's parity report, or `null` when it has not been generated. */
  const evalReport: unknown;
  export default evalReport;
}
