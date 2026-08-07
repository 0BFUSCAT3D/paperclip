import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import type { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";

import {
  PHASE3_FAULTS,
  type Phase3CommittedEvent,
  type Phase3CoreCommand,
  type Phase3Diagnostics,
  type Phase3Fault,
  type Phase3Identity,
  type Phase3RunnerState,
  type Phase3RunTrace,
} from "../contracts/phase3.js";

const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
const executableSuffix = process.platform === "win32" ? ".exe" : "";
const runnerBinary = resolve(
  packageRoot,
  `runner/target/debug/paperclip-runnerd${executableSuffix}`,
);
const fakeHarnessBinary = resolve(
  packageRoot,
  `runner/target/debug/fake-harness${executableSuffix}`,
);
const fakeHarnessScript = resolve(
  packageRoot,
  "protocol/fixtures/phase-02/scripts/happy-path.json",
);
const protocol = "paperclip.runner";
const protocolVersion = 1;
const websocketGuid = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const coreStateSchema = "paperclip.runner.phase3.mock-core-state.v1";
const maxFrameBytes = 1024 * 1024;

interface BootstrapTicketRecord {
  digest: string;
  runnerInstanceId: string;
  expiresAt: string;
  usedAt: string | null;
}

interface ConnectionLeaseRecord {
  digest: string;
  leaseId: string;
  runnerInstanceId: string;
  expiresAt: string;
  revokedAt: string | null;
}

interface StoredCoreState {
  schema: typeof coreStateSchema;
  identity: Phase3Identity;
  tickets: Record<string, BootstrapTicketRecord>;
  leases: Record<string, ConnectionLeaseRecord>;
  commands: Phase3CoreCommand[];
  committedEvents: Phase3CommittedEvent[];
  ackedSourceSeq: number;
  connectionCount: number;
  commandDeliveryCounts: Record<string, number>;
  replayDeliveries: number;
  duplicateCommandResults: number;
  freshBootstraps: number;
  malformedFrames: number;
  lastLeaseId: string | null;
  lastLeaseExpiresAt: string | null;
}

type Authorization =
  | {
      kind: "bootstrap";
      digest: string;
      rawToken: string;
      ticket: BootstrapTicketRecord;
    }
  | {
      kind: "lease";
      digest: string;
      rawToken: string;
      lease: ConnectionLeaseRecord;
    };

interface MockCoreOptions {
  stateDirectory: string;
  identity: Phase3Identity;
  fault: Phase3Fault;
  expectedRunnerVersion?: string;
  expectedRunnerDigest?: string;
}

interface RunnerProcessResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

interface RunnerProcessHandle {
  child: ChildProcessWithoutNullStreams;
  completion: Promise<RunnerProcessResult>;
}

function tokenDigest(token: string): string {
  return `sha256:${createHash("sha256").update(token).digest("hex")}`;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function safeDate(offsetMs: number): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

function initialCoreState(identity: Phase3Identity): StoredCoreState {
  return {
    schema: coreStateSchema,
    identity,
    tickets: {},
    leases: {},
    commands: [],
    committedEvents: [],
    ackedSourceSeq: 0,
    connectionCount: 0,
    commandDeliveryCounts: {},
    replayDeliveries: 0,
    duplicateCommandResults: 0,
    freshBootstraps: 0,
    malformedFrames: 0,
    lastLeaseId: null,
    lastLeaseExpiresAt: null,
  };
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function verifyPrivateDirectory(path: string): void {
  const metadata = lstatSync(path);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error(`Private state directory is not a real directory: ${path}`);
  }
  if (process.platform !== "win32") {
    if ((metadata.mode & 0o777) !== 0o700) {
      throw new Error(`Private state directory does not use mode 0700: ${path}`);
    }
    if (process.geteuid !== undefined && metadata.uid !== process.geteuid()) {
      throw new Error(`Private state directory is not owned by the daemon user: ${path}`);
    }
  }
}

function verifyPrivateRegularFile(file: Stats, path: string): void {
  if (!file.isFile()) {
    throw new Error(`Private state path is not a regular file: ${path}`);
  }
  if (process.platform !== "win32") {
    if ((file.mode & 0o777) !== 0o600) {
      throw new Error(`Private state file does not use mode 0600: ${path}`);
    }
    if (process.geteuid !== undefined && file.uid !== process.geteuid()) {
      throw new Error(`Private state file is not owned by the daemon user: ${path}`);
    }
  }
}

function readPrivateFile(path: string): string | null {
  let descriptor: number;
  try {
    descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return null;
    throw error;
  }
  try {
    verifyPrivateRegularFile(fstatSync(descriptor), path);
    return readFileSync(descriptor, "utf8");
  } finally {
    closeSync(descriptor);
  }
}

function syncParentDirectory(path: string): void {
  if (process.platform === "win32") return;
  const descriptor = openSync(
    dirname(path),
    constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function atomicPrivateWrite(path: string, contents: string): void {
  const temporary = resolve(dirname(path), `.${path.split(/[\\/]/).at(-1)}.${randomUUID()}.tmp`);
  let descriptor: number | null = null;
  let created = false;
  try {
    descriptor = openSync(
      temporary,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    created = true;
    if (process.platform !== "win32") fchmodSync(descriptor, 0o600);
    verifyPrivateRegularFile(fstatSync(descriptor), temporary);
    writeFileSync(descriptor, contents, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    renameSync(temporary, path);
    created = false;
    syncParentDirectory(path);
  } finally {
    if (descriptor !== null) closeSync(descriptor);
    if (created) {
      try {
        unlinkSync(temporary);
      } catch (error) {
        if (!isNodeError(error, "ENOENT")) throw error;
      }
    }
  }
}

class DurableCoreStore {
  readonly path: string;
  #state: StoredCoreState;

  constructor(directory: string, identity: Phase3Identity) {
    try {
      const metadata = lstatSync(directory);
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
        throw new Error(`Private state directory is not a real directory: ${directory}`);
      }
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) throw error;
      mkdirSync(directory, { recursive: true, mode: 0o700 });
    }
    if (process.platform !== "win32") chmodSync(directory, 0o700);
    verifyPrivateDirectory(directory);
    this.path = resolve(directory, "mock-core-state.json");
    const stored = readPrivateFile(this.path);
    if (stored !== null) {
      this.#state = JSON.parse(stored) as StoredCoreState;
      if (
        this.#state.schema !== coreStateSchema ||
        canonicalJson(this.#state.identity) !== canonicalJson(identity)
      ) {
        throw new Error("Mock core state does not match the requested Phase 3 identity.");
      }
    } else {
      this.#state = initialCoreState(identity);
      this.save();
    }
  }

  get state(): StoredCoreState {
    return this.#state;
  }

  save(): void {
    atomicPrivateWrite(this.path, `${JSON.stringify(this.#state, null, 2)}\n`);
  }
}

class MockWebSocketConnection {
  readonly socket: Duplex;
  readonly authorization: Authorization;
  lease: ConnectionLeaseRecord | null = null;
  #buffer = Buffer.alloc(0);
  #closed = false;
  #onText: (text: string) => void;
  #onClose: () => void;

  constructor(
    socket: Duplex,
    authorization: Authorization,
    onText: (text: string) => void,
    onClose: () => void,
  ) {
    this.socket = socket;
    this.authorization = authorization;
    this.#onText = onText;
    this.#onClose = onClose;
    socket.on("data", (chunk: Buffer) => this.#consume(chunk));
    socket.on("close", () => {
      if (!this.#closed) {
        this.#closed = true;
        this.#onClose();
      }
    });
    socket.on("error", () => this.close());
  }

  sendJson(value: unknown): void {
    this.sendText(JSON.stringify(value));
  }

  sendText(text: string): void {
    if (this.#closed) {
      return;
    }
    const payload = Buffer.from(text);
    const header: number[] = [0x81];
    if (payload.length <= 125) {
      header.push(payload.length);
    } else if (payload.length <= 0xffff) {
      header.push(126, (payload.length >>> 8) & 0xff, payload.length & 0xff);
    } else {
      const length = BigInt(payload.length);
      header.push(127);
      for (let shift = 56n; shift >= 0n; shift -= 8n) {
        header.push(Number((length >> shift) & 0xffn));
      }
    }
    this.socket.write(Buffer.concat([Buffer.from(header), payload]));
  }

  close(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.socket.destroy();
    this.#onClose();
  }

  #consume(chunk: Buffer): void {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    while (this.#buffer.length >= 2) {
      const first = this.#buffer[0]!;
      const second = this.#buffer[1]!;
      const opcode = first & 0x0f;
      const masked = (second & 0x80) !== 0;
      let length = second & 0x7f;
      let cursor = 2;
      if (length === 126) {
        if (this.#buffer.length < 4) return;
        length = this.#buffer.readUInt16BE(2);
        cursor = 4;
      } else if (length === 127) {
        if (this.#buffer.length < 10) return;
        const extended = this.#buffer.readBigUInt64BE(2);
        if (extended > BigInt(maxFrameBytes)) {
          this.close();
          return;
        }
        length = Number(extended);
        cursor = 10;
      }
      if (length > maxFrameBytes || !masked) {
        this.close();
        return;
      }
      if (this.#buffer.length < cursor + 4 + length) return;
      const mask = this.#buffer.subarray(cursor, cursor + 4);
      cursor += 4;
      const payload = Buffer.from(this.#buffer.subarray(cursor, cursor + length));
      this.#buffer = this.#buffer.subarray(cursor + length);
      for (let index = 0; index < payload.length; index += 1) {
        payload[index] = payload[index]! ^ mask[index % 4]!;
      }
      if (opcode === 0x1) {
        this.#onText(payload.toString("utf8"));
      } else if (opcode === 0x8) {
        this.close();
        return;
      } else if (opcode === 0x9) {
        this.#sendControl(0x0a, payload);
      } else if (opcode !== 0x0a) {
        this.close();
        return;
      }
    }
  }

  #sendControl(opcode: number, payload: Buffer): void {
    if (payload.length > 125 || this.#closed) return;
    this.socket.write(Buffer.concat([Buffer.from([0x80 | opcode, payload.length]), payload]));
  }
}

export class Phase3MockCore {
  readonly fault: Phase3Fault;
  readonly identity: Phase3Identity;
  readonly store: DurableCoreStore;
  #expectedRunnerVersion: string;
  #expectedRunnerDigest: string;
  #server: Server | null = null;
  #connections = new Set<MockWebSocketConnection>();
  #port: number | null = null;
  #faultTriggered = false;
  #replayCursorOverrideOnce = false;
  #faultTriggerResolve!: () => void;
  #faultTrigger = new Promise<void>((resolveFault) => {
    this.#faultTriggerResolve = resolveFault;
  });

  constructor(options: MockCoreOptions) {
    if (!PHASE3_FAULTS.includes(options.fault)) {
      throw new Error(`Unsupported Phase 3 fault: ${options.fault}`);
    }
    this.fault = options.fault;
    this.identity = options.identity;
    this.store = new DurableCoreStore(options.stateDirectory, options.identity);
    this.#expectedRunnerVersion = options.expectedRunnerVersion ?? "0.3.0";
    this.#expectedRunnerDigest =
      options.expectedRunnerDigest ?? "sha256:phase3-approved";
  }

  get connectUrl(): string {
    if (this.#port === null) {
      throw new Error("Phase 3 mock core is not listening.");
    }
    return `ws://127.0.0.1:${this.#port}/phase3/connect`;
  }

  async start(port = 0): Promise<void> {
    if (this.#server !== null) {
      throw new Error("Phase 3 mock core is already running.");
    }
    const server = createServer((_request, response) => {
      response.writeHead(404).end();
    });
    this.#server = server;
    server.on("upgrade", (request, socket) => this.#upgrade(request, socket));
    await new Promise<void>((resolveListen, rejectListen) => {
      server.once("error", rejectListen);
      server.listen(port, "127.0.0.1", () => {
        server.off("error", rejectListen);
        resolveListen();
      });
    });
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("Phase 3 mock core did not bind a TCP port.");
    }
    this.#port = address.port;
  }

  async stop(): Promise<void> {
    for (const connection of this.#connections) {
      connection.close();
    }
    this.#connections.clear();
    const server = this.#server;
    this.#server = null;
    this.#port = null;
    if (server !== null) {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    }
  }

  issueBootstrapTicket(ttlMs = 5_000): string {
    const ticket = `bootstrap_${randomUUID()}`;
    const digest = tokenDigest(ticket);
    this.store.state.tickets[digest] = {
      digest,
      runnerInstanceId: this.identity.runnerInstanceId,
      expiresAt: safeDate(ttlMs),
      usedAt: null,
    };
    this.store.state.freshBootstraps += 1;
    this.store.save();
    return ticket;
  }

  queueCommand(
    type: string,
    payload: Record<string, unknown> = {},
    commandId?: string,
  ): Phase3CoreCommand {
    const controllerSeq = this.store.state.commands.length + 1;
    const command: Phase3CoreCommand = {
      schema: "paperclip.prp.command.v1",
      commandId: commandId ?? `command_phase3_${controllerSeq.toString().padStart(3, "0")}`,
      controllerSeq,
      type,
      issuedAt: `2026-08-07T23:30:${controllerSeq.toString().padStart(2, "0")}.000Z`,
      payload,
      status: "pending",
      result: null,
    };
    this.store.state.commands.push(command);
    this.store.save();
    return command;
  }

  waitForFaultTrigger(): Promise<void> {
    return this.#faultTrigger;
  }

  #triggerFault(): void {
    if (!this.#faultTriggered) {
      this.#faultTriggered = true;
      this.#faultTriggerResolve();
    }
  }

  #upgrade(request: IncomingMessage, socket: Duplex): void {
    if (request.url !== "/phase3/connect") {
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    const authorization = this.#authorize(request.headers.authorization);
    if (authorization === null) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    const websocketKey = request.headers["sec-websocket-key"];
    if (typeof websocketKey !== "string") {
      socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    const accept = createHash("sha1")
      .update(`${websocketKey}${websocketGuid}`)
      .digest("base64");
    socket.write(
      [
        "HTTP/1.1 101 Switching Protocols",
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Accept: ${accept}`,
        "\r\n",
      ].join("\r\n"),
    );
    const connection = new MockWebSocketConnection(
      socket,
      authorization,
      (text) => this.#handleText(connection, text),
      () => this.#connections.delete(connection),
    );
    this.#connections.add(connection);
  }

  #authorize(header: string | undefined): Authorization | null {
    const rawToken = header?.match(/^Bearer (.+)$/i)?.[1];
    if (rawToken === undefined) return null;
    const digest = tokenDigest(rawToken);
    const ticket = this.store.state.tickets[digest];
    if (ticket !== undefined && ticket.usedAt === null && Date.parse(ticket.expiresAt) > Date.now()) {
      ticket.usedAt = new Date().toISOString();
      this.store.save();
      return { kind: "bootstrap", digest, rawToken, ticket };
    }
    const lease = this.store.state.leases[digest];
    if (
      lease !== undefined &&
      lease.revokedAt === null &&
      Date.parse(lease.expiresAt) > Date.now()
    ) {
      return { kind: "lease", digest, rawToken, lease };
    }
    return null;
  }

  #handleText(connection: MockWebSocketConnection, text: string): void {
    let envelope: Record<string, unknown>;
    try {
      envelope = JSON.parse(text) as Record<string, unknown>;
    } catch {
      this.store.state.malformedFrames += 1;
      this.store.save();
      connection.close();
      return;
    }
    if (envelope.protocol !== protocol || envelope.version !== protocolVersion) {
      connection.close();
      return;
    }
    const kind = envelope.kind;
    if (kind === "hello") {
      this.#hello(connection, envelope);
      return;
    }
    if (connection.lease === null) {
      connection.close();
      return;
    }
    if (kind === "event") {
      this.#event(connection, envelope);
      return;
    }
    if (kind === "command_result") {
      this.#commandResult(connection, envelope);
      return;
    }
    if (kind !== "pong") {
      connection.close();
    }
  }

  #hello(connection: MockWebSocketConnection, envelope: Record<string, unknown>): void {
    const payload = envelope.payload as Record<string, unknown> | undefined;
    const authorizedRunnerInstanceId =
      connection.authorization.kind === "bootstrap"
        ? connection.authorization.ticket.runnerInstanceId
        : connection.authorization.lease.runnerInstanceId;
    if (
      envelope.runnerInstanceId !== this.identity.runnerInstanceId ||
      envelope.runnerInstanceId !== authorizedRunnerInstanceId ||
      payload?.environmentLeaseId !== this.identity.environmentLeaseId ||
      payload?.runnerVersion !== this.#expectedRunnerVersion ||
      payload?.runnerDigest !== this.#expectedRunnerDigest ||
      payload?.protocolMin !== 1 ||
      payload.protocolMax !== 1
    ) {
      connection.close();
      return;
    }

    let leaseToken = connection.authorization.rawToken;
    let lease: ConnectionLeaseRecord;
    if (connection.authorization.kind === "bootstrap") {
      leaseToken = `lease_${randomUUID()}`;
      const digest = tokenDigest(leaseToken);
      lease = {
        digest,
        leaseId: `connection_lease_${randomUUID()}`,
        runnerInstanceId: this.identity.runnerInstanceId,
        expiresAt: safeDate(this.fault === "lease-expiry" && !this.#faultTriggered ? 50 : 30_000),
        revokedAt: null,
      };
      this.store.state.leases[digest] = lease;
    } else {
      lease = connection.authorization.lease;
    }
    connection.lease = lease;
    this.store.state.connectionCount += 1;
    this.store.state.lastLeaseId = lease.leaseId;
    this.store.state.lastLeaseExpiresAt = lease.expiresAt;

    const reportedAck = this.#replayCursorOverrideOnce
      ? Math.max(0, this.store.state.ackedSourceSeq - 1)
      : this.store.state.ackedSourceSeq;
    this.#replayCursorOverrideOnce = false;
    const suppressPending =
      !this.#faultTriggered &&
      ["socket-drop", "malformed-input", "lease-expiry"].includes(this.fault);
    const pending = suppressPending ? [] : this.#nextPendingCommand();
    for (const command of pending) {
      this.store.state.commandDeliveryCounts[command.commandId] =
        (this.store.state.commandDeliveryCounts[command.commandId] ?? 0) + 1;
    }
    this.store.save();
    connection.sendJson({
      protocol,
      version: protocolVersion,
      envelopeId: `welcome_${this.store.state.connectionCount}`,
      kind: "welcome",
      runnerInstanceId: this.identity.runnerInstanceId,
      connectionId: `connection_${this.store.state.connectionCount}`,
      sentAt: new Date().toISOString(),
      payload: {
        selectedVersion: 1,
        heartbeatIntervalMs: 250,
        connectionLeaseId: lease.leaseId,
        connectionLeaseToken: leaseToken,
        connectionLeaseExpiresAt: lease.expiresAt,
        maxFrameBytes,
        maxBatchEvents: 100,
        ackedSourceSeq: reportedAck,
        pendingCommands: pending.map(this.#wireCommand),
      },
    });

    if (suppressPending) {
      this.#triggerFault();
      if (this.fault === "malformed-input") {
        this.store.state.malformedFrames += 1;
        this.store.save();
        connection.sendText('{"kind":');
      }
      if (this.fault === "lease-expiry") {
        lease.expiresAt = safeDate(-1);
        this.store.state.lastLeaseExpiresAt = lease.expiresAt;
        this.store.save();
      }
      setTimeout(() => connection.close(), 5);
    }
  }

  #wireCommand(command: Phase3CoreCommand): Omit<Phase3CoreCommand, "status" | "result"> {
    const { status: _status, result: _result, ...wire } = command;
    return wire;
  }

  #nextPendingCommand(): Phase3CoreCommand[] {
    const command = this.store.state.commands.find((candidate) => candidate.status === "pending");
    return command === undefined ? [] : [command];
  }

  #sendNextCommand(connection: MockWebSocketConnection): void {
    const [command] = this.#nextPendingCommand();
    if (command === undefined) return;
    this.store.state.commandDeliveryCounts[command.commandId] =
      (this.store.state.commandDeliveryCounts[command.commandId] ?? 0) + 1;
    this.store.save();
    connection.sendJson({
      protocol,
      version: protocolVersion,
      envelopeId: `command_${command.commandId}_${this.store.state.commandDeliveryCounts[command.commandId]}`,
      kind: "command",
      runnerInstanceId: this.identity.runnerInstanceId,
      runId: this.identity.runId,
      normalizedSessionId: this.identity.normalizedSessionId,
      sentAt: new Date().toISOString(),
      payload: this.#wireCommand(command),
    });
  }

  #commandResult(
    connection: MockWebSocketConnection,
    envelope: Record<string, unknown>,
  ): void {
    const result = envelope.payload as Record<string, unknown> | undefined;
    const commandId = result?.commandId;
    if (result === undefined || typeof commandId !== "string") {
      connection.close();
      return;
    }
    const command = this.store.state.commands.find((candidate) => candidate.commandId === commandId);
    if (command === undefined) {
      connection.close();
      return;
    }
    if (this.fault === "duplicate-command" && !this.#faultTriggered) {
      this.#triggerFault();
      connection.close();
      return;
    }
    if (command.status !== "pending") {
      this.store.state.duplicateCommandResults += 1;
    }
    const status = result.status;
    command.status =
      status === "completed" || status === "failed" || status === "rejected"
        ? status
        : "failed";
    command.result = structuredClone(result);
    this.store.save();
    this.#sendNextCommand(connection);
  }

  #event(connection: MockWebSocketConnection, envelope: Record<string, unknown>): void {
    const event = envelope.payload as Record<string, unknown> | undefined;
    const sourceSeq = event?.sourceSeq;
    const sourceEventId = event?.sourceEventId;
    const eventType = event?.eventType;
    const priority = event?.priority;
    if (
      typeof sourceSeq !== "number" ||
      typeof sourceEventId !== "string" ||
      typeof eventType !== "string" ||
      (priority !== 0 && priority !== 1 && priority !== 2) ||
      event?.sourceInstanceId !== this.identity.runnerInstanceId ||
      event.runId !== this.identity.runId ||
      event.normalizedSessionId !== this.identity.normalizedSessionId ||
      event.turnId !== this.identity.turnId
    ) {
      connection.close();
      return;
    }
    const existing = this.store.state.committedEvents.find(
      (candidate) => candidate.sourceEventId === sourceEventId,
    );
    if (existing !== undefined) {
      if (canonicalJson(existing.envelope) !== canonicalJson(envelope)) {
        connection.close();
        return;
      }
      existing.deliveryCount += 1;
      this.store.state.replayDeliveries += 1;
    } else {
      if (sourceSeq !== this.store.state.ackedSourceSeq + 1) {
        connection.close();
        return;
      }
      this.store.state.committedEvents.push({
        sourceSeq,
        sourceEventId,
        eventType,
        priority,
        envelope: structuredClone(envelope),
        deliveryCount: 1,
        logicalEffectCount: 1,
      });
      this.store.state.ackedSourceSeq = sourceSeq;
    }
    this.store.save();

    if (this.fault === "revoke" && eventType === "run.terminal" && !this.#faultTriggered) {
      if (connection.lease !== null) {
        connection.lease.revokedAt = new Date().toISOString();
      }
      this.queueCommand(
        "turn.start",
        { turnId: this.identity.turnId, text: "must be rejected after revoke" },
        "command_after_revoke",
      );
      this.#triggerFault();
      this.store.save();
      // Revoke before ACK so the runner must flush a genuinely non-empty durable outbox.
      connection.sendJson({
        protocol,
        version: protocolVersion,
        envelopeId: "revoke_phase3",
        kind: "revoke",
        runnerInstanceId: this.identity.runnerInstanceId,
        sentAt: new Date().toISOString(),
        payload: { reason: "fault_injection_revoke", drain: true },
      });
      this.#sendNextCommand(connection);
      return;
    }

    const shouldLoseAck =
      !this.#faultTriggered && (this.fault === "lost-ack" || this.fault === "runner-restart");
    if (shouldLoseAck) {
      this.#replayCursorOverrideOnce = true;
      this.#triggerFault();
      if (this.fault === "lost-ack") {
        connection.close();
      }
      return;
    }

    connection.sendJson({
      protocol,
      version: protocolVersion,
      envelopeId: `ack_${this.store.state.ackedSourceSeq}`,
      kind: "ack",
      runnerInstanceId: this.identity.runnerInstanceId,
      sentAt: new Date().toISOString(),
      payload: { ackedSourceSeq: this.store.state.ackedSourceSeq },
    });
  }
}

function runnerEnvironment(ticket: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    PAPERCLIP_RUNNER_BOOTSTRAP_TICKET: ticket,
  };
  for (const key of ["PATH", "SystemRoot", "WINDIR", "PATHEXT"]) {
    const value = process.env[key];
    if (value !== undefined) environment[key] = value;
  }
  return environment;
}

function spawnRunner(options: {
  connectUrl: string;
  stateDirectory: string;
  identity: Phase3Identity;
  ticket: string;
  maxOutboxBytes: number;
  p0ReserveBytes: number;
}): RunnerProcessHandle {
  const args = [
    "--connect-url",
    options.connectUrl,
    "--state-dir",
    options.stateDirectory,
    "--runner-id",
    options.identity.runnerInstanceId,
    "--environment-lease-id",
    options.identity.environmentLeaseId,
    "--run-id",
    options.identity.runId,
    "--session-id",
    options.identity.normalizedSessionId,
    "--turn-id",
    options.identity.turnId,
    "--item-id",
    options.identity.itemId,
    "--runner-version",
    "0.3.0",
    "--runner-digest",
    "sha256:phase3-approved",
    "--fake-harness",
    fakeHarnessBinary,
    "--fake-harness-script",
    fakeHarnessScript,
    "--max-outbox-bytes",
    String(options.maxOutboxBytes),
    "--p0-reserve-bytes",
    String(options.p0ReserveBytes),
    "--reconnect-delay-ms",
    "20",
    "--max-runtime-ms",
    "10000",
  ];
  const child = spawn(runnerBinary, args, {
    cwd: packageRoot,
    env: runnerEnvironment(options.ticket),
    stdio: "pipe",
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    stdout = `${stdout}${chunk}`.slice(-16_384);
  });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    stderr = `${stderr}${chunk}`.slice(-16_384);
  });
  const completion = new Promise<RunnerProcessResult>((resolveCompletion, rejectCompletion) => {
    child.once("error", rejectCompletion);
    child.once("exit", (code, signal) => resolveCompletion({ code, signal, stdout, stderr }));
  });
  return { child, completion };
}

async function waitForProcess(
  handle: RunnerProcessHandle,
  timeoutMs = 15_000,
): Promise<RunnerProcessResult> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      handle.completion,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          handle.child.kill("SIGKILL");
          reject(new Error("Phase 3 runner timed out."));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function phase3Identity(): Phase3Identity {
  return {
    runnerInstanceId: "runner_phase3_stable",
    environmentLeaseId: "environment_lease_phase3_stable",
    runId: "run_phase3_stable",
    normalizedSessionId: "session_phase3_stable",
    turnId: "turn_phase3_stable",
    itemId: "item_phase3_stable",
  };
}

function queueScenario(core: Phase3MockCore, fault: Phase3Fault): void {
  core.queueCommand("run.prepare", { workspace: "phase-03-durable-fixture" });
  core.queueCommand("session.open", { reuse: "same_session" });
  if (fault === "harness-restart") {
    core.queueCommand("fault.harness_restart", {});
  }
  if (fault === "storage-pressure") {
    core.queueCommand("fault.storage_pressure", {});
  }
  if (fault === "drain") {
    core.queueCommand("runner.drain", {});
  }
  core.queueCommand("turn.start", {
    turnId: core.identity.turnId,
    text: "Prove Phase 3 durable recovery.",
  });
  if (fault !== "revoke") {
    core.queueCommand("runner.shutdown", {});
  }
}

function readRunnerState(stateDirectory: string): Phase3RunnerState {
  return JSON.parse(
    readFileSync(resolve(stateDirectory, "runner-state.json"), "utf8"),
  ) as Phase3RunnerState;
}

function assertContinuous(events: readonly Phase3CommittedEvent[]): boolean {
  return events
    .toSorted((left, right) => left.sourceSeq - right.sourceSeq)
    .every((event, index) => event.sourceSeq === index + 1);
}

function secretLeakCount(paths: readonly string[], secrets: readonly string[]): number {
  let leaks = 0;
  for (const path of paths) {
    const source = readFileSync(path, "utf8");
    for (const secret of secrets) {
      if (secret.length > 0 && source.includes(secret)) leaks += 1;
    }
  }
  return leaks;
}

function persistedCapabilityShape(path: string, fieldNames: readonly string[]): boolean {
  const source = readFileSync(path, "utf8");
  return fieldNames.some((fieldName) => source.includes(`\"${fieldName}\"`));
}

export interface RunPhase3RecoveryOptions {
  fault?: Phase3Fault;
  stateDirectory?: string;
  keepState?: boolean;
}

export async function runPhase3Recovery(
  options: RunPhase3RecoveryOptions = {},
): Promise<Phase3RunTrace> {
  const fault = options.fault ?? "lost-ack";
  const identity = phase3Identity();
  const scratchRoot =
    process.env.PAPERCLIP_RUN_SCRATCH_DIR ??
    process.env.PAPERCLIP_SCRATCH_DIR ??
    tmpdir();
  const root =
    options.stateDirectory ??
    mkdtempSync(resolve(scratchRoot, `paperclip-runner-phase3-${fault}-`));
  const runnerStateDirectory = resolve(root, "runner");
  const coreStateDirectory = resolve(root, "mock-core");
  mkdirSync(runnerStateDirectory, { recursive: true, mode: 0o700 });
  const core = new Phase3MockCore({
    stateDirectory: coreStateDirectory,
    identity,
    fault,
  });
  queueScenario(core, fault);
  await core.start();
  const tickets: string[] = [];
  let runnerRestarts = 0;
  const maxOutboxBytes = fault === "storage-pressure" ? 16 * 1024 : 64 * 1024;
  const p0ReserveBytes = fault === "storage-pressure" ? 8 * 1024 : 32 * 1024;

  const launch = (): RunnerProcessHandle => {
    const ticket = core.issueBootstrapTicket();
    tickets.push(ticket);
    return spawnRunner({
      connectUrl: core.connectUrl,
      stateDirectory: runnerStateDirectory,
      identity,
      ticket,
      maxOutboxBytes,
      p0ReserveBytes,
    });
  };

  let handle = launch();
  let result: RunnerProcessResult;
  try {
    if (fault === "runner-restart") {
      await core.waitForFaultTrigger();
      handle.child.kill("SIGKILL");
      await waitForProcess(handle);
      runnerRestarts += 1;
      handle = launch();
    } else if (fault === "lease-expiry") {
      const expired = await waitForProcess(handle);
      if (expired.code === 0) {
        throw new Error("Lease-expiry injection did not produce a recoverable restart boundary.");
      }
      runnerRestarts += 1;
      handle = launch();
    }
    result = await waitForProcess(handle);
    if (result.code !== 0) {
      throw new Error(
        `Phase 3 runner exited with code ${String(result.code)}: ${result.stderr.trim()}`,
      );
    }
  } finally {
    await core.stop();
  }

  const runnerState = readRunnerState(runnerStateDirectory);
  const coreState = core.store.state;
  const runnerStatePath = resolve(runnerStateDirectory, "runner-state.json");
  const leaks = secretLeakCount(
    [runnerStatePath, core.store.path],
    [...tickets, "must-not-persist"],
  );
  const bootstrapTicketPersisted = persistedCapabilityShape(
    runnerStatePath,
    ["bootstrapTicket", "bootstrap_ticket"],
  );
  const connectionLeaseTokenPersisted = persistedCapabilityShape(
    runnerStatePath,
    ["connectionLeaseToken", "connection_lease_token"],
  );
  const committedEvents = coreState.committedEvents.toSorted(
    (left, right) => left.sourceSeq - right.sourceSeq,
  );
  const p0Committed = committedEvents.filter((event) => event.priority === 0).length;
  const completedCommands = coreState.commands.filter(
    (command) => command.status === "completed",
  );
  const rejectedCommands = coreState.commands.filter(
    (command) => command.status === "rejected",
  );
  const logicalEffects = coreState.commands.reduce(
    (sum, command) =>
      sum +
      (typeof command.result?.logicalEffectCount === "number"
        ? command.result.logicalEffectCount
        : 0),
    0,
  );
  const duplicateDeliveries = Object.values(coreState.commandDeliveryCounts).reduce(
    (sum, count) => sum + Math.max(0, count - 1),
    0,
  );
  const outcome: Phase3Diagnostics["recovery"]["outcome"] =
    fault === "drain"
      ? "drained"
      : fault === "revoke"
        ? "revoked"
        : runnerState.unrecoverableOutcome === null
          ? "recovered"
          : "unrecoverable";
  const diagnostics: Phase3Diagnostics = {
    schema: "paperclip.runner.phase3.diagnostics.v1",
    fault,
    connection: {
      state: runnerState.lifecycle,
      connectionCount: coreState.connectionCount,
      reconnectCount: runnerState.reconnectCount,
      leaseId: coreState.lastLeaseId,
      leaseExpiresAt: coreState.lastLeaseExpiresAt,
    },
    identity,
    cursors: {
      runnerAckedSourceSeq: runnerState.ackedSourceSeq,
      runnerNextSourceSeq: runnerState.nextSourceSeq,
      coreAckedSourceSeq: coreState.ackedSourceSeq,
      highestCommittedSourceSeq: committedEvents.at(-1)?.sourceSeq ?? 0,
    },
    outbox: {
      events: runnerState.outbox.length,
      bytes: runnerState.outbox.reduce((sum, event) => sum + event.byteSize, 0),
      peakBytes: runnerState.peakOutboxBytes,
      maxBytes: maxOutboxBytes,
      backpressure: runnerState.backpressure,
      p0Committed,
      p0Lost: runnerState.ackedSourceSeq === coreState.ackedSourceSeq ? 0 : p0Committed,
    },
    commands: {
      issued: coreState.commands.length,
      completed: completedCommands.length,
      rejected: rejectedCommands.length,
      logicalEffects,
      duplicateDeliveries,
    },
    recovery: {
      replayDeliveries: coreState.replayDeliveries,
      runnerRestarts,
      harnessRestarts: Math.max(0, runnerState.harnessGeneration - 1),
      malformedFrames: coreState.malformedFrames,
      freshBootstraps: coreState.freshBootstraps,
      outcome,
      reason:
        runnerState.unrecoverableOutcome ??
        runnerState.recoverableFailure ??
        `${fault.replaceAll("-", "_")}_completed`,
    },
    security: {
      bootstrapTicketPersisted,
      connectionLeaseTokenPersisted,
      secretLeakCount: leaks,
    },
    committedEvents,
  };
  const acceptedWithTooManyEffects = coreState.commands.some((command) => {
    const effectCount = command.result?.logicalEffectCount;
    return command.status === "completed" && effectCount !== 1;
  });
  const trace: Phase3RunTrace = {
    schema: "paperclip.runner.phase3.trace.v1",
    diagnostics,
    runnerState,
    commands: structuredClone(coreState.commands),
    assertions: {
      stableIdentity:
        canonicalJson(identity) ===
        canonicalJson({
          runnerInstanceId: runnerState.runnerInstanceId,
          environmentLeaseId: runnerState.environmentLeaseId,
          runId: runnerState.runId,
          normalizedSessionId: runnerState.normalizedSessionId,
          turnId: runnerState.turnId,
          itemId: runnerState.itemId,
        }),
      sourceCursorContinuous:
        assertContinuous(committedEvents) &&
        runnerState.ackedSourceSeq === coreState.ackedSourceSeq,
      oneLogicalEffectPerAcceptedCommand: !acceptedWithTooManyEffects,
      noDuplicateLogicalEvents: committedEvents.every(
        (event) => event.logicalEffectCount === 1,
      ),
      p0Preserved: diagnostics.outbox.p0Lost === 0,
      boundedStorage:
        diagnostics.outbox.bytes <= maxOutboxBytes &&
        runnerState.peakOutboxBytes <= maxOutboxBytes,
      secretsRedacted:
        leaks === 0 &&
        !bootstrapTicketPersisted &&
        !connectionLeaseTokenPersisted,
    },
  };

  if (options.keepState !== true && options.stateDirectory === undefined) {
    rmSync(root, { recursive: true, force: true });
  }
  return trace;
}

export const phase3Internals = {
  runnerBinary,
  runnerEnvironment,
  tokenDigest,
  canonicalJson,
  phase3Identity,
};
