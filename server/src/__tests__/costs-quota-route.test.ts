import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The quota route reads and validates an optional `environmentId` query
// parameter and passes it to `fetchAllQuotaWindows`. These tests run the real
// service and the real execution-context resolver. They mock only the adapter
// registry and the environment services, so a stubbed environment record and a
// stubbed lease drive the full route -> service -> resolver -> probe path.

const ENVIRONMENT_ID = "11111111-1111-4111-8111-111111111111";
const COMPANY_ID = "company-1";

// The sandbox execution target the resolver returns for a sandbox environment.
// The service reads only `kind`/`transport` to decide the untrusted-output
// sanitize pass; it passes the whole object to the adapter probe.
const SANDBOX_TARGET = {
  kind: "remote",
  transport: "sandbox",
  remoteCwd: "/work",
  providerKey: "daytona",
  runner: { execute: vi.fn() },
};

const mockCompanyService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  decide: vi.fn(async () => ({ allowed: true })),
}));

const mockEnvironmentService = vi.hoisted(() => ({
  getById: vi.fn(),
  releaseLease: vi.fn(async () => undefined),
}));

const mockReleaseRunLease = vi.hoisted(() => vi.fn(async () => undefined));
const mockEnvironmentRuntime = vi.hoisted(() => ({
  acquireRunLease: vi.fn(),
  realizeWorkspace: vi.fn(),
  getDriver: vi.fn(() => ({ releaseRunLease: mockReleaseRunLease })),
}));

const mockResolveEnvironmentExecutionTarget = vi.hoisted(() => vi.fn());
const mockListServerAdapters = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  budgetService: () => ({}),
  costService: () => ({ windowSpend: vi.fn(async () => []) }),
  financeService: () => ({}),
  companyService: () => mockCompanyService,
  agentService: () => ({}),
  issueService: () => ({}),
  heartbeatService: () => ({ cancelBudgetScopeWork: vi.fn(), wakeup: vi.fn() }),
  accessService: () => mockAccessService,
  logActivity: vi.fn(),
}));

vi.mock("../services/environments.js", () => ({
  environmentService: () => mockEnvironmentService,
}));

vi.mock("../services/environment-runtime.js", () => ({
  environmentRuntimeService: () => mockEnvironmentRuntime,
}));

vi.mock("../services/environment-execution-target.js", () => ({
  resolveEnvironmentExecutionTarget: mockResolveEnvironmentExecutionTarget,
}));

vi.mock("../adapters/registry.js", () => ({
  listServerAdapters: mockListServerAdapters,
}));

// The middleware reads this actor. A test can swap it before it builds the app.
let currentActor: Record<string, unknown> = {
  type: "board",
  userId: "local-board",
  companyIds: [COMPANY_ID],
  source: "local_implicit",
  isInstanceAdmin: false,
};

async function createApp() {
  const [{ costRoutes }, { errorHandler }] = await Promise.all([
    vi.importActual<typeof import("../routes/costs.js")>("../routes/costs.js"),
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = currentActor;
    next();
  });
  app.use("/api", costRoutes({} as any));
  app.use(errorHandler);
  return app;
}

function stubSandboxEnvironment(overrides: Record<string, unknown> = {}) {
  mockEnvironmentService.getById.mockResolvedValue({
    id: ENVIRONMENT_ID,
    name: "Sandbox QA",
    driver: "sandbox",
    status: "active",
    config: { provider: "daytona" },
    ...overrides,
  });
}

function stubLease() {
  mockEnvironmentRuntime.acquireRunLease.mockResolvedValue({
    lease: {
      id: "lease-1",
      provider: "daytona",
      providerLeaseId: "provider-lease-1",
      metadata: { remoteCwd: "/work", sandboxId: "sandbox-1" },
    },
    leaseContext: { executionWorkspaceId: null, executionWorkspaceMode: null },
  });
  mockEnvironmentRuntime.realizeWorkspace.mockResolvedValue({ cwd: "/work" });
}

function stubOneCodexAdapter(getQuotaWindows: ReturnType<typeof vi.fn>) {
  mockListServerAdapters.mockReturnValue([{ type: "codex_local", getQuotaWindows }]);
}

describe("GET /companies/:companyId/costs/quota-windows", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentActor = {
      type: "board",
      userId: "local-board",
      companyIds: [COMPANY_ID],
      source: "local_implicit",
      isInstanceAdmin: false,
    };
    mockCompanyService.getById.mockResolvedValue({ id: COMPANY_ID, name: "Co" });
    mockAccessService.decide.mockResolvedValue({ allowed: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("validates environmentId and passes the resolved target to the service", async () => {
    stubSandboxEnvironment();
    stubLease();
    mockResolveEnvironmentExecutionTarget.mockResolvedValue(SANDBOX_TARGET);
    const probe = vi.fn().mockResolvedValue({
      provider: "openai",
      ok: true,
      windows: [{ label: "5h limit", usedPercent: 2, resetsAt: null, valueLabel: null, detail: null }],
    });
    stubOneCodexAdapter(probe);
    const app = await createApp();

    const res = await request(app)
      .get(`/api/companies/${COMPANY_ID}/costs/quota-windows`)
      .query({ environmentId: ENVIRONMENT_ID });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    // The route resolved the sandbox target and dispatched the probe into it.
    expect(probe).toHaveBeenCalledTimes(1);
    expect(probe.mock.calls[0]?.[0]).toMatchObject({
      executionTarget: expect.objectContaining({ kind: "remote", transport: "sandbox" }),
    });
    expect(res.body).toEqual([
      {
        provider: "openai",
        ok: true,
        windows: [{ label: "5h limit", usedPercent: 2, resetsAt: null, valueLabel: null, detail: null }],
      },
    ]);
    // The route released the lease exactly once in the `finally` path.
    expect(mockReleaseRunLease).toHaveBeenCalledTimes(1);
    expect(mockReleaseRunLease).toHaveBeenCalledWith(
      expect.objectContaining({ status: "released" }),
    );
  });

  it("rejects an unknown environment before it probes any provider (C1)", async () => {
    mockEnvironmentService.getById.mockResolvedValue(null);
    const probe = vi.fn();
    stubOneCodexAdapter(probe);
    const app = await createApp();

    const res = await request(app)
      .get(`/api/companies/${COMPANY_ID}/costs/quota-windows`)
      .query({ environmentId: "22222222-2222-4222-8222-222222222222" });

    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/not found/i);
    expect(probe).not.toHaveBeenCalled();
    expect(mockEnvironmentRuntime.acquireRunLease).not.toHaveBeenCalled();
  });

  it("rejects an archived environment (C1)", async () => {
    stubSandboxEnvironment({ status: "archived" });
    const probe = vi.fn();
    stubOneCodexAdapter(probe);
    const app = await createApp();

    const res = await request(app)
      .get(`/api/companies/${COMPANY_ID}/costs/quota-windows`)
      .query({ environmentId: ENVIRONMENT_ID });

    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/archived/i);
    expect(probe).not.toHaveBeenCalled();
  });

  it("rejects a fake-provider sandbox environment (C1)", async () => {
    stubSandboxEnvironment({ config: { provider: "fake" } });
    const probe = vi.fn();
    stubOneCodexAdapter(probe);
    const app = await createApp();

    const res = await request(app)
      .get(`/api/companies/${COMPANY_ID}/costs/quota-windows`)
      .query({ environmentId: ENVIRONMENT_ID });

    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/fake/i);
    expect(probe).not.toHaveBeenCalled();
  });

  it("rejects a caller without the instance read permission (C1)", async () => {
    currentActor = { type: "agent", agentId: "agent-1", companyId: COMPANY_ID };
    stubOneCodexAdapter(vi.fn());
    const app = await createApp();

    const res = await request(app)
      .get(`/api/companies/${COMPANY_ID}/costs/quota-windows`)
      .query({ environmentId: ENVIRONMENT_ID });

    expect(res.status).toBe(403);
  });

  it("returns a clear error and never probes the host when the environment fails to resolve (C3)", async () => {
    stubSandboxEnvironment();
    stubLease();
    // A real, non-fake environment that the resolver cannot turn into a target.
    mockResolveEnvironmentExecutionTarget.mockResolvedValue(null);
    const probe = vi.fn();
    stubOneCodexAdapter(probe);
    const app = await createApp();

    const res = await request(app)
      .get(`/api/companies/${COMPANY_ID}/costs/quota-windows`)
      .query({ environmentId: ENVIRONMENT_ID });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    // Fail closed: the probe never runs against the host for a selected env.
    expect(probe).not.toHaveBeenCalled();
    expect(res.body[0]).toMatchObject({ provider: "openai", ok: false });
    // The lease the resolver acquired is released as failed.
    expect(mockReleaseRunLease).toHaveBeenCalledWith(
      expect.objectContaining({ status: "failed" }),
    );
  });

  it("returns a clean per-provider error, not a crash, when a probe throws", async () => {
    stubSandboxEnvironment();
    stubLease();
    mockResolveEnvironmentExecutionTarget.mockResolvedValue(SANDBOX_TARGET);
    const probe = vi.fn().mockRejectedValue(new Error("boom leaked-token-abc"));
    stubOneCodexAdapter(probe);
    const app = await createApp();

    const res = await request(app)
      .get(`/api/companies/${COMPANY_ID}/costs/quota-windows`)
      .query({ environmentId: ENVIRONMENT_ID });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body[0]).toMatchObject({ provider: "openai", ok: false });
    // The raw error text may carry probe stderr; it must never reach the body.
    expect(JSON.stringify(res.body)).not.toContain("leaked-token-abc");
    expect(mockReleaseRunLease).toHaveBeenCalledWith(
      expect.objectContaining({ status: "failed" }),
    );
  });

  it("keeps the host response shape for a request with no environmentId", async () => {
    const probe = vi.fn().mockResolvedValue({ provider: "openai", ok: true, windows: [] });
    stubOneCodexAdapter(probe);
    const app = await createApp();

    const res = await request(app).get(`/api/companies/${COMPANY_ID}/costs/quota-windows`);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    // No environment selected: the adapter probes the host with no target arg.
    expect(probe).toHaveBeenCalledTimes(1);
    expect(probe.mock.calls[0]).toHaveLength(0);
    expect(mockEnvironmentService.getById).not.toHaveBeenCalled();
    expect(mockEnvironmentRuntime.acquireRunLease).not.toHaveBeenCalled();
    expect(res.body).toEqual([{ provider: "openai", ok: true, windows: [] }]);
  });

  it("returns 404 for an unknown company", async () => {
    mockCompanyService.getById.mockResolvedValue(null);
    stubOneCodexAdapter(vi.fn());
    const app = await createApp();

    const res = await request(app).get(`/api/companies/${COMPANY_ID}/costs/quota-windows`);

    expect(res.status).toBe(404);
  });
});
