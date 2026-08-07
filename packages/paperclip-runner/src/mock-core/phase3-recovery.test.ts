import { spawn } from "node:child_process";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  Phase3MockCore,
  phase3Internals,
  runPhase3Recovery,
} from "./phase3-recovery.js";

async function upgradeSocket(url: string): Promise<Socket> {
  const parsed = new URL(url);
  return new Promise((resolveSocket, rejectSocket) => {
    const socket = connect(Number(parsed.port), parsed.hostname);
    let response = Buffer.alloc(0);
    const onError = (error: Error): void => rejectSocket(error);
    const onData = (chunk: Buffer): void => {
      response = Buffer.concat([response, chunk]);
      const boundary = response.indexOf("\r\n\r\n");
      if (boundary === -1) return;
      socket.off("error", onError);
      socket.off("data", onData);
      const status = Number(response.toString("utf8").match(/^HTTP\/1\.1 (\d{3})/)?.[1]);
      if (status !== 101) {
        socket.destroy();
        rejectSocket(new Error(`WebSocket upgrade returned ${String(status)}`));
        return;
      }
      resolveSocket(socket);
    };
    socket.once("error", onError);
    socket.once("connect", () => {
      socket.write(
        [
          `GET ${parsed.pathname} HTTP/1.1`,
          `Host: ${parsed.host}`,
          "Upgrade: websocket",
          "Connection: Upgrade",
          "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
          "Sec-WebSocket-Version: 13",
          "\r\n",
        ].join("\r\n"),
      );
    });
    socket.on("data", onData);
  });
}

async function receiveServerJson(socket: Socket): Promise<Record<string, unknown>> {
  return new Promise((resolveValue, rejectValue) => {
    let buffer = Buffer.alloc(0);
    const timer = setTimeout(() => rejectValue(new Error("Server frame timed out.")), 2_000);
    const onData = (chunk: Buffer): void => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length < 2) return;
      let length = buffer[1]! & 0x7f;
      let cursor = 2;
      if (length === 126) {
        if (buffer.length < 4) return;
        length = buffer.readUInt16BE(2);
        cursor = 4;
      } else if (length === 127) {
        if (buffer.length < 10) return;
        length = Number(buffer.readBigUInt64BE(2));
        cursor = 10;
      }
      if (buffer.length < cursor + length) return;
      clearTimeout(timer);
      socket.off("data", onData);
      resolveValue(
        JSON.parse(buffer.subarray(cursor, cursor + length).toString("utf8")) as Record<
          string,
          unknown
        >,
      );
    };
    socket.on("data", onData);
    socket.once("error", rejectValue);
  });
}

function sendMaskedJson(socket: Socket, value: unknown): void {
  const payload = Buffer.from(JSON.stringify(value));
  const mask = Buffer.from([0x11, 0x22, 0x33, 0x44]);
  const header: number[] = [0x81];
  if (payload.length <= 125) {
    header.push(0x80 | payload.length);
  } else {
    header.push(0x80 | 126, (payload.length >>> 8) & 0xff, payload.length & 0xff);
  }
  const masked = Buffer.from(payload);
  for (let index = 0; index < masked.length; index += 1) {
    masked[index] = masked[index]! ^ mask[index % mask.length]!;
  }
  socket.write(Buffer.concat([Buffer.from(header), mask, masked]));
}

async function expectSocketClosed(socket: Socket): Promise<void> {
  await new Promise<void>((resolveClose, rejectClose) => {
    const timer = setTimeout(() => rejectClose(new Error("WebSocket was not rejected.")), 2_000);
    socket.once("close", () => {
      clearTimeout(timer);
      resolveClose();
    });
  });
}

function authHello(
  identity: ReturnType<typeof phase3Internals.phase3Identity>,
  credentialId: string,
): Record<string, unknown> {
  return {
    protocol: "paperclip.runner",
    version: 1,
    kind: "auth_hello",
    payload: {
      credentialId,
      clientNonce: "client_nonce_auth_regression",
      protocolMin: 1,
      protocolMax: 1,
      runnerInstanceId: identity.runnerInstanceId,
      runnerVersion: "0.3.0",
      runnerDigest: "sha256:phase3-approved",
      environmentLeaseId: identity.environmentLeaseId,
      runId: identity.runId,
      normalizedSessionId: identity.normalizedSessionId,
      turnId: identity.turnId,
      itemId: identity.itemId,
    },
  };
}

async function runRunnerProcess(options: {
  connectUrl: string;
  stateDirectory: string;
  identity: ReturnType<typeof phase3Internals.phase3Identity>;
  ticket: string;
  maxRuntimeMs: number;
}): Promise<{ code: number | null; stderr: string }> {
  const child = spawn(
    phase3Internals.runnerBinary,
    [
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
      "--max-outbox-bytes",
      String(64 * 1024),
      "--p0-reserve-bytes",
      String(32 * 1024),
      "--reconnect-delay-ms",
      "10",
      "--max-runtime-ms",
      String(options.maxRuntimeMs),
    ],
    {
      env: phase3Internals.runnerEnvironment(options.ticket),
      stdio: "pipe",
    },
  );
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk;
  });
  const code = await new Promise<number | null>((resolveExit, rejectExit) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      rejectExit(new Error("Phase 3 runner process did not terminate."));
    }, options.maxRuntimeMs + 3_000);
    child.once("error", rejectExit);
    child.once("exit", (exitCode) => {
      clearTimeout(timer);
      resolveExit(exitCode);
    });
  });
  return { code, stderr };
}

describe.sequential("Phase 3 durable transport and recovery", () => {
  it("accepts a short-lived bootstrap ticket once and rejects its reuse", async () => {
    const scratch =
      process.env.PAPERCLIP_RUN_SCRATCH_DIR ??
      process.env.PAPERCLIP_SCRATCH_DIR ??
      tmpdir();
    const root = mkdtempSync(resolve(scratch, "phase3-ticket-test-"));
    const core = new Phase3MockCore({
      stateDirectory: root,
      identity: phase3Internals.phase3Identity(),
      fault: "none",
    });
    try {
      await core.start();
      core.queueCommand("runner.shutdown", {});
      const ticket = core.issueBootstrapTicket();
      const stateDirectory = resolve(root, "runner");

      const first = await runRunnerProcess({
        connectUrl: core.connectUrl,
        stateDirectory,
        identity: core.identity,
        ticket,
        maxRuntimeMs: 2_000,
      });
      expect(first.code, first.stderr).toBe(0);
      expect(core.store.state.connectionCount).toBe(1);

      const reused = await runRunnerProcess({
        connectUrl: core.connectUrl,
        stateDirectory,
        identity: core.identity,
        ticket,
        maxRuntimeMs: 100,
      });
      expect(reused.code).not.toBe(0);
      expect(core.store.state.connectionCount).toBe(1);

      const expiredTicket = core.issueBootstrapTicket(-1);
      const expired = await runRunnerProcess({
        connectUrl: core.connectUrl,
        stateDirectory: resolve(root, "expired-runner"),
        identity: core.identity,
        ticket: expiredTicket,
        maxRuntimeMs: 100,
      });
      expect(expired.code).not.toBe(0);
      expect(core.store.state.connectionCount).toBe(1);
      expect(
        Object.values(core.store.state.tickets).filter((record) => record.usedAt !== null),
      ).toHaveLength(1);
    } finally {
      await core.stop();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("requires proof before consuming a ticket and rejects mismatched session identity", async () => {
    const scratch =
      process.env.PAPERCLIP_RUN_SCRATCH_DIR ??
      process.env.PAPERCLIP_SCRATCH_DIR ??
      tmpdir();
    const root = mkdtempSync(resolve(scratch, "phase3-identity-auth-test-"));
    const identity = phase3Internals.phase3Identity();
    const core = new Phase3MockCore({
      stateDirectory: root,
      identity,
      fault: "none",
    });
    try {
      await core.start();

      const bootstrap = core.issueBootstrapTicket();
      const credentialId = phase3Internals.credentialMaterial(bootstrap).credentialId;
      const wrongIdentitySocket = await upgradeSocket(core.connectUrl);
      const wrongHello = authHello(identity, credentialId);
      (wrongHello.payload as Record<string, unknown>).runId = "run_wrong_identity";
      sendMaskedJson(wrongIdentitySocket, wrongHello);
      await expectSocketClosed(wrongIdentitySocket);
      expect(core.store.state.tickets[credentialId]?.usedAt).toBeNull();

      const forgedProofSocket = await upgradeSocket(core.connectUrl);
      sendMaskedJson(forgedProofSocket, authHello(identity, credentialId));
      const challenge = await receiveServerJson(forgedProofSocket);
      const challengePayload = challenge.payload as Record<string, unknown>;
      sendMaskedJson(forgedProofSocket, {
        protocol: "paperclip.runner",
        version: 1,
        kind: "auth_response",
        payload: {
          credentialId,
          clientNonce: challengePayload.clientNonce,
          serverNonce: challengePayload.serverNonce,
          clientProof: "00".repeat(32),
        },
      });
      await expectSocketClosed(forgedProofSocket);
      expect(core.store.state.tickets[credentialId]?.usedAt).toBeNull();
    } finally {
      await core.stop();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform !== "win32")(
    "atomically stores mock-core state without following a preplanted predictable symlink",
    () => {
      const scratch =
        process.env.PAPERCLIP_RUN_SCRATCH_DIR ??
        process.env.PAPERCLIP_SCRATCH_DIR ??
        tmpdir();
      const root = mkdtempSync(resolve(scratch, "phase3-core-state-symlink-"));
      const stateDirectory = resolve(root, "mock-core");
      const victim = resolve(root, "victim.txt");
      mkdirSync(stateDirectory, { mode: 0o700 });
      chmodSync(stateDirectory, 0o700);
      writeFileSync(victim, "unchanged", { mode: 0o600 });
      const planted = resolve(stateDirectory, "mock-core-state.json.next");
      symlinkSync(victim, planted);
      try {
        const core = new Phase3MockCore({
          stateDirectory,
          identity: phase3Internals.phase3Identity(),
          fault: "none",
        });
        core.issueBootstrapTicket();
        const statePath = resolve(stateDirectory, "mock-core-state.json");

        expect(readFileSync(victim, "utf8")).toBe("unchanged");
        expect(lstatSync(planted).isSymbolicLink()).toBe(true);
        expect(lstatSync(stateDirectory).mode & 0o777).toBe(0o700);
        expect(lstatSync(statePath).mode & 0o777).toBe(0o600);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it.each(["socket-drop", "lost-ack", "malformed-input"] as const)(
    "recovers the %s reconnect path with stable identities and cursors",
    async (fault) => {
      const trace = await runPhase3Recovery({ fault });

      expect(trace.diagnostics.recovery.outcome).toBe("recovered");
      expect(trace.diagnostics.connection.connectionCount).toBeGreaterThan(1);
      expect(trace.assertions.stableIdentity).toBe(true);
      expect(trace.assertions.sourceCursorContinuous).toBe(true);
      expect(trace.assertions.noDuplicateLogicalEvents).toBe(true);
      expect(trace.assertions.p0Preserved).toBe(true);
      expect(trace.assertions.secretsRedacted).toBe(true);
      expect(trace.diagnostics.security).toMatchObject({
        bootstrapTicketPersisted: false,
        connectionLeaseTokenPersisted: false,
        secretLeakCount: 0,
      });
      if (fault === "lost-ack") {
        expect(trace.diagnostics.recovery.replayDeliveries).toBeGreaterThan(0);
        expect(
          trace.diagnostics.committedEvents.some((event) => event.deliveryCount > 1),
        ).toBe(true);
      }
      if (fault === "malformed-input") {
        expect(trace.diagnostics.recovery.malformedFrames).toBe(1);
        expect(trace.runnerState.diagnostics.join(" ")).toContain(
          "malformed WebSocket JSON",
        );
      }
    },
  );

  it("replays a processed command without repeating its logical effect", async () => {
    const trace = await runPhase3Recovery({ fault: "duplicate-command" });

    expect(trace.diagnostics.commands.duplicateDeliveries).toBeGreaterThan(0);
    expect(trace.assertions.oneLogicalEffectPerAcceptedCommand).toBe(true);
    expect(trace.runnerState.processedCommands.command_phase3_001?.logicalEffectCount).toBe(1);
    expect(
      trace.diagnostics.committedEvents.filter(
        (event) => event.eventType === "workspace.ready",
      ),
    ).toHaveLength(1);
  });

  it("restores the same runner session after a real runner process restart", async () => {
    const trace = await runPhase3Recovery({ fault: "runner-restart" });

    expect(trace.diagnostics.recovery.runnerRestarts).toBe(1);
    expect(trace.diagnostics.recovery.freshBootstraps).toBe(2);
    expect(trace.diagnostics.recovery.replayDeliveries).toBeGreaterThan(0);
    expect(
      trace.diagnostics.committedEvents.some(
        (event) => event.eventType === "runner.reconciled",
      ),
    ).toBe(true);
    expect(trace.assertions.stableIdentity).toBe(true);
    expect(trace.assertions.sourceCursorContinuous).toBe(true);
  });

  it("keeps a restarted revoked runner network-silent and byte-stable with a fresh ticket", async () => {
    const scratch =
      process.env.PAPERCLIP_RUN_SCRATCH_DIR ??
      process.env.PAPERCLIP_SCRATCH_DIR ??
      tmpdir();
    const root = mkdtempSync(resolve(scratch, "phase3-revoked-restart-test-"));
    const runnerStateDirectory = resolve(root, "runner");
    const identity = phase3Internals.phase3Identity();
    mkdirSync(runnerStateDirectory, { recursive: true, mode: 0o700 });
    const envelope = {
      protocol: "paperclip.runner",
      version: 1,
      envelopeId: "envelope_event_000004",
      kind: "event",
      runnerInstanceId: identity.runnerInstanceId,
      payload: {
        sourceEventId: `event_${identity.runnerInstanceId}_000004`,
        sourceSeq: 4,
        eventType: "run.terminal",
        priority: 0,
        payload: { status: "succeeded" },
      },
    };
    const byteSize = Buffer.byteLength(JSON.stringify(envelope));
    const statePath = resolve(runnerStateDirectory, "runner-state.json");
    writeFileSync(
      statePath,
      JSON.stringify(
        {
          schema: "paperclip.runner.phase3.state.v1",
          ...identity,
          lifecycle: "revoked",
          nextSourceSeq: 5,
          ackedSourceSeq: 3,
          lastControllerCommandSeq: 2,
          reconnectCount: 7,
          maxOutboxBytes: 64 * 1024,
          peakOutboxBytes: byteSize,
          outbox: [
            {
              sourceSeq: 4,
              sourceEventId: `event_${identity.runnerInstanceId}_000004`,
              priority: 0,
              eventType: "run.terminal",
              itemId: null,
              envelope,
              byteSize,
            },
          ],
          processedCommands: {},
          compactedCommandFilter: "00".repeat(4_096),
          compactedCommandCount: 0,
          diagnostics: ["connection lease revoked; preserving durable events"],
          backpressure: false,
          recoverableFailure: null,
          unrecoverableOutcome: null,
          harnessGeneration: 1,
          stopAfterFlush: true,
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
    const before = readFileSync(statePath);
    const core = new Phase3MockCore({
      stateDirectory: resolve(root, "mock-core"),
      identity,
      fault: "none",
    });
    try {
      await core.start();
      const ticket = core.issueBootstrapTicket();
      const connectionsBefore = core.store.state.connectionCount;
      const result = await runRunnerProcess({
        connectUrl: core.connectUrl,
        stateDirectory: runnerStateDirectory,
        identity,
        ticket,
        maxRuntimeMs: 1_000,
      });

      expect(result.code, result.stderr).toBe(0);
      expect(core.store.state.connectionCount).toBe(connectionsBefore);
      expect(Object.values(core.store.state.tickets).map((record) => record.usedAt)).toEqual([
        null,
      ]);
      expect(readFileSync(statePath)).toEqual(before);
    } finally {
      await core.stop();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reconciles a restarted harness without replacing session, turn, or item IDs", async () => {
    const trace = await runPhase3Recovery({ fault: "harness-restart" });
    const reconciled = trace.diagnostics.committedEvents.find(
      (event) => event.eventType === "session.reconciled",
    );

    expect(trace.diagnostics.recovery.harnessRestarts).toBe(1);
    expect(reconciled).toBeDefined();
    expect(reconciled?.envelope).toMatchObject({
      runId: "run_phase3_stable",
      normalizedSessionId: "session_phase3_stable",
      turnId: "turn_phase3_stable",
    });
    expect(trace.assertions.stableIdentity).toBe(true);
  });

  it("uses a fresh bootstrap after lease expiry and resumes the durable cursor", async () => {
    const trace = await runPhase3Recovery({ fault: "lease-expiry" });

    expect(trace.diagnostics.recovery.runnerRestarts).toBe(1);
    expect(trace.diagnostics.recovery.freshBootstraps).toBe(2);
    expect(trace.assertions.sourceCursorContinuous).toBe(true);
    expect(trace.diagnostics.recovery.outcome).toBe("recovered");
  });

  it("bounds storage, coalesces P2, preserves P0, and rejects new turns", async () => {
    const trace = await runPhase3Recovery({ fault: "storage-pressure" });
    const deltaEvents = trace.diagnostics.committedEvents.filter(
      (event) => event.eventType === "item.delta",
    );
    const turn = trace.commands.find((command) => command.type === "turn.start");

    expect(trace.diagnostics.outbox.backpressure).toBe(true);
    expect(trace.diagnostics.outbox.peakBytes).toBeLessThanOrEqual(
      trace.diagnostics.outbox.maxBytes,
    );
    expect(deltaEvents).toHaveLength(1);
    expect(trace.diagnostics.committedEvents.some((event) => event.eventType === "runner.backpressure"))
      .toBe(true);
    expect(turn?.status).toBe("rejected");
    expect(trace.assertions.boundedStorage).toBe(true);
    expect(trace.assertions.p0Preserved).toBe(true);
  });

  it.each(["drain", "revoke"] as const)(
    "%s stops new work only after preserving the durable event cursor",
    async (fault) => {
      const trace = await runPhase3Recovery({ fault });

      expect(trace.diagnostics.recovery.outcome).toBe(fault === "drain" ? "drained" : "revoked");
      expect(trace.diagnostics.outbox.events).toBe(0);
      expect(trace.assertions.sourceCursorContinuous).toBe(true);
      expect(trace.assertions.p0Preserved).toBe(true);
      if (fault === "drain") {
        expect(trace.commands.find((command) => command.type === "turn.start")?.status)
          .toBe("rejected");
      } else {
        const afterRevoke = trace.commands.find(
          (command) => command.commandId === "command_after_revoke",
        );
        expect(trace.runnerState.lifecycle).toBe("revoked");
        expect(trace.diagnostics.recovery.replayDeliveries).toBeGreaterThan(0);
        expect(afterRevoke?.status).toBe("rejected");
        expect(afterRevoke?.result?.logicalEffectCount).toBe(0);
        expect(
          trace.diagnostics.committedEvents.filter(
            (event) => event.eventType === "turn.accepted",
          ),
        ).toHaveLength(1);
      }
    },
  );

  it("passes only the bootstrap capability and platform basics to the runner", () => {
    const environment = phase3Internals.runnerEnvironment("opaque-ticket");

    expect(environment.PAPERCLIP_RUNNER_BOOTSTRAP_TICKET).toBe("opaque-ticket");
    expect(environment.PAPERCLIP_API_KEY).toBeUndefined();
    expect(environment.OPENAI_API_KEY).toBeUndefined();
    expect(environment.EMAIL_AGENTMAIL_GENERAL_API_KEY).toBeUndefined();
  });
});
