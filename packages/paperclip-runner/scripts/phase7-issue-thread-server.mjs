import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

/**
 * Package server for the Phase 7G issue-thread UI.
 *
 * The browser posts intents here; this process owns the real runnerd and Codex
 * app-server pair, the mock ControlPlanePort, and every policy decision. Each
 * response is a server-projected issue-thread view, so the page never holds
 * state or policy authority (Phase 7B UX contract §11).
 *
 * An interaction response is stored in the mock control plane before the
 * runner is resumed — that ordering is enforced inside `Phase7LiveSession`
 * (§5 response authority path).
 */

const ROUTE_PREFIX = "/api/phase7/ui";

async function loadRunner() {
  return import(new URL("../dist/index.js", import.meta.url).href);
}

async function createWorkingDirectory() {
  const scratchRoot =
    process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? process.env.PAPERCLIP_SCRATCH_DIR ?? tmpdir();
  return mkdtemp(resolve(scratchRoot, "phase7-issue-thread-"));
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

export function createPhase7IssueThreadMiddleware(options = {}) {
  const load = options.loadRunner ?? loadRunner;
  let bootstrap = null;
  let bindHost = options.bindHost ?? "127.0.0.1";
  /** @type {Map<string, { session: unknown, scenario: string, connection: { state: string, attempt: number } }>} */
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

  function view(runner, entry, sessionId) {
    return runner.projectPhase7IssueThread({
      snapshot: entry.session.snapshot(),
      connection: entry.connection,
      mode: "live",
      fixtureProfile: entry.scenario,
    });
  }

  async function readBody(request) {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
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
    const entry = { session, scenario, connection: { state: "connected", attempt: 0 } };
    sessions.set(session.id, entry);
    return entry;
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

      if (route === "session" && request.method === "GET") {
        const existing = requestedId === null ? undefined : sessions.get(requestedId);
        const entry = existing ?? (await createSession(runner, service, scenario, workingDirectory));
        send(response, 200, { sessionId: entry.session.id, view: view(runner, entry) });
        return;
      }

      if (route === "session" && request.method === "POST") {
        const entry = await createSession(runner, service, scenario, workingDirectory);
        send(response, 201, { sessionId: entry.session.id, view: view(runner, entry) });
        return;
      }

      const entry = requestedId === null ? undefined : sessions.get(requestedId);
      if (entry === undefined) {
        send(response, 404, { error: "unknown_session" });
        return;
      }

      if (route === "message") {
        await entry.session.sendMessage(String(body.message ?? ""));
      } else if (route === "interrupt") {
        await entry.session.interrupt("operator stopped the turn");
      } else if (route === "reconnect") {
        entry.connection = { state: "reconnecting", attempt: entry.connection.attempt + 1 };
        await entry.session.reconnect();
        entry.connection = { state: "connected", attempt: 0 };
      } else if (route === "reset") {
        const next = await service.reset(entry.session.id);
        sessions.delete(entry.session.id);
        const resetEntry = {
          session: next,
          scenario: entry.scenario,
          connection: { state: "connected", attempt: 0 },
        };
        sessions.set(next.id, resetEntry);
        send(response, 200, { sessionId: next.id, view: view(runner, resetEntry) });
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

      send(response, 200, { sessionId: entry.session.id, view: view(runner, entry) });
    } catch (error) {
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
      await service.shutdown(sessionId, "server shutdown").catch(() => undefined);
      sessions.delete(sessionId);
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
