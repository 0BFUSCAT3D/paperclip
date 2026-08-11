import type {
  CapabilityJsonSchema,
  CapabilityOptionalCatalogGroup,
  CapabilitySemanticToolDescriptor,
  CapabilityToolTaskMode,
} from "./capability-semantic-tool-types.js";

const ALL_MODES: CapabilityToolTaskMode[] = ["standard", "ask", "planning", "skill_test"];
const WORK_MODES: CapabilityToolTaskMode[] = ["standard", "planning", "skill_test"];
const STANDARD_MODES: CapabilityToolTaskMode[] = ["standard", "skill_test"];
const RESULT_SCHEMA = objectSchema({
  schema: stringSchema({ enum: ["paperclip.capability.tool-result.v1"] }),
  ok: { type: "boolean" },
  operationId: stringSchema({ minLength: 1 }),
  operationResultId: stringSchema({ minLength: 1 }),
  value: {},
  commandResult: {},
  authorization: {},
}, ["schema", "ok", "operationId", "operationResultId", "value", "commandResult", "authorization"]);
const SECRET_REDACTION = [
  {
    path: "$.value",
    replacement: "[SECRET_VALUE]" as const,
    appliesTo: ["output", "error", "authorization_record"] as const,
  },
];
const AUTH_REDACTION = [
  {
    path: "$.headers.authorization",
    replacement: "[REDACTED]" as const,
    appliesTo: ["input", "output", "error", "authorization_record"] as const,
  },
  {
    path: "$.headers.cookie",
    replacement: "[REDACTED]" as const,
    appliesTo: ["input", "output", "error", "authorization_record"] as const,
  },
];

function stringSchema(options: Partial<CapabilityJsonSchema> = {}): CapabilityJsonSchema {
  return { type: "string", ...options };
}

function arraySchema(items: CapabilityJsonSchema): CapabilityJsonSchema {
  return { type: "array", items };
}

function objectSchema(
  properties: Record<string, CapabilityJsonSchema>,
  required: string[] = [],
): CapabilityJsonSchema {
  return { type: "object", properties, required, additionalProperties: false };
}

function descriptor(
  value: Omit<CapabilitySemanticToolDescriptor, "version" | "redaction"> & {
    redaction?: CapabilitySemanticToolDescriptor["redaction"];
  },
): CapabilitySemanticToolDescriptor {
  const { redaction, ...rest } = value;
  return { version: 1, ...rest, redaction: redaction ?? [] };
}

const ALWAYS_TOOLS: CapabilitySemanticToolDescriptor[] = [
  descriptor({
    operationId: "get_task_context",
    title: "Get task context",
    description: "Read the active task, ancestors, wake context, linked results, and budget summary.",
    inputSchema: objectSchema({}),
    outputSchema: RESULT_SCHEMA,
    disposition: "always_agent_tool",
    optionalGroup: null,
    requiredClaims: [],
    taskModes: ALL_MODES,
    sideEffectClass: "read",
    idempotency: "none",
    mockCommandMapping: { kind: "context_read", projection: "active_task" },
  }),
  descriptor({
    operationId: "get_task_history",
    title: "Get task history",
    description: "Read comments and audit-visible history for the active task only.",
    inputSchema: objectSchema({ limit: { type: "integer", minimum: 1 } }),
    outputSchema: RESULT_SCHEMA,
    disposition: "always_agent_tool",
    optionalGroup: null,
    requiredClaims: [],
    taskModes: ALL_MODES,
    sideEffectClass: "read",
    idempotency: "none",
    mockCommandMapping: { kind: "snapshot_read", projection: "active_task_history" },
  }),
  descriptor({
    operationId: "list_documents",
    title: "List task documents",
    description: "List document metadata attached to the active task.",
    inputSchema: objectSchema({}),
    outputSchema: RESULT_SCHEMA,
    disposition: "always_agent_tool",
    optionalGroup: null,
    requiredClaims: [],
    taskModes: ALL_MODES,
    sideEffectClass: "read",
    idempotency: "none",
    mockCommandMapping: { kind: "snapshot_read", projection: "active_task_documents" },
  }),
  descriptor({
    operationId: "read_document",
    title: "Read task document",
    description: "Read one document on the active task by stable key.",
    inputSchema: objectSchema({ key: stringSchema({ minLength: 1 }) }, ["key"]),
    outputSchema: RESULT_SCHEMA,
    disposition: "always_agent_tool",
    optionalGroup: null,
    requiredClaims: [],
    taskModes: ALL_MODES,
    sideEffectClass: "read",
    idempotency: "none",
    mockCommandMapping: { kind: "snapshot_read", projection: "active_task_document" },
  }),
  descriptor({
    operationId: "list_document_revisions",
    title: "List document revisions",
    description: "Inspect revision history for one active-task document.",
    inputSchema: objectSchema({ key: stringSchema({ minLength: 1 }) }, ["key"]),
    outputSchema: RESULT_SCHEMA,
    disposition: "always_agent_tool",
    optionalGroup: null,
    requiredClaims: [],
    taskModes: ALL_MODES,
    sideEffectClass: "read",
    idempotency: "none",
    mockCommandMapping: { kind: "snapshot_read", projection: "active_task_document_revisions" },
  }),
  descriptor({
    operationId: "report_progress",
    title: "Report progress",
    description: "Append a durable progress update to the active task.",
    inputSchema: objectSchema({ body: stringSchema({ minLength: 1 }) }, ["body"]),
    outputSchema: RESULT_SCHEMA,
    disposition: "always_agent_tool",
    optionalGroup: null,
    requiredClaims: [],
    taskModes: WORK_MODES,
    sideEffectClass: "task_write",
    idempotency: "required",
    mockCommandMapping: { kind: "semantic_command", commandKind: "report_progress" },
  }),
  descriptor({
    operationId: "answer_status_question",
    title: "Answer status question",
    description: "Post an answer to a status question without changing task state.",
    inputSchema: objectSchema({ body: stringSchema({ minLength: 1 }) }, ["body"]),
    outputSchema: RESULT_SCHEMA,
    disposition: "always_agent_tool",
    optionalGroup: null,
    requiredClaims: [],
    taskModes: ALL_MODES,
    sideEffectClass: "task_write",
    idempotency: "required",
    mockCommandMapping: { kind: "semantic_command", commandKind: "report_progress" },
  }),
  descriptor({
    operationId: "finish_task",
    title: "Finish task",
    description: "Finish the active task with a durable completion summary.",
    inputSchema: objectSchema({ summary: stringSchema({ minLength: 1 }) }, ["summary"]),
    outputSchema: RESULT_SCHEMA,
    disposition: "always_agent_tool",
    optionalGroup: null,
    requiredClaims: [],
    taskModes: STANDARD_MODES,
    sideEffectClass: "task_write",
    idempotency: "required",
    mockCommandMapping: { kind: "semantic_command", commandKind: "finish_task" },
  }),
  descriptor({
    operationId: "block_task",
    title: "Block task",
    description: "Block the active task with a reason and optional first-class dependencies.",
    inputSchema: objectSchema({
      reason: stringSchema({ minLength: 1 }),
      blockedByTaskIds: arraySchema(stringSchema({ minLength: 1 })),
    }, ["reason"]),
    outputSchema: RESULT_SCHEMA,
    disposition: "always_agent_tool",
    optionalGroup: null,
    requiredClaims: [],
    taskModes: WORK_MODES,
    sideEffectClass: "task_write",
    idempotency: "required",
    mockCommandMapping: { kind: "semantic_command", commandKind: "block_task" },
  }),
  descriptor({
    operationId: "request_review",
    title: "Request task review",
    description: "Move the active task to review with a durable summary.",
    inputSchema: objectSchema({ summary: stringSchema({ minLength: 1 }) }, ["summary"]),
    outputSchema: RESULT_SCHEMA,
    disposition: "always_agent_tool",
    optionalGroup: null,
    requiredClaims: [],
    taskModes: WORK_MODES,
    sideEffectClass: "task_write",
    idempotency: "required",
    mockCommandMapping: { kind: "semantic_command", commandKind: "request_review" },
  }),
  descriptor({
    operationId: "write_document",
    title: "Write task document",
    description: "Create or revision-safely update an active-task document.",
    inputSchema: objectSchema({
      key: stringSchema({ minLength: 1 }),
      title: stringSchema({ minLength: 1 }),
      body: stringSchema(),
      baseRevisionId: { oneOf: [stringSchema({ minLength: 1 }), { type: "null" }] },
      changeSummary: stringSchema(),
    }, ["key", "title", "body", "baseRevisionId"]),
    outputSchema: RESULT_SCHEMA,
    disposition: "always_agent_tool",
    optionalGroup: null,
    requiredClaims: [],
    taskModes: WORK_MODES,
    sideEffectClass: "task_write",
    idempotency: "required",
    mockCommandMapping: { kind: "semantic_command", commandKind: "write_document" },
  }),
  descriptor({
    operationId: "request_human_input",
    title: "Request human input",
    description: "Create a typed confirmation, checkbox, question, task suggestion, or item-verdict request.",
    inputSchema: objectSchema({
      interactionKind: stringSchema({ enum: ["confirmation", "checkbox", "questions", "suggest_tasks", "item_verdicts"] }),
      title: stringSchema({ minLength: 1 }),
      prompt: stringSchema({ minLength: 1 }),
      payload: {},
      targetRevisionId: { oneOf: [stringSchema({ minLength: 1 }), { type: "null" }] },
      continuationPolicy: stringSchema({ enum: ["none", "wake_assignee", "wake_assignee_on_accept"] }),
    }, ["interactionKind", "title", "prompt", "continuationPolicy"]),
    outputSchema: RESULT_SCHEMA,
    disposition: "always_agent_tool",
    optionalGroup: null,
    requiredClaims: [],
    taskModes: WORK_MODES,
    sideEffectClass: "task_write",
    idempotency: "required",
    mockCommandMapping: { kind: "semantic_command", commandKind: "request_human_input" },
  }),
  descriptor({
    operationId: "register_deliverable",
    title: "Register deliverable",
    description: "Register an inspectable artifact and its work product on the active task.",
    inputSchema: objectSchema({
      filename: stringSchema({ minLength: 1 }),
      contentType: stringSchema({ minLength: 1 }),
      byteSize: { type: "integer", minimum: 0 },
      sha256: stringSchema({ minLength: 1 }),
      contentRef: stringSchema({ minLength: 1 }),
      title: stringSchema({ minLength: 1 }),
    }, ["filename", "contentType", "byteSize", "sha256", "contentRef", "title"]),
    outputSchema: RESULT_SCHEMA,
    disposition: "always_agent_tool",
    optionalGroup: null,
    requiredClaims: [],
    taskModes: STANDARD_MODES,
    sideEffectClass: "task_write",
    idempotency: "required",
    mockCommandMapping: { kind: "semantic_command", commandKind: "register_deliverable" },
  }),
  descriptor({
    operationId: "inspect_operation_result",
    title: "Inspect operation result",
    description: "Read a prior semantic operation result from this run.",
    inputSchema: objectSchema({ operationResultId: stringSchema({ minLength: 1 }) }, ["operationResultId"]),
    outputSchema: RESULT_SCHEMA,
    disposition: "always_agent_tool",
    optionalGroup: null,
    requiredClaims: [],
    taskModes: ALL_MODES,
    sideEffectClass: "read",
    idempotency: "none",
    mockCommandMapping: { kind: "operation_result" },
  }),
];

function optional(
  operationId: string,
  group: CapabilityOptionalCatalogGroup,
  requiredClaims: string[],
  sideEffectClass: CapabilitySemanticToolDescriptor["sideEffectClass"],
  mapping: CapabilitySemanticToolDescriptor["mockCommandMapping"],
  inputSchema: CapabilityJsonSchema = objectSchema({}),
  options: Partial<Pick<CapabilitySemanticToolDescriptor, "allowedRoles" | "redaction" | "taskModes" | "idempotency">> = {},
): CapabilitySemanticToolDescriptor {
  const title = operationId.split("_").map((part) => part[0]!.toUpperCase() + part.slice(1)).join(" ");
  return descriptor({
    operationId,
    title,
    description: `${title} through the Capability ${group.replaceAll("_", " ")} capability set.`,
    inputSchema,
    outputSchema: RESULT_SCHEMA,
    disposition: "optional_agent_tool",
    optionalGroup: group,
    requiredClaims,
    taskModes: options.taskModes ?? STANDARD_MODES,
    sideEffectClass,
    idempotency: options.idempotency ?? (sideEffectClass === "read" ? "none" : "required"),
    redaction: options.redaction,
    allowedRoles: options.allowedRoles,
    mockCommandMapping: mapping,
  });
}

const OPTIONAL_TOOLS: CapabilitySemanticToolDescriptor[] = [
  optional("search_tasks", "discovery", ["discovery:tasks:read"], "read", { kind: "snapshot_read", projection: "company_tasks" }, objectSchema({ query: stringSchema(), status: stringSchema() })),
  optional("list_agents", "discovery", ["discovery:agents:read"], "read", { kind: "snapshot_read", projection: "company_actors" }),
  optional("list_projects", "discovery", ["discovery:projects:read"], "read", { kind: "mock_extension", extension: "discovery.projects" }),
  optional("list_goals", "discovery", ["discovery:goals:read"], "read", { kind: "mock_extension", extension: "discovery.goals" }),

  optional("create_task", "delegation_dependencies", ["delegation:tasks:create"], "company_write", { kind: "semantic_command", commandKind: "create_task" }, objectSchema({ title: stringSchema({ minLength: 1 }), description: stringSchema(), assigneeActorId: stringSchema(), priority: stringSchema(), blockedByTaskIds: arraySchema(stringSchema()) }, ["title"])),
  optional("set_dependencies", "delegation_dependencies", ["dependencies:write"], "company_write", { kind: "semantic_command", commandKind: "set_dependencies" }, objectSchema({ blockedByTaskIds: arraySchema(stringSchema({ minLength: 1 })) }, ["blockedByTaskIds"])),

  optional("list_approvals", "governance", ["governance:approvals:read"], "read", { kind: "snapshot_read", projection: "company_approvals" }),
  optional("request_approval", "governance", ["governance:approvals:request"], "governance", { kind: "semantic_command", commandKind: "request_approval" }, objectSchema({ approvalType: stringSchema({ minLength: 1 }), payload: {} }, ["approvalType", "payload"])),
  optional("decide_approval", "governance", ["governance:approvals:decide"], "governance", { kind: "semantic_command", commandKind: "decide_approval" }, objectSchema({ approvalId: stringSchema({ minLength: 1 }), decision: stringSchema({ enum: ["approved", "rejected", "cancelled"] }), note: stringSchema({ minLength: 1 }) }, ["approvalId", "decision", "note"]), { allowedRoles: ["board", "approver", "security"] }),
  optional("comment_on_approval", "governance", ["governance:approvals:comment"], "governance", { kind: "semantic_command", commandKind: "comment_on_approval" }, objectSchema({ approvalId: stringSchema({ minLength: 1 }), body: stringSchema({ minLength: 1 }) }, ["approvalId", "body"])),

  optional("list_cases", "cases", ["cases:read"], "read", { kind: "mock_extension", extension: "cases.list" }),
  optional("upsert_case", "cases", ["cases:write"], "company_write", { kind: "mock_extension", extension: "cases.upsert" }, objectSchema({ key: stringSchema({ minLength: 1 }), body: stringSchema() }, ["key", "body"])),

  optional("get_workspace_runtime", "workspace_runtime", ["workspace:read"], "read", { kind: "snapshot_read", projection: "active_task_workspace" }),
  optional("control_workspace_service", "workspace_runtime", ["workspace:control"], "workspace_control", { kind: "semantic_command", commandKind: "control_workspace_service" }, objectSchema({ serviceId: stringSchema({ minLength: 1 }), action: stringSchema({ enum: ["start", "stop", "fail"] }), url: stringSchema() }, ["serviceId", "action"])),

  optional("list_routines", "routines", ["routines:read"], "read", { kind: "mock_extension", extension: "routines.list" }),
  optional("manage_routine", "routines", ["routines:write"], "admin", { kind: "mock_extension", extension: "routines.manage" }),

  optional("list_company_skills", "company_skills", ["company_skills:read"], "read", { kind: "mock_extension", extension: "company_skills.list" }),
  optional("sync_company_skills", "company_skills", ["company_skills:write"], "admin", { kind: "mock_extension", extension: "company_skills.sync" }),

  optional("list_secret_metadata", "secrets", ["secrets:metadata:read"], "read", { kind: "mock_extension", extension: "secrets.metadata" }),
  optional("read_secret_value", "secrets", ["secrets:values:read"], "secret_read", { kind: "mock_extension", extension: "secrets.value" }, objectSchema({ name: stringSchema({ minLength: 1 }) }, ["name"]), { redaction: [...SECRET_REDACTION], idempotency: "none" }),

  optional("export_company", "portability_admin", ["portability:export"], "admin", { kind: "mock_extension", extension: "portability.export" }),
  optional("administer_company", "portability_admin", ["company:admin"], "admin", { kind: "mock_extension", extension: "company.admin" }, objectSchema({ action: stringSchema({ minLength: 1 }), payload: {} }, ["action"]), { allowedRoles: ["board", "ceo", "admin"] }),

  optional("generic_api_request", "test_escape_hatch", ["test:generic_api"], "test_escape_hatch", { kind: "mock_extension", extension: "test.generic_api" }, objectSchema({ method: stringSchema({ minLength: 1 }), path: stringSchema({ minLength: 1 }), headers: { type: "object", additionalProperties: stringSchema() }, body: {} }, ["method", "path"]), { taskModes: ["skill_test"], redaction: [...AUTH_REDACTION] }),
];

export const CAPABILITY_SEMANTIC_TOOL_CATALOG: readonly CapabilitySemanticToolDescriptor[] = Object.freeze(
  [...ALWAYS_TOOLS, ...OPTIONAL_TOOLS].map((tool) => Object.freeze(tool)),
);

export const CAPABILITY_OPTIONAL_TOOL_CATALOGS: Readonly<
  Record<CapabilityOptionalCatalogGroup, readonly CapabilitySemanticToolDescriptor[]>
> = Object.freeze({
  discovery: toolsInGroup("discovery"),
  delegation_dependencies: toolsInGroup("delegation_dependencies"),
  governance: toolsInGroup("governance"),
  cases: toolsInGroup("cases"),
  workspace_runtime: toolsInGroup("workspace_runtime"),
  routines: toolsInGroup("routines"),
  company_skills: toolsInGroup("company_skills"),
  secrets: toolsInGroup("secrets"),
  portability_admin: toolsInGroup("portability_admin"),
  test_escape_hatch: toolsInGroup("test_escape_hatch"),
});

export function capabilitySemanticTool(operationId: string): CapabilitySemanticToolDescriptor | undefined {
  return CAPABILITY_SEMANTIC_TOOL_CATALOG.find((tool) => tool.operationId === operationId);
}

function toolsInGroup(group: CapabilityOptionalCatalogGroup): readonly CapabilitySemanticToolDescriptor[] {
  return Object.freeze(OPTIONAL_TOOLS.filter((tool) => tool.optionalGroup === group));
}
