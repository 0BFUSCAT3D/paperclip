import type { Phase7IssueThreadSnapshot } from "../../../src/issue-thread/types";
import {
  PHASE7_TURN_STREAM_ACCEPT,
  Phase7TurnStreamError,
  readPhase7TurnStream,
} from "../../../src/phase7/turn-stream";

/**
 * Browser client for the package session server.
 *
 * Every response is a server-projected `Phase7IssueThreadSnapshot`. The client
 * posts intents and renders what comes back; it never patches the snapshot
 * locally, which is what keeps policy and state authority on the server
 * (contract §11).
 *
 * A turn is the one route that answers with many of those projections instead
 * of one: `send` consumes NDJSON frames as the provider produces them, hands
 * each interim view to `onFrame`, and resolves with the settled payload. The
 * authority rule is unchanged — every frame is still a server projection, and
 * the settled one is final.
 */

const BASE = "/api/phase7/ui";

export interface Phase7CleanRoomIdentity {
  token: string;
  sequence: number;
  companyId: string;
  actorId: string;
  taskId: string;
  identifier: string;
}

export interface Phase7LiveResponse {
  sessionId: string;
  view: Phase7IssueThreadSnapshot;
  surface?: "issue" | "cleanroom";
  /** Present on the clean-room surface so the UI can show which tenant is live. */
  identity?: Phase7CleanRoomIdentity;
  limits?: { maxTurns: number; maxMessageBytes: number };
  turns?: number;
}

/**
 * The server names its own failures. Surfacing the code lets the clean room say
 * "this chat hit its turn limit" instead of "500", and — more importantly —
 * lets a failure to start real Codex read as a failure rather than quietly
 * degrading into a fixture.
 */
export class Phase7LiveError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "Phase7LiveError";
  }
}

async function readError(response: Response, path: string): Promise<Phase7LiveError> {
  try {
    const body = (await response.json()) as { error?: string; message?: string };
    return new Phase7LiveError(
      body.error ?? `http_${response.status}`,
      body.message ?? `${path} failed with ${response.status}`,
    );
  } catch {
    return new Phase7LiveError(`http_${response.status}`, `${path} failed with ${response.status}`);
  }
}

async function post(path: string, body: unknown): Promise<Phase7LiveResponse> {
  const response = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw await readError(response, path);
  return (await response.json()) as Phase7LiveResponse;
}

/** Interim projection delivered while the turn is still running. */
export type Phase7TurnFrameHandler = (view: Phase7IssueThreadSnapshot) => void;

export interface Phase7SendOptions {
  onFrame?: Phase7TurnFrameHandler;
  /** Abort the turn stream — used when the surface is torn down or rotated. */
  signal?: AbortSignal;
}

async function postTurnStream(
  path: string,
  body: unknown,
  options: Phase7SendOptions,
): Promise<Phase7LiveResponse> {
  const response = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: PHASE7_TURN_STREAM_ACCEPT },
    body: JSON.stringify(body),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  // Admission failures still answer with a JSON body and a real status code,
  // because they are decided before the first frame is written.
  if (!response.ok) throw await readError(response, path);
  try {
    return await readPhase7TurnStream<Phase7IssueThreadSnapshot, Phase7LiveResponse>(
      response,
      (frame) => options.onFrame?.(frame.view),
    );
  } catch (cause) {
    if (cause instanceof Phase7TurnStreamError) {
      throw new Phase7LiveError(cause.code, cause.message);
    }
    throw cause;
  }
}

export const phase7LiveClient = {
  async load(sessionId: string | null): Promise<Phase7LiveResponse> {
    const query = sessionId === null ? "" : `?sessionId=${encodeURIComponent(sessionId)}`;
    const response = await fetch(`${BASE}/session${query}`);
    if (!response.ok) throw await readError(response, "/session");
    return (await response.json()) as Phase7LiveResponse;
  },
  create(scenario: string): Promise<Phase7LiveResponse> {
    return post("/session", { scenario });
  },
  /** Reconnect to a clean room, or open one when there is nothing to resume. */
  async loadCleanRoom(sessionId: string | null): Promise<Phase7LiveResponse> {
    const query = sessionId === null ? "" : `?sessionId=${encodeURIComponent(sessionId)}`;
    const response = await fetch(`${BASE}/cleanroom/session${query}`);
    if (!response.ok) throw await readError(response, "/cleanroom/session");
    return (await response.json()) as Phase7LiveResponse;
  },
  /** `New chat`: retire the current room and mint a new mock tenant. */
  newCleanRoom(sessionId: string | null): Promise<Phase7LiveResponse> {
    return post("/cleanroom/session", sessionId === null ? {} : { sessionId });
  },
  /**
   * Runs one turn. `onFrame` fires for every interim projection the server
   * writes while the POST is open; the resolved value is the settled payload.
   */
  send(
    sessionId: string,
    message: string,
    options: Phase7SendOptions = {},
  ): Promise<Phase7LiveResponse> {
    return postTurnStream("/message", { sessionId, message }, options);
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
/**
 * The clean room keeps its own key. Sharing one would let a scenario session id
 * be handed to the clean-room route (and the reverse) after a refresh, which is
 * exactly the cross-surface bleed the isolation criterion forbids.
 */
const CLEAN_ROOM_STORAGE_KEY = "paperclip-runner.phase7.cleanroom.session";

function storageKey(surface: "issue" | "cleanroom"): string {
  return surface === "cleanroom" ? CLEAN_ROOM_STORAGE_KEY : SESSION_STORAGE_KEY;
}

export function rememberSession(sessionId: string, surface: "issue" | "cleanroom" = "issue"): void {
  try {
    window.localStorage.setItem(storageKey(surface), sessionId);
  } catch {
    // Refresh restore falls back to a fresh session when storage is blocked.
  }
}

export function recallSession(surface: "issue" | "cleanroom" = "issue"): string | null {
  try {
    return window.localStorage.getItem(storageKey(surface));
  } catch {
    return null;
  }
}
