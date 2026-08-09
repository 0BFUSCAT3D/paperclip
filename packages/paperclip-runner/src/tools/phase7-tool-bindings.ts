import type {
  Phase7JsonSchema,
  Phase7SemanticToolDescriptor,
  Phase7VisibleToolSet,
} from "./phase7-semantic-tool-types.js";

export interface Phase7ToolBinding<TDefinition> {
  readonly kind: "fake_agent" | "codex";
  bind(visibleTools: Phase7VisibleToolSet): readonly TDefinition[];
  operationId(definition: TDefinition): string;
}

export interface Phase7FakeAgentToolDefinition {
  operationId: string;
  description: string;
  inputSchema: Phase7JsonSchema;
  outputSchema: Phase7JsonSchema;
}

export interface Phase7CodexToolDefinition {
  type: "function";
  name: string;
  description: string;
  strict: true;
  parameters: Phase7JsonSchema;
}

export class Phase7FakeAgentToolBinding implements Phase7ToolBinding<Phase7FakeAgentToolDefinition> {
  readonly kind = "fake_agent" as const;

  bind(visibleTools: Phase7VisibleToolSet): readonly Phase7FakeAgentToolDefinition[] {
    return freezeDefinitions(visibleTools.tools.map((tool) => ({
      operationId: tool.operationId,
      description: tool.description,
      inputSchema: structuredClone(tool.inputSchema),
      outputSchema: structuredClone(tool.outputSchema),
    })));
  }

  operationId(definition: Phase7FakeAgentToolDefinition): string {
    return definition.operationId;
  }
}

export class Phase7CodexToolBinding implements Phase7ToolBinding<Phase7CodexToolDefinition> {
  readonly kind = "codex" as const;

  bind(visibleTools: Phase7VisibleToolSet): readonly Phase7CodexToolDefinition[] {
    return freezeDefinitions(visibleTools.tools.map(toCodexDefinition));
  }

  operationId(definition: Phase7CodexToolDefinition): string {
    return definition.name;
  }
}

function toCodexDefinition(tool: Phase7SemanticToolDescriptor): Phase7CodexToolDefinition {
  return {
    type: "function",
    name: tool.operationId,
    description: tool.description,
    strict: true,
    parameters: structuredClone(tool.inputSchema),
  };
}

function freezeDefinitions<T>(definitions: T[]): readonly T[] {
  for (const definition of definitions) deepFreeze(definition);
  return Object.freeze(definitions);
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}
