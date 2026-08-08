import { randomUUID } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";

import type {
  HarnessDriver,
  HarnessGoalOperation,
  HarnessRuntimeRequestResolution,
  HarnessSession,
} from "../contracts/harness-driver.js";
import {
  createPhase4TaskEnvelope,
  type Phase4TaskEnvelope,
} from "../contracts/phase4.js";
import type { NativeSessionCapabilities } from "../contracts/types.js";
import {
  validatePrpEvent,
  type PrpCapabilities,
  type PrpEvent,
} from "../protocol/phase1-contract.js";
import {
  applyPrpEvent,
  createSessionSnapshotFromMetadata,
} from "../reducer/session-reducer.js";
import { redactCodexDiagnostic } from "../drivers/codex/app-server-transport.js";

const MAX_BROWSER_BODY_BYTES = 64 * 1024;
const MAX_BROWSER_EVENTS = 4096;

export interface Phase4bDemoServerOptions {
  workingDirectory: string;
  driverFactory: (envelope: Phase4TaskEnvelope) => HarnessDriver;
  host?: string;
  port?: number;
}

interface DemoEntry {
  id: string;
  runId: string;
  normalizedSessionId: string;
  envelope: Phase4TaskEnvelope;
  driver: HarnessDriver;
  session: HarnessSession;
  capabilities: NativeSessionCapabilities;
  events: PrpEvent[];
  subscribers: Set<ServerResponse>;
  consumeTask: Promise<void>;
}

interface BrowserCreateBody {
  objective?: string;
  message?: string;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function browserSafe(value: unknown, depth = 0): unknown {
  if (depth > 10) return "[TRUNCATED]";
  if (typeof value === "string") return redactBrowserString(value);
  if (Array.isArray(value)) return value.slice(0, 256).map((entry) => browserSafe(entry, depth + 1));
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).slice(0, 256).map(([key, entry]) => [
      key,
      isSensitiveBrowserKey(key)
        ? "[REDACTED]"
        : browserSafe(entry, depth + 1),
    ]),
  );
}

function redactBrowserString(value: string): string {
  return redactCodexDiagnostic(value).replace(
    /\/(?:srv\/paperclip\/home|home\/[^/\s]+)\/\.paperclip\/[^\s"'<>),\]}]*/g,
    "<server-path>",
  );
}

function isSensitiveBrowserKey(key: string): boolean {
  return /^(?:api[_-]?key|token|accessToken|refreshToken|secret|password|authorization|cookie)$/i.test(key) ||
    /(?:^|_)(?:api[_-]?key|token|secret|password|authorization|cookie)$/i.test(key);
}

function json(response: ServerResponse, status: number, body: unknown): void {
  const serialized = JSON.stringify(browserSafe(body));
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(serialized),
  });
  response.end(serialized);
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BROWSER_BODY_BYTES) throw new Error("browser request body is too large");
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  const value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("browser request body must be a JSON object");
  }
  return value as Record<string, unknown>;
}

function prpCapabilities(capabilities: NativeSessionCapabilities): PrpCapabilities {
  return {
    schema: "paperclip.prp.capabilities.v1",
    sessionReusePolicy: "reuse_per_issue",
    driver: { kind: "phase4b-demo", version: "1" },
    steer: capabilities.steering,
    interrupt: capabilities.interruption,
    resume: capabilities.resume,
    runtimeRequests: capabilities.runtimeRequestResolution ?? false,
    structuredResult: capabilities.structuredResult,
    typedEvents: capabilities.typedEvents,
    goals: capabilities.goals ?? false,
    threadLineage: capabilities.threadLineage ?? false,
    ...(capabilities.unsupported?.length ? { unsupported: capabilities.unsupported } : {}),
  };
}

function pathParts(request: IncomingMessage): string[] {
  const url = new URL(request.url ?? "/", "http://phase4b.invalid");
  return url.pathname.split("/").filter(Boolean);
}

function errorStatus(error: unknown): number {
  const code = record(error).code;
  if (code === "stale_turn" || code === "already_terminal") return 409;
  return 400;
}

export class Phase4bDemoServer {
  readonly #options: Required<Pick<Phase4bDemoServerOptions, "host" | "port">> &
    Omit<Phase4bDemoServerOptions, "host" | "port">;
  readonly #entries = new Map<string, DemoEntry>();
  #server: Server | null = null;

  constructor(options: Phase4bDemoServerOptions) {
    this.#options = {
      ...options,
      host: options.host ?? "127.0.0.1",
      port: options.port ?? 0,
    };
  }

  async start(): Promise<{ host: string; port: number; url: string }> {
    if (this.#server !== null) throw new Error("Phase 4b demo server is already started");
    this.#server = createServer((request, response) => {
      void this.#handle(request, response).catch((error) => {
        if (!response.headersSent) {
          json(response, errorStatus(error), {
            error: record(error).code ?? "invalid_request",
            message: redactCodexDiagnostic(String(error)),
          });
        } else {
          response.end();
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      this.#server!.once("error", reject);
      this.#server!.listen(this.#options.port, this.#options.host, () => resolve());
    });
    const address = this.#server.address();
    if (address === null || typeof address === "string") {
      throw new Error("Phase 4b demo server did not bind a TCP address");
    }
    return {
      host: this.#options.host,
      port: address.port,
      url: `http://${this.#options.host}:${address.port}`,
    };
  }

  async close(): Promise<void> {
    const entries = [...this.#entries.values()];
    this.#entries.clear();
    await Promise.all(entries.map(async (entry) => {
      for (const subscriber of entry.subscribers) subscriber.end();
      await entry.session.close({ reason: "demo_server_closed" });
      await entry.consumeTask.catch(() => undefined);
    }));
    if (this.#server === null) return;
    const server = this.#server;
    this.#server = null;
    await new Promise<void>((resolve, reject) => server.close((error) => {
      if (error) reject(error);
      else resolve();
    }));
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const parts = pathParts(request);
    if (request.method === "GET" && parts.join("/") === "api/phase4b/health") {
      json(response, 200, {
        status: "ok",
        boundary: "package-local-mock-core",
        providerAuthentication: "server-side",
        credentialsExposed: false,
      });
      return;
    }
    if (request.method === "POST" && parts.join("/") === "api/phase4b/sessions") {
      const body = await readJson(request) as BrowserCreateBody;
      const objective = typeof body.objective === "string" && body.objective.trim().length > 0
        ? body.objective.trim()
        : "Complete the Phase 4b demo task safely.";
      const message = typeof body.message === "string" ? body.message : objective;
      const entry = await this.#create(objective, message);
      json(response, 201, await this.#publicState(entry));
      return;
    }
    if (parts.length < 4 || parts[0] !== "api" || parts[1] !== "phase4b" || parts[2] !== "sessions") {
      json(response, 404, { error: "not_found" });
      return;
    }
    const entry = this.#entries.get(parts[3]!);
    if (entry === undefined) {
      json(response, 404, { error: "session_not_found" });
      return;
    }
    const action = parts[4];
    if (request.method === "GET" && action === undefined) {
      json(response, 200, await this.#publicState(entry));
      return;
    }
    if (request.method === "GET" && action === "events") {
      const url = new URL(request.url ?? "/", "http://phase4b.invalid");
      const after = Math.max(0, Number.parseInt(url.searchParams.get("after") ?? "0", 10) || 0);
      json(response, 200, {
        events: entry.events.slice(after),
        cursor: entry.events.length,
        replay: after === 0,
      });
      return;
    }
    if (request.method === "GET" && action === "stream") {
      const url = new URL(request.url ?? "/", "http://phase4b.invalid");
      const after = Math.max(0, Number.parseInt(url.searchParams.get("after") ?? "0", 10) || 0);
      response.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store",
        connection: "keep-alive",
      });
      for (const event of entry.events.slice(after)) {
        response.write(`data: ${JSON.stringify(browserSafe(event))}\n\n`);
      }
      entry.subscribers.add(response);
      request.once("close", () => entry.subscribers.delete(response));
      return;
    }
    if (request.method !== "POST") {
      json(response, 405, { error: "method_not_allowed" });
      return;
    }
    const body = await readJson(request);
    if (action === "steer") {
      await entry.session.steer?.({
        turnId: String(body.turnId ?? ""),
        message: { role: "user", text: String(body.text ?? "") },
      });
    } else if (action === "interrupt") {
      await entry.session.interrupt?.({
        ...(typeof body.turnId === "string" ? { turnId: body.turnId } : {}),
        ...(typeof body.reason === "string" ? { reason: body.reason } : {}),
      });
    } else if (action === "requests" && parts[5] && parts[6] === "resolve") {
      await entry.session.resolveRuntimeRequest?.({
        requestId: parts[5],
        turnId: String(body.turnId ?? ""),
        resolution: record(body.resolution) as HarnessRuntimeRequestResolution,
      });
    } else if (action === "goal" && parts[5]) {
      await entry.session.goal?.(goalOperation(parts[5], body));
    } else if (action === "reconnect") {
      await this.#reconnect(entry);
    } else {
      json(response, 404, { error: "action_not_found" });
      return;
    }
    json(response, 200, await this.#publicState(entry));
  }

  async #create(objective: string, message: string): Promise<DemoEntry> {
    const envelope = createPhase4TaskEnvelope({
      objective,
      contractRevision: "phase4b-demo-v1",
      criteria: [{ id: "objective", requirement: objective }],
    });
    const driver = this.#options.driverFactory(envelope);
    const id = randomUUID();
    const runId = `phase4b-run-${id}`;
    const normalizedSessionId = `phase4b-session-${id}`;
    const session = await driver.openSession({
      runId,
      normalizedSessionId,
      workingDirectory: this.#options.workingDirectory,
    });
    const descriptor = await driver.descriptor();
    const entry: DemoEntry = {
      id,
      runId,
      normalizedSessionId,
      envelope,
      driver,
      session,
      capabilities: descriptor.capabilities,
      events: [],
      subscribers: new Set(),
      consumeTask: Promise.resolve(),
    };
    this.#entries.set(id, entry);
    entry.consumeTask = this.#consume(entry, session);
    await session.startTurn({ message: { role: "user", text: message } });
    await new Promise<void>((resolve) => setImmediate(resolve));
    return entry;
  }

  async #consume(entry: DemoEntry, session: HarnessSession): Promise<void> {
    for await (const rawEvent of session.events()) {
      const event = browserSafe(rawEvent) as PrpEvent;
      const validation = validatePrpEvent(event);
      if (!validation.ok) continue;
      if (entry.events.length >= MAX_BROWSER_EVENTS) entry.events.shift();
      entry.events.push(event);
      const serialized = `data: ${JSON.stringify(event)}\n\n`;
      for (const subscriber of entry.subscribers) subscriber.write(serialized);
    }
  }

  async #reconnect(entry: DemoEntry): Promise<void> {
    const snapshot = await entry.session.snapshot();
    await entry.session.close({ reason: "browser_reconnect" });
    await entry.consumeTask.catch(() => undefined);
    const recovery = await entry.driver.recoverSession?.(snapshot);
    if (!recovery?.recovered || recovery.session === undefined) {
      throw new Error(`session resume failed: ${recovery?.reason ?? "driver cannot resume"}`);
    }
    entry.session = recovery.session;
    entry.consumeTask = this.#consume(entry, recovery.session);
  }

  async #publicState(entry: DemoEntry): Promise<Record<string, unknown>> {
    const driverSession = entry.session.ids();
    const metadata = {
      fixtureName: "phase4b-demo",
      identity: {
        schema: "paperclip.prp.identity.v1" as const,
        companyId: "package-local-demo",
        issueId: "phase4b-demo",
        runId: entry.runId,
        environmentLeaseId: "package-local",
        runnerInstanceId: "phase4b-demo-server",
        normalizedSessionId: entry.normalizedSessionId,
        driverSessionId: driverSession.driverSessionId,
        ...(driverSession.providerSessionId
          ? { providerSessionId: driverSession.providerSessionId }
          : {}),
      },
      capabilities: prpCapabilities(entry.capabilities),
    };
    const snapshot = entry.events.reduce(
      applyPrpEvent,
      createSessionSnapshotFromMetadata(metadata),
    );
    const harnessSnapshot = await entry.session.snapshot();
    return {
      sessionId: entry.id,
      runId: entry.runId,
      normalizedSessionId: entry.normalizedSessionId,
      providerAuthentication: "server-side",
      credentialsExposed: false,
      capabilities: entry.capabilities,
      driverSession,
      activeTurnId: harnessSnapshot.activeTurnId ?? snapshot.activeTurnId,
      pendingRequests: entry.session.pendingRuntimeRequests?.() ?? [],
      goal: harnessSnapshot.goal ?? null,
      lineage: entry.session.lineage?.() ?? [],
      cursor: entry.events.length,
      snapshot,
    };
  }
}

function goalOperation(action: string, body: Record<string, unknown>): HarnessGoalOperation {
  if (action === "get" || action === "pause" || action === "resume" || action === "clear") {
    return { action };
  }
  if (action === "set" && typeof body.objective === "string" && body.objective.trim().length > 0) {
    return {
      action,
      objective: body.objective.trim(),
      ...(typeof body.tokenBudget === "number" ? { tokenBudget: body.tokenBudget } : {}),
    };
  }
  throw new Error(`unsupported goal operation ${action}`);
}
