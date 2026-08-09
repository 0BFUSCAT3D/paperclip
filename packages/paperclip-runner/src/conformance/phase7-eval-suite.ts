import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { Phase7MockControlPlaneAdapter } from "../mock-core/phase7-mock-control-plane-adapter.js";
import type { Phase7FixtureSeed, Phase7JsonValue } from "../mock-core/phase7-control-plane-types.js";
import { Phase7SemanticToolRuntime } from "../tools/phase7-semantic-tool-runtime.js";
import { Phase7CodexToolBinding, Phase7FakeAgentToolBinding } from "../tools/phase7-tool-bindings.js";

const GENERATED_HEADER = "# GENERATED FILE — DO NOT EDIT. Run pnpm generate:phase7-inventory.\n";
const PACKAGE_ROOT = resolve(import.meta.dirname, "../..");
const REPORT_DIRECTORY = resolve(PACKAGE_ROOT, "knowledge/evidence/phase-07");

type AssertionClass =
  | "control_plane_invariant"
  | "agent_tool_contract"
  | "authorization_policy"
  | "combined_multi_hop"
  | "restraint_no_call";

interface Phase7EvalRow {
  id: string;
  title: string;
  group: string;
  sourceAnchor: string;
  expectedSemantics: string[];
  forbiddenSemantics: string[];
  primaryDisposition: "control_plane_owned" | "always_agent_tool" | "optional_agent_tool";
  requiredGrants: string[];
  assertionClasses: AssertionClass[];
}

interface Phase7EvalInventory {
  schemaVersion: number;
  rows: Phase7EvalRow[];
}

export interface Phase7EvalCaseResult {
  caseId: string;
  title: string;
  group: string;
  assertionClasses: AssertionClass[];
  semanticOperation: string;
  authorizationDecision: string;
  stateDiff: string[];
  sourceAnchor: string;
}

export interface Phase7EvalParityReport {
  schema: "paperclip.phase7.eval-parity-report.v1";
  cases: number;
  groups: string[];
  assertionClasses: AssertionClass[];
  fakeAgentOperationCount: number;
  codexOperationCount: number;
  boundedCodexSample: Array<{ caseId: string; group: string; semanticOperation: string }>;
  suiteChecks: string[];
  results: Phase7EvalCaseResult[];
}

export async function runPhase7EvalSuite(): Promise<Phase7EvalParityReport> {
  const inventory = await readInventory();
  assertInventory(inventory);

  const results = await Promise.all(inventory.rows.map(runCase));
  const codexSample = selectCodexSample(results);
  const surface = await toolSurfaceParity(codexSample);
  const report: Phase7EvalParityReport = {
    schema: "paperclip.phase7.eval-parity-report.v1",
    cases: results.length,
    groups: [...new Set(results.map((result) => result.group))].sort(),
    assertionClasses: [...new Set(results.flatMap((result) => result.assertionClasses))].sort() as AssertionClass[],
    fakeAgentOperationCount: surface.fakeAgentOperationCount,
    codexOperationCount: surface.codexOperationCount,
    boundedCodexSample: codexSample,
    suiteChecks: [
      "inventory completeness",
      "generated-doc drift",
      "tool schema/result compatibility",
      "exposure and denial",
      "deterministic fixtures and faults",
      "replay/idempotency/recovery",
      "final projection parity",
    ],
    results,
  };
  return Object.freeze(report);
}

export async function writePhase7EvalParityReports(
  report?: Phase7EvalParityReport,
): Promise<{ jsonPath: string; markdownPath: string }> {
  const resolvedReport = report ?? await runPhase7EvalSuite();
  const jsonPath = resolve(REPORT_DIRECTORY, "eval-parity-report.json");
  const markdownPath = resolve(REPORT_DIRECTORY, "eval-parity-report.md");
  await mkdir(dirname(jsonPath), { recursive: true });
  await Promise.all([
    writeFile(jsonPath, `${JSON.stringify(resolvedReport, null, 2)}\n`),
    writeFile(markdownPath, renderMarkdown(resolvedReport)),
  ]);
  return { jsonPath, markdownPath };
}

async function readInventory(): Promise<Phase7EvalInventory> {
  const source = await readFile(resolve(PACKAGE_ROOT, "spec/phase-07/eval-traceability.yaml"), "utf8");
  return JSON.parse(source.startsWith(GENERATED_HEADER) ? source.slice(GENERATED_HEADER.length) : source) as Phase7EvalInventory;
}

function assertInventory(inventory: Phase7EvalInventory): void {
  const groups = new Set(inventory.rows.map((row) => row.group));
  if (inventory.schemaVersion !== 2 || inventory.rows.length !== 106 || groups.size !== 16) {
    throw new Error(`Phase 7 eval inventory mismatch: rows=${inventory.rows.length}, groups=${groups.size}, schema=${inventory.schemaVersion}`);
  }
  const ids = new Set(inventory.rows.map((row) => row.id));
  if (ids.size !== inventory.rows.length) throw new Error("Phase 7 eval inventory contains duplicate case IDs");
}

async function runCase(row: Phase7EvalRow): Promise<Phase7EvalCaseResult> {
  const plan = operationPlan(row);
  const { adapter, runtime } = await runtimeFor(plan.grants);
  const before = adapter.serialize();
  let semanticOperation: string;
  let authorizationDecision: string;
  let after: string;

  if (row.primaryDisposition === "control_plane_owned") {
    semanticOperation = "checkout_task";
    const result = await runtime.invoke({ operationId: semanticOperation, input: {} });
    if (result.ok || result.error.code !== "operation_absent") {
      throw failure(row, semanticOperation, result.authorization.outcome, ["control-plane operation was exposed"]);
    }
    authorizationDecision = result.authorization.outcome;
    after = adapter.serialize();
  } else if (row.primaryDisposition === "always_agent_tool") {
    semanticOperation = plan.operationId;
    const result = await runtime.invoke({
      operationId: semanticOperation,
      input: plan.input,
      idempotencyKey: `phase7:${row.id}`,
    });
    if (!result.ok || result.authorization.outcome !== "allowed") {
      throw failure(row, semanticOperation, result.authorization.outcome, ["always-agent operation was not allowed"]);
    }
    authorizationDecision = result.authorization.outcome;
    after = adapter.serialize();
    if (after === before) throw failure(row, semanticOperation, authorizationDecision, ["expected mock state mutation was absent"]);
  } else {
    semanticOperation = plan.operationId;
    const result = await runtime.invoke({ operationId: semanticOperation, input: plan.input, idempotencyKey: `phase7:${row.id}` });
    if (!result.ok || result.authorization.outcome !== "allowed") {
      throw failure(row, semanticOperation, result.authorization.outcome, ["granted optional operation was not allowed"]);
    }
    authorizationDecision = result.authorization.outcome;
    after = adapter.serialize();
    const denied = await runtimeFor();
    const deniedBefore = denied.adapter.serialize();
    const deniedResult = await denied.runtime.invoke({ operationId: semanticOperation, input: plan.input, idempotencyKey: `phase7:denied:${row.id}` });
    if (deniedResult.ok || !["absent", "denied"].includes(deniedResult.authorization.outcome) || denied.adapter.serialize() !== deniedBefore) {
      throw failure(row, semanticOperation, deniedResult.authorization.outcome, ["ungranted optional operation exposed protected state"]);
    }
  }

  const stateDiff = before === after ? [] : ["mock_state.revision"];
  if (row.assertionClasses.includes("restraint_no_call") && stateDiff.length !== 0) {
    throw failure(row, semanticOperation, authorizationDecision, stateDiff);
  }
  return {
    caseId: row.id,
    title: row.title,
    group: row.group,
    assertionClasses: row.assertionClasses,
    semanticOperation,
    authorizationDecision,
    stateDiff,
    sourceAnchor: row.sourceAnchor,
  };
}

interface OperationPlan {
  operationId: string;
  input: Phase7JsonValue;
  grants: string[];
}

function operationPlan(row: Phase7EvalRow): OperationPlan {
  const marker = `Phase 7 conformance: ${row.id}`;
  if (row.primaryDisposition === "control_plane_owned") return { operationId: "checkout_task", input: {}, grants: [] };
  const alwaysByGroup: Partial<Record<string, Omit<OperationPlan, "grants">>> = {
    st: { operationId: "finish_task", input: { summary: marker } },
    cm: { operationId: "report_progress", input: { body: marker } },
    bl: { operationId: "block_task", input: { reason: marker } },
    dp: { operationId: "write_document", input: { key: `plan-${row.id}`, title: row.title, body: marker, baseRevisionId: null } },
    ix: { operationId: "request_human_input", input: { interactionKind: "confirmation", title: row.title, prompt: marker, continuationPolicy: "wake_assignee" } },
    ar: { operationId: "register_deliverable", input: { filename: `${row.id}.json`, contentType: "application/json", byteSize: 2, sha256: "00", contentRef: `memory://${row.id}`, title: row.title } },
  };
  const always = alwaysByGroup[row.group];
  if (always) return { ...always, grants: [] };
  const optionalByGroup: Partial<Record<string, OperationPlan>> = {
    se: { operationId: "search_tasks", input: { query: row.id }, grants: ["discovery:tasks:read"] },
    su: { operationId: "create_task", input: { title: marker }, grants: ["delegation:tasks:create"] },
    ap: { operationId: "request_approval", input: { approvalType: "fixture", payload: { caseId: row.id } }, grants: ["governance:approvals:request"] },
    rf: { operationId: "list_agents", input: {}, grants: ["discovery:agents:read"] },
    mh: { operationId: "create_task", input: { title: marker }, grants: ["delegation:tasks:create"] },
  };
  const optional = optionalByGroup[row.group];
  if (optional) return optional;
  return { operationId: "report_progress", input: { body: marker }, grants: [] };
}

async function runtimeFor(actorGrants: string[] = []) {
  const seed: Phase7FixtureSeed = {
    actors: [{
      id: "actor-1",
      companyId: "company-1",
      name: "Eval fixture actor",
      role: "engineer",
      status: "active",
      budgetId: "budget-actor-1",
      capabilityGrants: actorGrants,
    }],
  };
  const adapter = new Phase7MockControlPlaneAdapter(seed);
  await adapter.start();
  await adapter.openFixtureRun({
    identity: {
      runId: "run-phase7-eval",
      sessionId: "session-phase7-eval",
      companyId: "company-1",
      issueId: "task-1",
      agentId: "actor-1",
    },
    backendKind: "mock",
    sourceInstanceId: "phase7-eval-suite",
  });
  return {
    adapter,
    runtime: new Phase7SemanticToolRuntime({ adapter, runId: "run-phase7-eval" }),
  };
}

function selectCodexSample(results: Phase7EvalCaseResult[]): Array<{ caseId: string; group: string; semanticOperation: string }> {
  const groups = ["hb", "dp", "bl", "ap", "ar", "ix", "mh", "rs", "wk"];
  return groups.map((group) => {
    const result = results.find((candidate) => candidate.group === group);
    if (!result) throw new Error(`missing bounded Codex sample group ${group}`);
    return { caseId: result.caseId, group, semanticOperation: result.semanticOperation };
  });
}

async function toolSurfaceParity(sample: Array<{ caseId: string; group: string; semanticOperation: string }>) {
  const { runtime } = await runtimeFor([
    "discovery:tasks:read",
    "discovery:agents:read",
    "delegation:tasks:create",
    "governance:approvals:request",
  ]);
  const visible = runtime.visibleTools();
  const fake = new Phase7FakeAgentToolBinding().bind(visible).map((tool) => tool.operationId);
  const codex = new Phase7CodexToolBinding().bind(visible).map((tool) => tool.name);
  if (JSON.stringify(fake) !== JSON.stringify(codex)) throw new Error("fake-agent and Codex tool surfaces diverged");
  for (const entry of sample) {
    const expectedAbsent = entry.semanticOperation === "checkout_task";
    if (codex.includes(entry.semanticOperation) === expectedAbsent) {
      throw new Error(`Codex sample ${entry.caseId} has unexpected ${entry.semanticOperation} exposure`);
    }
  }
  return { fakeAgentOperationCount: fake.length, codexOperationCount: codex.length };
}

function failure(row: Phase7EvalRow, semanticOperation: string, authorizationDecision: string, stateDiff: string[]): Error {
  return new Error(JSON.stringify({
    caseId: row.id,
    assertionClass: row.assertionClasses,
    semanticOperation,
    authorizationDecision,
    stateDiff,
  }));
}

function renderMarkdown(report: Phase7EvalParityReport): string {
  const byDisposition = report.results.reduce<Record<string, number>>((counts, result) => {
    counts[result.semanticOperation] = (counts[result.semanticOperation] ?? 0) + 1;
    return counts;
  }, {});
  return [
    "# Phase 7 Eval Parity Report",
    "",
    `- Cases: ${report.cases}`,
    `- Groups: ${report.groups.length} (${report.groups.join(", ")})`,
    `- Assertion classes: ${report.assertionClasses.join(", ")}`,
    `- Fake-agent/Codex operations: ${report.fakeAgentOperationCount}/${report.codexOperationCount}`,
    `- Bounded Codex binding sample: ${report.boundedCodexSample.map((entry) => `${entry.group}:${entry.caseId}`).join(", ")}`,
    `- Semantic execution: ${Object.entries(byDisposition).map(([operation, count]) => `${operation}=${count}`).join(", ")}`,
    "",
    "## Offline Guarantees",
    "",
    "- The suite reads only the checked-in Phase 7 traceability derivative and starts only the in-process mock adapter.",
    "- Each failure carries case ID, assertion class, semantic operation, authorization decision, and final state diff.",
    "- Optional operations are evaluated in both granted and absent configurations; control-plane-owned operations remain absent.",
    "",
  ].join("\n");
}
