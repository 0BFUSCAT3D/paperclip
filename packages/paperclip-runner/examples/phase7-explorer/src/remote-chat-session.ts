import type {
  Phase7ChatSessionArtifact,
  Phase7ChatSessionOptions,
  Phase7ScenarioIndexEntry,
} from "@paperclip-runner-local/phase7";

import type { Phase7ChatSessionClient } from "./components/chat-surface.js";

type SessionResponse = {
  sessionId: string;
  artifact: Phase7ChatSessionArtifact;
  nextPrompt: string | null;
};

function apiBaseFromDocument(): URL | null {
  const configured = document
    .querySelector<HTMLMetaElement>('meta[name="phase7i-api-base"]')
    ?.content.trim();
  if (!configured) return null;
  const url = new URL(configured.replace(/\/*$/, "/"), document.baseURI);
  return url.origin === window.location.origin ? url : null;
}

async function parseResponse(response: Response): Promise<SessionResponse> {
  if (!response.ok) throw new Error(`The Phase 7I demo returned HTTP ${response.status}.`);
  const value: unknown = await response.json();
  if (
    typeof value !== "object" || value === null ||
    typeof (value as { sessionId?: unknown }).sessionId !== "string" ||
    typeof (value as { artifact?: unknown }).artifact !== "object"
  ) {
    throw new Error("The Phase 7I demo returned an invalid session response.");
  }
  return value as SessionResponse;
}

export class Phase7RemoteChatSession implements Phase7ChatSessionClient {
  private constructor(
    private readonly apiBase: URL,
    private sessionId: string,
    private currentArtifact: Phase7ChatSessionArtifact,
    private suggestedPrompt: string | null,
  ) {}

  static available(): boolean {
    return apiBaseFromDocument() !== null;
  }

  static async open(
    entry: Phase7ScenarioIndexEntry,
    _options: Phase7ChatSessionOptions = {},
  ): Promise<Phase7RemoteChatSession> {
    const apiBase = apiBaseFromDocument();
    if (!apiBase) throw new Error("The Phase 7I server endpoint is not configured.");
    const response = await fetch(new URL("sessions", apiBase), {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scenarioId: entry.id }),
    });
    const opened = await parseResponse(response);
    return new Phase7RemoteChatSession(
      apiBase,
      opened.sessionId,
      opened.artifact,
      opened.nextPrompt,
    );
  }

  artifact(): Phase7ChatSessionArtifact {
    return this.currentArtifact;
  }

  nextPrompt(): string | null {
    return this.suggestedPrompt;
  }

  async send(prompt: string): Promise<Phase7ChatSessionArtifact> {
    return await this.mutate("turn", { prompt });
  }

  async replay(): Promise<Phase7ChatSessionArtifact> {
    return await this.mutate("replay", {});
  }

  async close(): Promise<void> {
    await fetch(new URL(`sessions/${this.sessionId}`, this.apiBase), {
      method: "DELETE",
      credentials: "same-origin",
      keepalive: true,
    }).catch(() => undefined);
  }

  private async mutate(action: "turn" | "replay", body: Record<string, unknown>): Promise<Phase7ChatSessionArtifact> {
    const response = await fetch(new URL(`sessions/${this.sessionId}/${action}`, this.apiBase), {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const updated = await parseResponse(response);
    this.sessionId = updated.sessionId;
    this.currentArtifact = updated.artifact;
    this.suggestedPrompt = updated.nextPrompt;
    return this.currentArtifact;
  }
}
