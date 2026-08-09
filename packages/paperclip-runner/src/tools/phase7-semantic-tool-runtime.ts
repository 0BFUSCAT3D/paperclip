import type {
  Phase7CommandEnvelope,
  Phase7JsonValue,
  Phase7MockControlPlanePort,
  Phase7SemanticCommand,
} from "../mock-core/phase7-control-plane-types.js";
import { phase7SemanticTool } from "./phase7-semantic-tool-catalog.js";
import { Phase7ToolAuthorizationEngine } from "./phase7-tool-authorization.js";
import type {
  Phase7AuthorizationRecord,
  Phase7JsonSchema,
  Phase7PolicyDenial,
  Phase7ScenarioToolPolicy,
  Phase7SemanticToolDescriptor,
  Phase7ToolAuthorizationContext,
  Phase7ToolInvocation,
  Phase7ToolInvocationResult,
  Phase7ToolSuccess,
  Phase7VisibleToolSet,
} from "./phase7-semantic-tool-types.js";

export interface Phase7SemanticToolRuntimeOptions {
  adapter: Phase7MockControlPlanePort;
  runId: string;
  scenarioGrants?: string[];
  policy?: Phase7ScenarioToolPolicy;
  resolveSecretValue?: (name: string) => Promise<string | null> | string | null;
}

export class Phase7SemanticToolRuntime {
  readonly #adapter: Phase7MockControlPlanePort;
  readonly #runId: string;
  readonly #scenarioGrants: string[];
  readonly #policy: Phase7ScenarioToolPolicy | undefined;
  readonly #resolveSecretValue: Phase7SemanticToolRuntimeOptions["resolveSecretValue"];
  readonly #authorization = new Phase7ToolAuthorizationEngine();
  readonly #operationResults = new Map<string, Phase7JsonValue>();
  #resultSequence = 0;

  constructor(options: Phase7SemanticToolRuntimeOptions) {
    this.#adapter = options.adapter;
    this.#runId = options.runId;
    this.#scenarioGrants = [...new Set(options.scenarioGrants ?? [])].sort();
    this.#policy = options.policy === undefined ? undefined : structuredClone(options.policy);
    this.#resolveSecretValue = options.resolveSecretValue;
  }

  visibleTools(): Phase7VisibleToolSet {
    return this.#authorization.computeVisibleTools(this.#context());
  }

  authorizationRecords(): readonly Phase7AuthorizationRecord[] {
    return this.#authorization.records();
  }

  async invoke(invocation: Phase7ToolInvocation): Promise<Phase7ToolInvocationResult> {
    const context = this.#context();
    const authorization = this.#authorization.authorizeInvocation(
      invocation.operationId,
      invocation.input,
      context,
    );
    if (authorization.outcome !== "allowed") {
      return this.#denial(
        invocation.operationId,
        authorization,
        authorization.outcome === "absent" ? "operation_absent" : "policy_denied",
      );
    }

    const descriptor = phase7SemanticTool(invocation.operationId)!;
    const validationIssues = validateJsonSchema(descriptor.inputSchema, invocation.input);
    if (validationIssues.length > 0) {
      const denied = this.#authorization.denyInvocation(
        invocation.operationId,
        context,
        "input_schema_invalid",
      );
      return this.#denial(invocation.operationId, denied, "input_invalid");
    }
    if (descriptor.idempotency === "required" && !invocation.idempotencyKey?.trim()) {
      const denied = this.#authorization.denyInvocation(
        invocation.operationId,
        context,
        "idempotency_key_required",
      );
      return this.#denial(invocation.operationId, denied, "input_invalid");
    }
    if (invocation.operationId === "decide_approval" && this.#isSelfApproval(invocation.input)) {
      const denied = this.#authorization.denyInvocation(
        invocation.operationId,
        context,
        "self_approval_conflict",
      );
      return this.#denial(invocation.operationId, denied, "policy_denied");
    }

    const beforeRevision = this.#adapter.snapshot().revision;
    try {
      const execution = await this.#execute(descriptor, invocation);
      const finalAuthorization = this.#authorization.attachStateChange(
        authorization.sequence,
        beforeRevision,
        this.#adapter.snapshot().revision,
        execution.entityRefs,
      );
      const resultId = execution.commandResult?.commandId ?? `tool-result-${++this.#resultSequence}`;
      const success: Phase7ToolSuccess = {
        schema: "paperclip.phase7.tool-result.v1",
        ok: true,
        operationId: invocation.operationId,
        operationResultId: resultId,
        value: execution.value,
        commandResult: execution.commandResult,
        authorization: finalAuthorization,
      };
      this.#operationResults.set(resultId, redactStoredResult(descriptor, execution.value));
      return deepFreeze(success);
    } catch {
      const denied = this.#authorization.denyInvocation(
        invocation.operationId,
        context,
        "mock_operation_rejected",
      );
      return this.#denial(invocation.operationId, denied, "operation_unsupported");
    }
  }

  async #execute(
    descriptor: Phase7SemanticToolDescriptor,
    invocation: Phase7ToolInvocation,
  ): Promise<{ value: Phase7JsonValue; commandResult: Phase7ToolSuccess["commandResult"]; entityRefs: string[] }> {
    const input = asObject(invocation.input);
    switch (descriptor.mockCommandMapping.kind) {
      case "context_read":
        return { value: toJsonValue(this.#adapter.context(this.#runId)), commandResult: null, entityRefs: [] };
      case "snapshot_read":
        return {
          value: this.#snapshotProjection(descriptor.mockCommandMapping.projection, input),
          commandResult: null,
          entityRefs: [],
        };
      case "operation_result": {
        const id = requireString(input.operationResultId);
        const result = this.#operationResults.get(id);
        if (result === undefined) throw new Error("operation result is not available");
        return { value: structuredClone(result), commandResult: null, entityRefs: [] };
      }
      case "semantic_command": {
        const command = commandForOperation(descriptor.operationId, input);
        const envelope: Phase7CommandEnvelope = {
          runId: this.#runId,
          idempotencyKey: invocation.idempotencyKey!,
          command,
        };
        const commandResult = await this.#adapter.applyCommand(envelope);
        return {
          value: toJsonValue(commandResult),
          commandResult,
          entityRefs: commandResult.entityRefs,
        };
      }
      case "mock_extension":
        return this.#executeExtension(descriptor, input);
    }
  }

  async #executeExtension(
    descriptor: Phase7SemanticToolDescriptor,
    input: Record<string, Phase7JsonValue>,
  ): Promise<{ value: Phase7JsonValue; commandResult: null; entityRefs: string[] }> {
    switch (descriptor.mockCommandMapping.kind === "mock_extension"
      ? descriptor.mockCommandMapping.extension
      : "") {
      case "discovery.projects":
      case "discovery.goals":
      case "cases.list":
      case "routines.list":
      case "company_skills.list":
        return { value: [], commandResult: null, entityRefs: [] };
      case "secrets.metadata":
        return { value: [], commandResult: null, entityRefs: [] };
      case "secrets.value": {
        const name = requireString(input.name);
        const value = await this.#resolveSecretValue?.(name);
        if (value === null || value === undefined) throw new Error("secret is not available");
        return { value: { name, value }, commandResult: null, entityRefs: [] };
      }
      case "portability.export": {
        const snapshot = this.#adapter.snapshot();
        return {
          value: {
            schema: "paperclip.phase7.mock-export.v1",
            company: { id: snapshot.company.id, name: snapshot.company.name },
            taskCount: snapshot.tasks.length,
            actorCount: snapshot.actors.length,
          },
          commandResult: null,
          entityRefs: [],
        };
      }
      case "test.generic_api":
        return {
          value: {
            status: 200,
            body: null,
            warning: "TEST-ONLY mock request; no control plane or network was contacted.",
          },
          commandResult: null,
          entityRefs: [],
        };
      default:
        throw new Error("mock extension is not implemented");
    }
  }

  #snapshotProjection(
    projection: string,
    input: Record<string, Phase7JsonValue>,
  ): Phase7JsonValue {
    const snapshot = this.#adapter.snapshot();
    const context = this.#adapter.context(this.#runId);
    switch (projection) {
      case "active_task_history":
        return toJsonValue(snapshot.comments.filter((comment) => comment.taskId === context.activeTask.id));
      case "active_task_documents":
        return toJsonValue(snapshot.documents
          .filter((document) => document.taskId === context.activeTask.id)
          .map(({ id, key, title, format, latestRevisionId, revisions }) => ({
            id, key, title, format, latestRevisionId, revisionCount: revisions.length,
          })));
      case "active_task_document": {
        const key = requireString(input.key);
        const document = snapshot.documents.find(
          (candidate) => candidate.taskId === context.activeTask.id && candidate.key === key,
        );
        if (document === undefined) throw new Error("document is not available");
        return toJsonValue(document);
      }
      case "active_task_document_revisions": {
        const key = requireString(input.key);
        const document = snapshot.documents.find(
          (candidate) => candidate.taskId === context.activeTask.id && candidate.key === key,
        );
        if (document === undefined) throw new Error("document is not available");
        return toJsonValue(document.revisions);
      }
      case "company_tasks": {
        const query = typeof input.query === "string" ? input.query.toLowerCase() : "";
        const status = typeof input.status === "string" ? input.status : null;
        return toJsonValue(snapshot.tasks.filter(
          (task) =>
            (query === "" || `${task.identifier} ${task.title} ${task.description ?? ""}`.toLowerCase().includes(query)) &&
            (status === null || task.status === status),
        ));
      }
      case "company_actors":
        return toJsonValue(snapshot.actors.map(({ id, companyId, name, role, status }) => ({ id, companyId, name, role, status })));
      case "company_approvals":
        return toJsonValue(snapshot.approvals);
      case "active_task_workspace":
        return toJsonValue(snapshot.workspaceServices.filter((service) => service.taskId === context.activeTask.id));
      default:
        throw new Error("snapshot projection is not implemented");
    }
  }

  #context(): Phase7ToolAuthorizationContext {
    const runContext = this.#adapter.context(this.#runId);
    return {
      runId: this.#runId,
      actor: {
        id: runContext.actor.id,
        role: runContext.actor.role,
        capabilityGrants: [...runContext.actor.capabilityGrants],
      },
      task: {
        id: runContext.activeTask.id,
        assigneeActorId: runContext.activeTask.assigneeActorId,
        workMode: runContext.activeTask.workMode,
      },
      scenarioGrants: [...this.#scenarioGrants],
      policy: this.#policy,
    };
  }

  #isSelfApproval(input: Phase7JsonValue): boolean {
    const approvalId = asObject(input).approvalId;
    if (typeof approvalId !== "string") return false;
    const actorId = this.#adapter.context(this.#runId).actor.id;
    const approval = this.#adapter.snapshot().approvals.find((candidate) => candidate.id === approvalId);
    return approval?.requestedByActorId === actorId;
  }

  #denial(
    operationId: string,
    authorization: Phase7AuthorizationRecord,
    code: Phase7PolicyDenial["error"]["code"],
  ): Phase7PolicyDenial {
    return deepFreeze({
      schema: "paperclip.phase7.tool-result.v1",
      ok: false,
      error: {
        code,
        message: code === "operation_absent"
          ? "The requested semantic operation is not available."
          : "The requested semantic operation was not executed.",
        operationId,
        reason: authorization.reason,
      },
      authorization,
    });
  }
}

function commandForOperation(
  operationId: string,
  input: Record<string, Phase7JsonValue>,
): Phase7SemanticCommand {
  switch (operationId) {
    case "report_progress":
    case "answer_status_question":
      return { kind: "report_progress", body: requireString(input.body) };
    case "finish_task":
      return { kind: "finish_task", summary: requireString(input.summary) };
    case "block_task":
      return {
        kind: "block_task",
        reason: requireString(input.reason),
        blockedByTaskIds: optionalStringArray(input.blockedByTaskIds),
      };
    case "request_review":
      return { kind: "request_review", summary: requireString(input.summary) };
    case "write_document":
      return {
        kind: "write_document",
        key: requireString(input.key),
        title: requireString(input.title),
        body: requireString(input.body, true),
        baseRevisionId: input.baseRevisionId === null ? null : requireString(input.baseRevisionId),
        changeSummary: typeof input.changeSummary === "string" ? input.changeSummary : undefined,
      };
    case "request_human_input":
      return {
        kind: "request_human_input",
        interactionKind: requireString(input.interactionKind) as never,
        title: requireString(input.title),
        prompt: requireString(input.prompt),
        payload: input.payload,
        targetRevisionId: input.targetRevisionId === null || input.targetRevisionId === undefined
          ? input.targetRevisionId
          : requireString(input.targetRevisionId),
        continuationPolicy: requireString(input.continuationPolicy) as never,
      };
    case "register_deliverable":
      return {
        kind: "register_deliverable",
        filename: requireString(input.filename),
        contentType: requireString(input.contentType),
        byteSize: input.byteSize as number,
        sha256: requireString(input.sha256),
        contentRef: requireString(input.contentRef),
        title: requireString(input.title),
      };
    case "create_task":
      return {
        kind: "create_task",
        title: requireString(input.title),
        description: typeof input.description === "string" ? input.description : undefined,
        assigneeActorId: typeof input.assigneeActorId === "string" ? input.assigneeActorId : undefined,
        priority: typeof input.priority === "string" ? input.priority as never : undefined,
        blockedByTaskIds: optionalStringArray(input.blockedByTaskIds),
      };
    case "set_dependencies":
      return { kind: "set_dependencies", blockedByTaskIds: optionalStringArray(input.blockedByTaskIds) ?? [] };
    case "request_approval":
      return { kind: "request_approval", approvalType: requireString(input.approvalType), payload: input.payload ?? {} };
    case "decide_approval":
      return {
        kind: "decide_approval",
        approvalId: requireString(input.approvalId),
        decision: requireString(input.decision) as never,
        note: requireString(input.note),
      };
    case "comment_on_approval":
      return { kind: "comment_on_approval", approvalId: requireString(input.approvalId), body: requireString(input.body) };
    case "control_workspace_service":
      return {
        kind: "control_workspace_service",
        serviceId: requireString(input.serviceId),
        action: requireString(input.action) as never,
        url: typeof input.url === "string" ? input.url : undefined,
      };
    default:
      throw new Error("semantic command mapping is not implemented");
  }
}

export function validateJsonSchema(schema: Phase7JsonSchema, value: Phase7JsonValue, path = "$" ): string[] {
  if (schema.oneOf !== undefined) {
    return schema.oneOf.some((candidate) => validateJsonSchema(candidate, value, path).length === 0)
      ? []
      : [`${path} does not match any allowed shape`];
  }
  if (schema.type !== undefined && !matchesType(schema.type, value)) return [`${path} must be ${schema.type}`];
  if (schema.enum !== undefined && !schema.enum.some((candidate) => JSON.stringify(candidate) === JSON.stringify(value))) {
    return [`${path} must be an allowed value`];
  }
  if (typeof value === "string" && schema.minLength !== undefined && value.length < schema.minLength) {
    return [`${path} is too short`];
  }
  if (typeof value === "number" && schema.minimum !== undefined && value < schema.minimum) {
    return [`${path} is below the minimum`];
  }
  if (Array.isArray(value) && schema.items !== undefined) {
    return value.flatMap((item, index) => validateJsonSchema(schema.items!, item, `${path}[${index}]`));
  }
  if (schema.type === "object" && typeof value === "object" && value !== null && !Array.isArray(value)) {
    const object = value as Record<string, Phase7JsonValue>;
    const issues = (schema.required ?? [])
      .filter((key) => !(key in object))
      .map((key) => `${path}.${key} is required`);
    for (const [key, child] of Object.entries(object)) {
      const childSchema = schema.properties?.[key];
      if (childSchema !== undefined) issues.push(...validateJsonSchema(childSchema, child, `${path}.${key}`));
      else if (schema.additionalProperties === false) issues.push(`${path}.${key} is not allowed`);
      else if (typeof schema.additionalProperties === "object") {
        issues.push(...validateJsonSchema(schema.additionalProperties, child, `${path}.${key}`));
      }
    }
    return issues;
  }
  return [];
}

function matchesType(type: NonNullable<Phase7JsonSchema["type"]>, value: Phase7JsonValue): boolean {
  switch (type) {
    case "null": return value === null;
    case "array": return Array.isArray(value);
    case "object": return typeof value === "object" && value !== null && !Array.isArray(value);
    case "integer": return typeof value === "number" && Number.isSafeInteger(value);
    default: return typeof value === type;
  }
}

function redactStoredResult(
  descriptor: Phase7SemanticToolDescriptor,
  value: Phase7JsonValue,
): Phase7JsonValue {
  if (!descriptor.redaction.some((rule) => rule.appliesTo.includes("output"))) return structuredClone(value);
  if (descriptor.operationId === "read_secret_value" && typeof value === "object" && value !== null && !Array.isArray(value)) {
    return { ...value, value: "[SECRET_VALUE]" };
  }
  return structuredClone(value);
}

function optionalStringArray(value: Phase7JsonValue | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new Error("expected string array");
  return value as string[];
}

function requireString(value: Phase7JsonValue | undefined, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) throw new Error("expected string");
  return value;
}

function asObject(value: Phase7JsonValue): Record<string, Phase7JsonValue> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("expected object input");
  return value;
}

function toJsonValue(value: unknown): Phase7JsonValue {
  return structuredClone(value) as Phase7JsonValue;
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}
