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

async function upgradeStatus(url: string, ticket: string): Promise<number> {
  const parsed = new URL(url);
  return new Promise((resolveStatus, rejectStatus) => {
    const socket = connect(Number(parsed.port), parsed.hostname);
    let response = "";
    socket.once("error", rejectStatus);
    socket.once("connect", () => {
      socket.write(
        [
          `GET ${parsed.pathname} HTTP/1.1`,
          `Host: ${parsed.host}`,
          "Upgrade: websocket",
          "Connection: Upgrade",
          "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
          "Sec-WebSocket-Version: 13",
          `Authorization: Bearer ${ticket}`,
          "\r\n",
        ].join("\r\n"),
      );
    });
    socket.on("data", (chunk) => {
      response += chunk.toString("utf8");
      if (response.includes("\r\n\r\n")) {
        const status = Number(response.match(/^HTTP\/1\.1 (\d{3})/)?.[1]);
        socket.destroy();
        resolveStatus(status);
      }
    });
  });
}

async function upgradeSocket(url: string, ticket: string): Promise<Socket> {
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
          `Authorization: Bearer ${ticket}`,
          "\r\n",
        ].join("\r\n"),
      );
    });
    socket.on("data", onData);
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

function hello(identity: ReturnType<typeof phase3Internals.phase3Identity>): Record<string, unknown> {
  return {
    protocol: "paperclip.runner",
    version: 1,
    envelopeId: "hello_auth_regression",
    kind: "hello",
    runnerInstanceId: identity.runnerInstanceId,
    payload: {
      protocolMin: 1,
      protocolMax: 1,
      runnerVersion: "0.3.0",
      runnerDigest: "sha256:phase3-approved",
      environmentLeaseId: identity.environmentLeaseId,
    },
  };
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
      const ticket = core.issueBootstrapTicket();

      await expect(upgradeStatus(core.connectUrl, ticket)).resolves.toBe(101);
      await expect(upgradeStatus(core.connectUrl, ticket)).resolves.toBe(401);
      const expiredTicket = core.issueBootstrapTicket(-1);
      await expect(upgradeStatus(core.connectUrl, expiredTicket)).resolves.toBe(401);
    } finally {
      await core.stop();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects bootstrap and resumed lease credentials bound to a different runner identity", async () => {
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
      const bootstrapSocket = await upgradeSocket(core.connectUrl, bootstrap);
      sendMaskedJson(bootstrapSocket, {
        ...hello(identity),
        runnerInstanceId: "runner_wrong_identity",
      });
      await expectSocketClosed(bootstrapSocket);

      const leaseToken = "lease_wrong_identity_regression";
      const digest = phase3Internals.tokenDigest(leaseToken);
      core.store.state.leases[digest] = {
        digest,
        leaseId: "lease_wrong_identity",
        runnerInstanceId: "runner_other_identity",
        expiresAt: new Date(Date.now() + 30_000).toISOString(),
        revokedAt: null,
      };
      core.store.save();
      const leaseSocket = await upgradeSocket(core.connectUrl, leaseToken);
      sendMaskedJson(leaseSocket, hello(identity));
      await expectSocketClosed(leaseSocket);
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
