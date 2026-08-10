import type { Phase7IssueThreadSnapshot } from "../../../src/issue-thread/types";

/**
 * Browser client for the package session server.
 *
 * Every response is a server-projected `Phase7IssueThreadSnapshot`. The client
 * posts intents and renders what comes back; it never patches the snapshot
 * locally, which is what keeps policy and state authority on the server
 * (contract §11).
 */

const BASE = "/api/phase7/ui";

export interface Phase7LiveResponse {
  sessionId: string;
  view: Phase7IssueThreadSnapshot;
}

async function post(path: string, body: unknown): Promise<Phase7LiveResponse> {
  const response = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`${path} failed with ${response.status}`);
  }
  return (await response.json()) as Phase7LiveResponse;
}

export const phase7LiveClient = {
  async load(sessionId: string | null): Promise<Phase7LiveResponse> {
    const query = sessionId === null ? "" : `?sessionId=${encodeURIComponent(sessionId)}`;
    const response = await fetch(`${BASE}/session${query}`);
    if (!response.ok) throw new Error(`session load failed with ${response.status}`);
    return (await response.json()) as Phase7LiveResponse;
  },
  create(scenario: string): Promise<Phase7LiveResponse> {
    return post("/session", { scenario });
  },
  send(sessionId: string, message: string): Promise<Phase7LiveResponse> {
    return post("/message", { sessionId, message });
  },
  stop(sessionId: string): Promise<Phase7LiveResponse> {
    return post("/interrupt", { sessionId });
  },
  reset(sessionId: string): Promise<Phase7LiveResponse> {
    return post("/reset", { sessionId });
  },
  reconnect(sessionId: string): Promise<Phase7LiveResponse> {
    return post("/reconnect", { sessionId });
  },
  respond(
    sessionId: string,
    interactionId: string,
    outcome: string,
    result: unknown,
  ): Promise<Phase7LiveResponse> {
    return post("/interaction", { sessionId, interactionId, outcome, result });
  },
};

const SESSION_STORAGE_KEY = "paperclip-runner.phase7.session";

export function rememberSession(sessionId: string): void {
  try {
    window.localStorage.setItem(SESSION_STORAGE_KEY, sessionId);
  } catch {
    // Refresh restore falls back to a fresh session when storage is blocked.
  }
}

export function recallSession(): string | null {
  try {
    return window.localStorage.getItem(SESSION_STORAGE_KEY);
  } catch {
    return null;
  }
}
