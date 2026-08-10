import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

/**
 * Package server for the Phase 7G issue-thread UI and the Phase 7M clean-room
 * chat.
 *
 * The browser posts intents here; this process owns the real runnerd and Codex
 * app-server pair, the mock ControlPlanePort, and every policy decision. Each
 * response is a server-projected issue-thread view, so the page never holds
 * state or policy authority (Phase 7B UX contract §11).
 *
 * An interaction response is stored in the mock control plane before the
 * runner is resumed — that ordering is enforced inside `Phase7LiveSession`
 * (§5 response authority path).
 *
 * Two surfaces share one session registry and one set of turn routes:
 *
 * - `issue` seeds the preset scenario the explorer selects;
 * - `cleanroom` seeds only a company, an agent, and a blank issue.
 *
 * Both run the same real runnerd + real Codex loop. Neither has a scripted or
 * replay path in this process, so there is nothing here that could quietly
 * substitute for a live turn.
 */

const ROUTE_PREFIX = "/api/phase7/ui";
const CLEAN_ROOM_ROUTE = "cleanroom/session";
/** Bounded concurrency (revision 5 safety requirements). */
const MAX_CLEAN_ROOM_SESSIONS = 4;
/** Bounded output: a clean room is a demo, not a long-lived agent. */
const MAX_TURNS_PER_SESSION = 24;
const MAX_MESSAGE_BYTES = 8 * 1024;
/**
 * Bounded frames per streamed turn. Past this the turn keeps running and still
 * settles with the authoritative payload; only the interim views stop, so a
 * chatty provider cannot turn one turn into unbounded socket writes.
 */
const MAX_TURN_STREAM_FRAMES = 600;

async function loadRunner() {
  return import(new URL("../dist/index.js", import.meta.url).href);
}

function scratchRoot() {
  return process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? process.env.PAPERCLIP_SCRATCH_DIR ?? tmpdir();
}

async function createWorkingDirectory(prefix = "phase7-issue-thread-") {
  return mkdtemp(resolve(scratchRoot(), prefix));
}

/** Mock-only fixture seed. Identifiers use the reserved `MCK-` prefix (§1.3). */
function issueThreadSeed(runner, scenario) {
  return runner.createPhase7FixtureState({
    epochMs: Date.UTC(2026, 7, 9, 9, 0, 0),
    company: { id: "company-1", name: "Mock Paperclip Company", issuePrefix: "MCK" },
    actors: [
      {
        id: "actor-1",
        companyId: "company-1",
        name: "Mock Engineer",
        role: "engineer",
        status: "active",
        budgetId: "budget-actor-1",
        capabilityGrants: [],
      },
    ],
    tasks: [
      {
        id: "task-31",
        companyId: "company-1",
        identifier: "MCK-31",
        title: "Wire the runner spike to the mock control plane",
        description: `Scenario ${scenario}. All records in this thread are mock records.`,
        status: "todo",
        priority: "high",
        workMode: "standard",
        parentId: null,
        assigneeActorId: "actor-1",
        checkoutRunId: null,
        executionRunId: null,
        startedAt: null,
        completedAt: null,
      },
    ],
  });
}

class RouteError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function createPhase7IssueThreadMiddleware(options = {}) {
  const load = options.loadRunner ?? loadRunner;
  let bootstrap = null;
  let bindHost = options.bindHost ?? "127.0.0.1";
  /**
   * @type {Map<string, {
   *   session: unknown,
   *   surface: "issue" | "cleanroom",
   *   scenario: string,
   *   identity: unknown,
   *   workingDirectory: string,
   *   ownsWorkingDirectory: boolean,
   *   turns: number,
   *   createdAt: number,
   *   connection: { state: string, attempt: number },
   * }>}
   */
  const sessions = new Map();

  async function ready(requestedBindHost = bindHost) {
    bindHost = requestedBindHost;
    if (bootstrap !== null) return bootstrap;
    bootstrap = (async () => {
      const runner = await load();
      runner.assertPhase4bLoopbackBindHost(bindHost);
      const workingDirectory = options.workingDirectory ?? (await createWorkingDirectory());
      const service = new runner.Phase7LiveSessionService({
        store: new runner.InMemoryPhase7LiveSessionStore(),
        ...(options.transportFactory === undefined
          ? {}
          : { transportFactory: options.transportFactory }),
      });
      return { runner, service, workingDirectory };
    })();
    return bootstrap;
  }

  function view(runner, entry) {
    return runner.projectPhase7IssueThread({
      snapshot: entry.session.snapshot(),
      connection: entry.connection,
      mode: "live",
      fixtureProfile: entry.scenario,
    });
  }

  /**
   * The clean room must never answer with a scripted or replayed turn. The
   * projection is the only thing the browser sees, so the guard sits on the way
   * out rather than on the way in.
   */
  function liveView(runner, entry) {
    const projected = view(runner, entry);
    if (projected.mode !== "live" || projected.identity.agentLabel !== "Real Codex") {
      throw new RouteError(500, "live_mode_required", "The clean-room path refused a non-live view.");
    }
    return projected;
  }

  async function readBody(request) {
    const chunks = [];
    let total = 0;
    for await (const chunk of request) {
      total += chunk.length;
      if (total > MAX_MESSAGE_BYTES * 4) {
        throw new RouteError(413, "request_too_large", "Request body exceeds the server limit.");
      }
      chunks.push(chunk);
    }
    if (chunks.length === 0) return {};
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      return {};
    }
  }

  function send(response, status, payload) {
    response.statusCode = status;
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.end(JSON.stringify(payload));
  }

  async function createSession(runner, service, scenario, workingDirectory) {
    const session = await service.create({
      seed: issueThreadSeed(runner, scenario),
      workingDirectory,
      scenario: { id: scenario },
      taskId: "task-31",
      actorId: "actor-1",
      companyId: "company-1",
    });
    const entry = {
      session,
      surface: "issue",
      scenario,
      identity: null,
      workingDirectory,
      ownsWorkingDirectory: false,
      turns: 0,
      createdAt: Date.now(),
      connection: { state: "connected", attempt: 0 },
    };
    sessions.set(session.id, entry);
    return entry;
  }

  /** Retire a session: stop its work, clear its authority, drop its workspace. */
  async function retire(service, sessionId, reason) {
    const entry = sessions.get(sessionId);
    if (entry === undefined) return;
    sessions.delete(sessionId);
    await service.stop(sessionId, reason).catch(() => undefined);
    if (entry.ownsWorkingDirectory) {
      await rm(entry.workingDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async function createCleanRoomSession(runner, service) {
    const open = [...sessions.values()].filter((entry) => entry.surface === "cleanroom");
    // Bounded concurrency: the oldest clean room yields rather than refusing a
    // new board user, because an abandoned chat is the likelier tenant here.
    for (const stale of open.slice(0, Math.max(0, open.length - (MAX_CLEAN_ROOM_SESSIONS - 1)))) {
      await retire(service, stale.session.id, "clean-room capacity");
    }
    const workingDirectory = await createWorkingDirectory("phase7-clean-room-");
    const { identity, input } = runner.createPhase7CleanRoomSessionInput({ workingDirectory });
    let session;
    try {
      session = await service.create(input);
    } catch (error) {
      await rm(workingDirectory, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
    const entry = {
      session,
      surface: "cleanroom",
      scenario: "clean-room",
      identity,
      workingDirectory,
      ownsWorkingDirectory: true,
      turns: 0,
      createdAt: Date.now(),
      connection: { state: "connected", attempt: 0 },
    };
    sessions.set(session.id, entry);
    return entry;
  }

  function cleanRoomPayload(runner, entry) {
    return {
      sessionId: entry.session.id,
      surface: "cleanroom",
      identity: entry.identity,
      limits: { maxTurns: MAX_TURNS_PER_SESSION, maxMessageBytes: MAX_MESSAGE_BYTES },
      turns: entry.turns,
      view: liveView(runner, entry),
    };
  }

  function payload(runner, entry) {
    return entry.surface === "cleanroom"
      ? cleanRoomPayload(runner, entry)
      : { sessionId: entry.session.id, surface: "issue", view: view(runner, entry) };
  }

  /** The clean room keeps its live-only guard on every frame, not just the last. */
  function frameView(runner, entry) {
    return entry.surface === "cleanroom" ? liveView(runner, entry) : view(runner, entry);
  }

  /**
   * Streams one turn as NDJSON frames (track 7Q).
   *
   * The turn used to be awaited whole and answered once, so the browser could
   * only ever reveal a finished reply. Now every provider delta, tool call, and
   * tool result the live session announces is projected and written while the
   * POST is still open. The final `settled` frame carries exactly the payload
   * the single JSON response used to carry, so the terminal projection — not
   * any interim frame — remains the authority.
   *
   * Interim frames are coalesced onto the next event-loop turn: a burst of
   * deltas that arrives in one tick becomes one frame, while deltas separated
   * by real provider I/O each get their own. That bounds the write rate without
   * a timer, and without inventing a cadence the provider did not have.
   */
  async function streamTurn(runner, entry, message, request, response) {
    response.statusCode = 200;
    for (const [name, value] of Object.entries(runner.PHASE7_TURN_STREAM_HEADERS)) {
      response.setHeader(name, value);
    }
    // Headers before the first frame: a client that waits for them must not be
    // held until the provider speaks.
    response.flushHeaders();

    let seq = 0;
    let frames = 0;
    let finished = false;
    let scheduled = null;
    let pendingReason = null;
    let pendingTurnId = null;

    const write = (frame) => {
      if (response.writableEnded || response.destroyed) return;
      seq += 1;
      response.write(runner.encodePhase7TurnStreamFrame({ ...frame, seq }));
    };

    const flush = () => {
      scheduled = null;
      if (finished || pendingReason === null) return;
      if (frames >= MAX_TURN_STREAM_FRAMES) return;
      const reason = pendingReason;
      const turnId = pendingTurnId;
      pendingReason = null;
      pendingTurnId = null;
      let projected;
      try {
        projected = frameView(runner, entry);
      } catch {
        // A projection failure is reported by the terminal frame; dropping an
        // interim view must never abort a turn that is still running.
        return;
      }
      frames += 1;
      write({
        schema: runner.PHASE7_TURN_STREAM_SCHEMA,
        type: "frame",
        reason,
        turnId,
        view: projected,
      });
    };

    const unsubscribe = entry.session.subscribe((event) => {
      if (finished || event.kind === "terminal" || event.kind === "error") return;
      pendingReason = event.kind === "delta" ? "delta" : event.reason === "stop_requested" ? "stop_requested" : "activity";
      pendingTurnId = event.turnId;
      if (scheduled === null) scheduled = setImmediate(flush);
    });

    // A browser that navigates away, reloads, or aborts the fetch mid-turn is a
    // stop: the provider turn is interrupted rather than left running against a
    // socket nobody is reading.
    const onDisconnect = () => {
      if (finished) return;
      void entry.session.interrupt("client disconnected").catch(() => undefined);
    };
    request.on("aborted", onDisconnect);
    response.on("close", onDisconnect);

    // `sendMessage` records the user message and marks the session running
    // before its first await, so starting it and *then* flushing makes the
    // opening frame already show what was sent and a live composer.
    const turn = entry.session.sendMessage(message);
    pendingReason = "open";
    pendingTurnId = null;
    flush();

    try {
      await turn;
      finished = true;
      write({
        schema: runner.PHASE7_TURN_STREAM_SCHEMA,
        type: "settled",
        payload: payload(runner, entry),
      });
    } catch (error) {
      finished = true;
      write({
        schema: runner.PHASE7_TURN_STREAM_SCHEMA,
        type: "error",
        error: error instanceof RouteError ? error.code : "turn_failed",
        message: String(error instanceof Error ? error.message : error),
      });
    } finally {
      finished = true;
      if (scheduled !== null) clearImmediate(scheduled);
      unsubscribe();
      request.off("aborted", onDisconnect);
      response.off("close", onDisconnect);
      response.end();
    }
  }

  const middleware = async function phase7IssueThreadMiddleware(request, response, next) {
    const url = new URL(request.url ?? "/", "http://phase7.local");
    if (!url.pathname.startsWith(`${ROUTE_PREFIX}/`)) {
      next();
      return;
    }
    try {
      const { runner, service, workingDirectory } = await ready();
      const route = url.pathname.slice(ROUTE_PREFIX.length + 1);
      const body = request.method === "POST" ? await readBody(request) : {};
      const requestedId =
        typeof body.sessionId === "string" ? body.sessionId : url.searchParams.get("sessionId");
      const scenario =
        typeof body.scenario === "string" ? body.scenario : url.searchParams.get("scenario") ?? "hb-baseline";

      if (route === CLEAN_ROOM_ROUTE && request.method === "GET") {
        const existing = requestedId === null ? undefined : sessions.get(requestedId);
        // A stale id from localStorage opens a fresh room rather than a dead
        // end; a live id reconnects to the same durable chat.
        const entry =
          existing !== undefined && existing.surface === "cleanroom"
            ? existing
            : await createCleanRoomSession(runner, service);
        send(response, 200, cleanRoomPayload(runner, entry));
        return;
      }

      if (route === CLEAN_ROOM_ROUTE && request.method === "POST") {
        // `New chat`: retire the caller's room before minting the next one, so
        // the prior session authority is cleared rather than left running.
        if (requestedId !== null) await retire(service, requestedId, "new clean-room chat");
        const entry = await createCleanRoomSession(runner, service);
        send(response, 201, cleanRoomPayload(runner, entry));
        return;
      }

      if (route === "session" && request.method === "GET") {
        const existing = requestedId === null ? undefined : sessions.get(requestedId);
        const entry =
          existing !== undefined && existing.surface === "issue"
            ? existing
            : await createSession(runner, service, scenario, workingDirectory);
        send(response, 200, payload(runner, entry));
        return;
      }

      if (route === "session" && request.method === "POST") {
        const entry = await createSession(runner, service, scenario, workingDirectory);
        send(response, 201, payload(runner, entry));
        return;
      }

      const entry = requestedId === null ? undefined : sessions.get(requestedId);
      if (entry === undefined) {
        send(response, 404, { error: "unknown_session" });
        return;
      }

      if (route === "message") {
        const message = String(body.message ?? "");
        if (Buffer.byteLength(message, "utf8") > MAX_MESSAGE_BYTES) {
          throw new RouteError(413, "message_too_large", "Message exceeds the server limit.");
        }
        if (entry.turns >= MAX_TURNS_PER_SESSION) {
          throw new RouteError(
            429,
            "turn_limit",
            `This chat reached its ${MAX_TURNS_PER_SESSION}-turn limit. Start a new chat to continue.`,
          );
        }
        entry.turns += 1;
        // Every admission check has already answered with its own status code;
        // from here the response is a stream, so a failure is a framed error.
        await streamTurn(runner, entry, message, request, response);
        return;
      } else if (route === "interrupt") {
        await entry.session.interrupt("operator stopped the turn");
      } else if (route === "reconnect") {
        entry.connection = { state: "reconnecting", attempt: entry.connection.attempt + 1 };
        await entry.session.reconnect();
        entry.connection = { state: "connected", attempt: 0 };
      } else if (route === "reset") {
        if (entry.surface === "cleanroom") {
          // A clean-room reset is a new tenant, not a rewound one: the seed is
          // blank either way, so restoring it would hand back the same mock
          // identities the board just saw.
          await retire(service, entry.session.id, "clean-room reset");
          const replacement = await createCleanRoomSession(runner, service);
          send(response, 200, cleanRoomPayload(runner, replacement));
          return;
        }
        const next = await service.reset(entry.session.id);
        sessions.delete(entry.session.id);
        const resetEntry = {
          ...entry,
          session: next,
          turns: 0,
          connection: { state: "connected", attempt: 0 },
        };
        sessions.set(next.id, resetEntry);
        send(response, 200, payload(runner, resetEntry));
        return;
      } else if (route === "interaction") {
        // The session stores the typed response in the mock control plane
        // before resuming the same provider thread.
        await entry.session.resolveInteraction({
          interactionId: String(body.interactionId ?? ""),
          outcome: String(body.outcome ?? "answered"),
          result: body.result ?? null,
        });
      } else {
        send(response, 404, { error: "unknown_route" });
        return;
      }

      send(response, 200, payload(runner, entry));
    } catch (error) {
      if (response.headersSent) {
        // A streamed turn reports its own failures as a framed error; there is
        // no status code left to send once the first frame is on the wire.
        if (!response.writableEnded) response.end();
        return;
      }
      if (error instanceof RouteError) {
        send(response, error.status, { error: error.code, message: error.message });
        return;
      }
      send(response, 500, {
        error: "phase7_issue_thread_unavailable",
        message: String(error instanceof Error ? error.message : error),
      });
    }
  };

  middleware.close = async () => {
    if (bootstrap === null) return;
    const { service } = await bootstrap;
    for (const sessionId of [...sessions.keys()]) {
      await retire(service, sessionId, "server shutdown");
    }
  };
  middleware.prepare = ready;
  return middleware;
}

export function phase7IssueThreadServerPlugin(options = {}) {
  async function mount(server, host) {
    const middleware = createPhase7IssueThreadMiddleware({ ...options, bindHost: host });
    await middleware.prepare(host);
    server.middlewares.use(middleware);
    server.httpServer?.once("close", () => void middleware.close());
  }
  return {
    name: "paperclip-runner-phase7-issue-thread-server",
    async configureServer(server) {
      const host = server.config.server.host;
      await mount(server, typeof host === "string" ? host : host === true ? "0.0.0.0" : "127.0.0.1");
    },
    async configurePreviewServer(server) {
      const host = server.config.preview.host;
      await mount(server, typeof host === "string" ? host : host === true ? "0.0.0.0" : "127.0.0.1");
    },
  };
}
