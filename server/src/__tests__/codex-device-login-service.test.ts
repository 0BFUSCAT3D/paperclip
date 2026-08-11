import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { adapterAuthSessions, companies, createDb, environments } from "@paperclipai/db";
import type { AgentAdapterType } from "@paperclipai/shared";
import { DEVICE_LOGIN_URL } from "@paperclipai/adapter-codex-local/server";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  AdapterAuthSessionConflictError,
  buildSandboxLoginDriver,
  CODEX_DEVICE_LOGIN_TIMEOUT_MS,
  createCodexDeviceLoginService,
  createDbAdapterAuthSessionStore,
  sessionCodexHomePath,
  sessionCredentialPath,
  type AcquireLoginLeaseInput,
  type AdapterAuthSessionRow,
  type AdapterAuthSessionStore,
  type CredentialPromotion,
  type LoginSessionActivityEvent,
  type LoginSessionLease,
  type LoginSessionRuntime,
  type SandboxDeleteResult,
} from "../services/codex-device-login-service.ts";

// A passing promotion for the lifecycle tests. The mandatory promotion is a
// required dependency, so a test that does not exercise the credential write
// still supplies a promotion that accepts the credential.
const passingPromotion: CredentialPromotion = { promote: () => {} };

// Build the service with the passing promotion by default. A test that checks
// the promotion path passes its own `promotion` to override the default.
type ServiceDeps = Parameters<typeof createCodexDeviceLoginService>[0];
function makeService(deps: Omit<ServiceDeps, "promotion"> & { promotion?: CredentialPromotion }) {
  return createCodexDeviceLoginService({ promotion: passingPromotion, ...deps });
}

const ADAPTER_TYPE: AgentAdapterType = "codex_local";
const OWNER_A = "user-a";
const OWNER_B = "user-b";

// A valid device-login output. The parser accepts the exact URL and a code of
// four characters, a hyphen, and five characters, on a dedicated line after the
// "one-time code" preamble.
const PROMPT_OUTPUT = `Open ${DEVICE_LOGIN_URL} in your browser.\nEnter the one-time code below:\nABCD-EFGHI\n`;
const PROMPT_CODE = "ABCD-EFGHI";

type ExecController = { onStdout: (chunk: string) => void; input: AcquireLoginLeaseInput };
type ExecBehavior = (c: ExecController) => Promise<{ exitCode: number | null }>;

const execSuccess: ExecBehavior = async ({ onStdout }) => {
  onStdout(PROMPT_OUTPUT);
  return { exitCode: 0 };
};

const execFailure: ExecBehavior = async ({ onStdout }) => {
  onStdout(PROMPT_OUTPUT);
  return { exitCode: 1 };
};

const execDriverError: ExecBehavior = async ({ onStdout }) => {
  onStdout(PROMPT_OUTPUT);
  throw new Error("driver stream errored");
};

// Emit the prompt, then never resolve. The host timeout or the cancellation
// signal ends the run.
const execHang: ExecBehavior = ({ onStdout }) => {
  onStdout(PROMPT_OUTPUT);
  return new Promise<{ exitCode: number | null }>(() => {});
};

interface FakeRuntimeOptions {
  exec: ExecBehavior;
  authBytes?: Buffer;
  delete?: () => Promise<SandboxDeleteResult>;
}

function createFakeRuntime(opts: FakeRuntimeOptions) {
  const acquisitions: AcquireLoginLeaseInput[] = [];
  const deleteCalls: string[] = [];
  const releaseCalls: string[] = [];
  const deleteImpl = opts.delete ?? (async (): Promise<SandboxDeleteResult> => ({ outcome: "deleted" }));
  const runtime: LoginSessionRuntime = {
    async acquireLoginLease(input) {
      acquisitions.push(input);
      const lease: LoginSessionLease = {
        providerLeaseId: `lease-${input.sessionId}`,
        authPath: sessionCredentialPath(input.sessionId),
        driver: {
          execStreaming: (_command, onStdout) => opts.exec({ onStdout, input }),
          readFile: async () => opts.authBytes ?? Buffer.from("{}"),
          dispose: async () => {},
        },
        deleteSandbox: async () => {
          deleteCalls.push(input.sessionId);
          return await deleteImpl();
        },
        release: async () => {
          releaseCalls.push(input.sessionId);
        },
      };
      return lease;
    },
  };
  return { runtime, acquisitions, deleteCalls, releaseCalls };
}

// An in-memory store. It mimics the active company-adapter slot, so most tests
// run with no database. The concurrency test uses the database-backed store, so
// the real partial unique index maps the conflict to a 409.
function createMemoryStore(): AdapterAuthSessionStore & {
  rows: Map<string, AdapterAuthSessionRow>;
} {
  const rows = new Map<string, AdapterAuthSessionRow>();
  const activeSlots = new Set<string>();
  const slotKey = (companyId: string, adapterType: string) => `${companyId}|${adapterType}`;
  const isActive = (status: AdapterAuthSessionRow["status"]) =>
    status === "starting" || status === "waiting_for_user" || status === "promoting";
  return {
    rows,
    async insert(input) {
      const key = slotKey(input.companyId, input.adapterType);
      if (activeSlots.has(key)) throw new AdapterAuthSessionConflictError();
      activeSlots.add(key);
      rows.set(input.id, {
        id: input.id,
        companyId: input.companyId,
        environmentId: input.environmentId,
        adapterType: input.adapterType,
        startedByUserId: input.startedByUserId,
        providerLeaseId: null,
        status: "starting",
        expiresAt: input.expiresAt,
        finishedAt: null,
        failureReason: null,
      });
    },
    async recordLeaseAcquired(input) {
      const row = rows.get(input.sessionId);
      if (row) row.providerLeaseId = input.providerLeaseId;
    },
    async setStatus(input) {
      const row = rows.get(input.sessionId);
      if (!row) return;
      row.status = input.status;
      if (input.failureReason !== undefined) row.failureReason = input.failureReason;
      if (input.finishedAt !== undefined) row.finishedAt = input.finishedAt;
      if (!isActive(input.status)) activeSlots.delete(slotKey(row.companyId, row.adapterType));
    },
    async get(sessionId) {
      const row = rows.get(sessionId);
      return row ? { ...row } : null;
    },
  };
}

describe("codex device login service", () => {
  it("inserts the session row before it acquires the lease", async () => {
    const store = createMemoryStore();
    let rowPresentAtAcquire = false;
    const runtime: LoginSessionRuntime = {
      async acquireLoginLease(input) {
        rowPresentAtAcquire = (await store.get(input.sessionId)) !== null;
        return {
          providerLeaseId: `lease-${input.sessionId}`,
          authPath: sessionCredentialPath(input.sessionId),
          driver: {
            execStreaming: (_command, onStdout) => execSuccess({ onStdout, input }),
            readFile: async () => Buffer.from("{}"),
            dispose: async () => {},
          },
          deleteSandbox: async () => ({ outcome: "deleted" }),
          release: async () => {},
        };
      },
    };
    const service = makeService({ store, runtime });
    const { session, completed } = await service.start({
      companyId: randomUUID(),
      environmentId: randomUUID(),
      adapterType: ADAPTER_TYPE,
      startedByUserId: OWNER_A,
    });
    expect(rowPresentAtAcquire).toBe(true);
    expect(session.status).toBe("starting");
    expect(session.expiresAt).not.toBeNull();
    await completed;
  });

  it("delivers the prompt to the owner, promotes, deletes the sandbox, and authenticates", async () => {
    const store = createMemoryStore();
    const activity: LoginSessionActivityEvent[] = [];
    const promoted: Buffer[] = [];
    const promotionContexts: { sessionId: string; companyId: string }[] = [];
    const { runtime, deleteCalls } = createFakeRuntime({
      exec: execSuccess,
      authBytes: Buffer.from('{"token":"secret"}'),
    });
    const companyId = randomUUID();
    const service = makeService({
      store,
      runtime,
      recordActivity: (event) => activity.push(event),
      promotion: {
        promote: (bytes, context) => {
          promoted.push(bytes);
          promotionContexts.push({ sessionId: context.sessionId, companyId: context.companyId });
        },
      },
    });
    const { session, completed } = await service.start({
      companyId,
      environmentId: randomUUID(),
      adapterType: ADAPTER_TYPE,
      startedByUserId: OWNER_A,
    });

    // The owner reads the one-time prompt through the owner read path.
    const owner = await service.readOwnerSession(session.sessionId, OWNER_A);
    expect(owner?.prompt).toEqual({ url: DEVICE_LOGIN_URL, code: PROMPT_CODE });

    // A non-owner never reads the prompt.
    const other = await service.readOwnerSession(session.sessionId, OWNER_B);
    expect(other?.prompt).toBeNull();

    const outcome = await completed;
    expect(outcome.status).toBe("authenticated");
    expect(outcome.cleanupPending).toBe(false);
    expect(outcome.sandboxDeleteObserved).toBe(true);
    expect(deleteCalls).toHaveLength(1);
    expect(promoted).toHaveLength(1);
    // The promotion runs with the session and company context, so it resolves the
    // company scope and the sole-active-owner check for this exact session.
    expect(promotionContexts).toEqual([{ sessionId: session.sessionId, companyId }]);

    // The prompt is one-time: a second owner read returns null.
    const secondRead = await service.readOwnerSession(session.sessionId, OWNER_A);
    expect(secondRead?.prompt).toBeNull();

    const row = await store.get(session.sessionId);
    expect(row?.status).toBe("authenticated");
    expect(row?.finishedAt).not.toBeNull();

    // Every activity record carries only non-secret fields.
    expect(activity.length).toBeGreaterThan(0);
    for (const event of activity) {
      expect(Object.keys(event).sort()).toEqual([
        "adapterType",
        "companyId",
        "environmentId",
        "phase",
        "sessionId",
      ]);
    }
    // The prompt phase records the surface, not the URL or the code.
    expect(activity.map((event) => event.phase)).toContain("prompt_surfaced");
    expect(JSON.stringify(activity)).not.toContain(DEVICE_LOGIN_URL);
    expect(JSON.stringify(activity)).not.toContain(PROMPT_CODE);
  });

  it("fails closed and never promotes when a success outcome carries no credential", async () => {
    const store = createMemoryStore();
    let promoteCalls = 0;
    const { runtime, deleteCalls } = createFakeRuntime({
      // The login command exits 0, but the sandbox produced no credential bytes.
      exec: execSuccess,
      authBytes: Buffer.alloc(0),
    });
    const service = makeService({
      store,
      runtime,
      promotion: {
        promote: () => {
          promoteCalls += 1;
        },
      },
    });
    const { session, completed } = await service.start({
      companyId: randomUUID(),
      environmentId: randomUUID(),
      adapterType: ADAPTER_TYPE,
      startedByUserId: OWNER_A,
    });
    const outcome = await completed;
    // A success outcome with no credential never authenticates and never runs
    // the promotion write. The service still deletes the sandbox.
    expect(outcome.status).toBe("failed");
    expect(promoteCalls).toBe(0);
    expect(deleteCalls).toHaveLength(1);
    const row = await store.get(session.sessionId);
    expect(row?.status).toBe("failed");
    const failed = await service.readOwnerSession(session.sessionId, OWNER_A);
    expect(failed?.failure?.reason).toBe("promotion_failed");
  });

  it("deletes the sandbox and records a failed terminal on a non-zero exit", async () => {
    const store = createMemoryStore();
    const { runtime, deleteCalls } = createFakeRuntime({ exec: execFailure });
    const service = makeService({ store, runtime });
    const { session, completed } = await service.start({
      companyId: randomUUID(),
      environmentId: randomUUID(),
      adapterType: ADAPTER_TYPE,
      startedByUserId: OWNER_A,
    });
    const outcome = await completed;
    expect(outcome.status).toBe("failed");
    expect(outcome.sandboxDeleteObserved).toBe(true);
    expect(deleteCalls).toHaveLength(1);
    const failed = await service.readOwnerSession(session.sessionId, OWNER_A);
    expect(failed?.status).toBe("failed");
    expect(failed?.failure?.reason).toBe("login_command_failed");
  });

  it("deletes the sandbox and records a failed terminal on a driver error", async () => {
    const store = createMemoryStore();
    const { runtime, deleteCalls } = createFakeRuntime({ exec: execDriverError });
    const service = makeService({ store, runtime });
    const { completed } = await service.start({
      companyId: randomUUID(),
      environmentId: randomUUID(),
      adapterType: ADAPTER_TYPE,
      startedByUserId: OWNER_A,
    });
    const outcome = await completed;
    expect(outcome.status).toBe("failed");
    expect(deleteCalls).toHaveLength(1);
  });

  it("deletes the sandbox and records a cancelled terminal on a cancellation", async () => {
    const store = createMemoryStore();
    const { runtime, deleteCalls } = createFakeRuntime({ exec: execHang });
    const service = makeService({ store, runtime });
    const controller = new AbortController();
    const { session, completed } = await service.start({
      companyId: randomUUID(),
      environmentId: randomUUID(),
      adapterType: ADAPTER_TYPE,
      startedByUserId: OWNER_A,
      signal: controller.signal,
    });
    controller.abort();
    const outcome = await completed;
    expect(outcome.status).toBe("cancelled");
    expect(outcome.sandboxDeleteObserved).toBe(true);
    expect(deleteCalls).toHaveLength(1);
    const row = await store.get(session.sessionId);
    expect(row?.status).toBe("cancelled");
  });

  it("releases the lease when a transition fails after acquisition", async () => {
    const store = createMemoryStore();
    // A rejecting `recordLeaseAcquired` forces a transition failure right after
    // the acquisition.
    const failingStore: AdapterAuthSessionStore = {
      ...store,
      async recordLeaseAcquired() {
        throw new Error("transition write failed");
      },
    };
    const { runtime, releaseCalls, deleteCalls } = createFakeRuntime({ exec: execSuccess });
    const service = makeService({ store: failingStore, runtime });
    const companyId = randomUUID();
    await expect(
      service.start({
        companyId,
        environmentId: randomUUID(),
        adapterType: ADAPTER_TYPE,
        startedByUserId: OWNER_A,
      }),
    ).rejects.toThrow("transition write failed");
    expect(releaseCalls).toHaveLength(1);
    // The service never runs the login command, so it never deletes a sandbox.
    expect(deleteCalls).toHaveLength(0);
    const rows = [...store.rows.values()].filter((row) => row.companyId === companyId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("failed");
  });

  // The rejecting-delete matrix. A delete failure on every terminal path records
  // the durable internal `cleanup_pending` state and never returns a false-clean
  // terminal outcome.
  const rejectingDelete = async (): Promise<SandboxDeleteResult> => {
    throw new Error("provider delete rejected");
  };

  it.each([
    { name: "success", exec: execSuccess, terminal: "authenticated" as const, cancel: false },
    { name: "failure", exec: execFailure, terminal: "failed" as const, cancel: false },
    { name: "cancellation", exec: execHang, terminal: "cancelled" as const, cancel: true },
  ])(
    "records cleanup_pending on a delete failure for the $name path",
    async ({ exec, terminal, cancel }) => {
      const store = createMemoryStore();
      const { runtime, deleteCalls } = createFakeRuntime({
        exec,
        authBytes: Buffer.from("{}"),
        delete: rejectingDelete,
      });
      const service = makeService({ store, runtime });
      const controller = new AbortController();
      const { session, completed } = await service.start({
        companyId: randomUUID(),
        environmentId: randomUUID(),
        adapterType: ADAPTER_TYPE,
        startedByUserId: OWNER_A,
        signal: controller.signal,
      });
      if (cancel) controller.abort();
      const outcome = await completed;
      expect(outcome.status).toBe(terminal);
      expect(outcome.cleanupPending).toBe(true);
      expect(outcome.sandboxDeleteObserved).toBe(true);
      expect(deleteCalls).toHaveLength(1);
      const row = await store.get(session.sessionId);
      expect(row?.status).toBe("cleanup_pending");
      // The public read resolves the retained terminal, never a false-clean.
      const publicRead = await service.readOwnerSession(session.sessionId, OWNER_A);
      expect(publicRead?.status).toBe(terminal);
    },
  );

  it("records cleanup_pending on a delete failure after a promotion failure", async () => {
    const store = createMemoryStore();
    const { runtime, deleteCalls } = createFakeRuntime({
      exec: execSuccess,
      authBytes: Buffer.from("{}"),
      delete: rejectingDelete,
    });
    const service = makeService({
      store,
      runtime,
      promotion: {
        promote: () => {
          throw new Error("promotion write failed");
        },
      },
    });
    const { session, completed } = await service.start({
      companyId: randomUUID(),
      environmentId: randomUUID(),
      adapterType: ADAPTER_TYPE,
      startedByUserId: OWNER_A,
    });
    const outcome = await completed;
    // The promotion write failed, so the terminal is `failed`, not
    // `authenticated`. The delete also failed, so the row holds cleanup_pending.
    expect(outcome.status).toBe("failed");
    expect(outcome.cleanupPending).toBe(true);
    expect(outcome.sandboxDeleteObserved).toBe(true);
    expect(deleteCalls).toHaveLength(1);
    const row = await store.get(session.sessionId);
    expect(row?.status).toBe("cleanup_pending");
    const publicRead = await service.readOwnerSession(session.sessionId, OWNER_A);
    expect(publicRead?.status).toBe("failed");
    expect(publicRead?.failure?.reason).toBe("promotion_failed");
  });

  it("treats a provider not_found result as an idempotent confirmed delete", async () => {
    const store = createMemoryStore();
    const { runtime } = createFakeRuntime({
      exec: execSuccess,
      authBytes: Buffer.from("{}"),
      delete: async () => ({ outcome: "not_found" }),
    });
    const service = makeService({ store, runtime });
    const { session, completed } = await service.start({
      companyId: randomUUID(),
      environmentId: randomUUID(),
      adapterType: ADAPTER_TYPE,
      startedByUserId: OWNER_A,
    });
    const outcome = await completed;
    expect(outcome.status).toBe("authenticated");
    expect(outcome.cleanupPending).toBe(false);
    expect(outcome.sandboxDeleteObserved).toBe(true);
    const row = await store.get(session.sessionId);
    expect(row?.status).toBe("authenticated");
  });

  describe("five-minute host timeout", () => {
    it("holds the session active until exactly five minutes, then times out and deletes", async () => {
      vi.useFakeTimers();
      try {
        const store = createMemoryStore();
        const { runtime, deleteCalls } = createFakeRuntime({ exec: execHang });
        const service = makeService({ store, runtime });
        const { session, completed } = await service.start({
          companyId: randomUUID(),
          environmentId: randomUUID(),
          adapterType: ADAPTER_TYPE,
          startedByUserId: OWNER_A,
        });
        let settled = false;
        void completed.then(() => {
          settled = true;
        });

        // One millisecond before five minutes: the run still holds the active
        // claim.
        await vi.advanceTimersByTimeAsync(CODEX_DEVICE_LOGIN_TIMEOUT_MS - 1);
        expect(settled).toBe(false);
        const midRow = await store.get(session.sessionId);
        expect(["starting", "waiting_for_user"]).toContain(midRow?.status);

        // The last millisecond fires the timeout.
        await vi.advanceTimersByTimeAsync(1);
        const outcome = await completed;
        expect(outcome.status).toBe("timed_out");
        expect(outcome.sandboxDeleteObserved).toBe(true);
        expect(deleteCalls).toHaveLength(1);
        const row = await store.get(session.sessionId);
        expect(row?.status).toBe("timed_out");
      } finally {
        vi.useRealTimers();
      }
    });

    it("records cleanup_pending on a delete failure at the five-minute timeout", async () => {
      vi.useFakeTimers();
      try {
        const store = createMemoryStore();
        const { runtime, deleteCalls } = createFakeRuntime({
          exec: execHang,
          delete: async () => {
            throw new Error("provider delete rejected");
          },
        });
        const service = makeService({ store, runtime });
        const { session, completed } = await service.start({
          companyId: randomUUID(),
          environmentId: randomUUID(),
          adapterType: ADAPTER_TYPE,
          startedByUserId: OWNER_A,
        });
        await vi.advanceTimersByTimeAsync(CODEX_DEVICE_LOGIN_TIMEOUT_MS);
        const outcome = await completed;
        expect(outcome.status).toBe("timed_out");
        expect(outcome.cleanupPending).toBe(true);
        expect(outcome.sandboxDeleteObserved).toBe(true);
        expect(deleteCalls).toHaveLength(1);
        const row = await store.get(session.sessionId);
        expect(row?.status).toBe("cleanup_pending");
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it("builds a production driver that sets an empty session home and reads the fixed credential path", async () => {
    const commands: string[] = [];
    const sessionId = randomUUID();
    const sessionHome = sessionCodexHomePath(sessionId);
    const authPath = sessionCredentialPath(sessionId);
    const environmentRuntime = {
      execute: async (input: {
        command: string;
        onLog?: (stream: "stdout" | "stderr", chunk: string) => void | Promise<void>;
      }) => {
        commands.push(input.command);
        if (input.command.includes("codex login")) {
          await input.onLog?.("stdout", PROMPT_OUTPUT);
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        // The credential read.
        return { exitCode: 0, stdout: '{"token":"secret"}', stderr: "" };
      },
    };
    const driver = buildSandboxLoginDriver({
      // The helper only calls `execute`; a partial runtime is enough here.
      environmentRuntime: environmentRuntime as never,
      environment: { id: "env", driver: "sandbox" } as never,
      lease: { id: "lease" } as never,
      sessionHome,
      timeoutMs: CODEX_DEVICE_LOGIN_TIMEOUT_MS,
    });

    const chunks: string[] = [];
    const result = await driver.execStreaming("codex login --device-auth", (chunk) => chunks.push(chunk));
    expect(result.exitCode).toBe(0);
    expect(chunks.join("")).toContain(DEVICE_LOGIN_URL);
    // The command sets an empty session-specific Codex home before the login.
    expect(commands[0]).toBe(
      `rm -rf ${sessionHome} && mkdir -p ${sessionHome} && CODEX_HOME=${sessionHome} codex login --device-auth`,
    );

    const authBytes = await driver.readFile(authPath);
    expect(authBytes.toString("utf8")).toBe('{"token":"secret"}');
    expect(commands[1]).toBe(`cat ${authPath}`);
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping codex device login concurrency tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("codex device login service concurrency (embedded postgres)", () => {
  let stopDb: (() => Promise<void>) | undefined;
  let db!: ReturnType<typeof createDb>;

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("codex-device-login");
    stopDb = started.stop;
    db = createDb(started.connectionString);
  });

  afterEach(async () => {
    await db.delete(adapterAuthSessions);
    await db.delete(environments);
    await db.delete(companies);
  });

  afterAll(async () => {
    await stopDb?.();
  });

  async function seedCompanyEnvironment(): Promise<{ companyId: string; environmentId: string }> {
    const companyId = randomUUID();
    const environmentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Acme",
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(environments).values({
      id: environmentId,
      name: `sandbox-${environmentId.slice(0, 8)}`,
      driver: "sandbox",
      status: "active",
      config: { provider: "fake" },
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return { companyId, environmentId };
  }

  async function seedEnvironment(companyId: string): Promise<string> {
    const environmentId = randomUUID();
    await db.insert(environments).values({
      id: environmentId,
      name: `sandbox-${environmentId.slice(0, 8)}`,
      driver: "sandbox",
      status: "active",
      config: { provider: "fake" },
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return environmentId;
  }

  it.each([
    { name: "two owners, same environment" },
    { name: "one owner, two environments" },
  ])(
    "returns one session, one lease, and one 409 for concurrent starts ($name)",
    async ({ name }) => {
      const { companyId, environmentId: environmentA } = await seedCompanyEnvironment();
      const twoOwners = name.startsWith("two owners");
      const environmentB = twoOwners ? environmentA : await seedEnvironment(companyId);
      const ownerB = twoOwners ? OWNER_B : OWNER_A;

      const store = createDbAdapterAuthSessionStore(db);
      const { runtime, acquisitions } = createFakeRuntime({ exec: execHang });
      const service = makeService({ store, runtime });
      const controller = new AbortController();

      const results = await Promise.allSettled([
        service.start({
          companyId,
          environmentId: environmentA,
          adapterType: ADAPTER_TYPE,
          startedByUserId: OWNER_A,
          signal: controller.signal,
        }),
        service.start({
          companyId,
          environmentId: environmentB,
          adapterType: ADAPTER_TYPE,
          startedByUserId: ownerB,
          signal: controller.signal,
        }),
      ]);

      const fulfilled = results.filter(
        (result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof service.start>>> =>
          result.status === "fulfilled",
      );
      const rejected = results.filter(
        (result): result is PromiseRejectedResult => result.status === "rejected",
      );
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      const conflict = rejected[0]!.reason;
      expect(conflict).toBeInstanceOf(AdapterAuthSessionConflictError);
      expect(conflict.statusCode).toBe(409);

      // Exactly one start acquired a lease; the losing start never acquired.
      expect(acquisitions).toHaveLength(1);
      const rows = await db
        .select()
        .from(adapterAuthSessions)
        .where(eq(adapterAuthSessions.companyId, companyId));
      expect(rows).toHaveLength(1);

      // Release the surviving run so the hanging login command ends.
      controller.abort();
      await fulfilled[0]!.value.completed;
    },
  );
});
