import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGetExperimental = vi.hoisted(() => vi.fn());
const mockIssueService = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  addComment: vi.fn(),
  listComments: vi.fn(),
}));
const mockSpawn = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  instanceSettingsService: () => ({ getExperimental: mockGetExperimental }),
  issueService: () => mockIssueService,
}));

vi.mock("node:child_process", () => ({ spawn: mockSpawn }));

async function createApp(actor: Express.Request["actor"]) {
  const [{ errorHandler }, { boardChatRoutes }] = await Promise.all([
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
    vi.importActual<typeof import("../routes/board-chat.js")>("../routes/board-chat.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use(
    "/api",
    boardChatRoutes({} as any, {
      deploymentMode: "authenticated",
      deploymentExposure: "private",
    }),
  );
  app.use(errorHandler);
  return app;
}

describe("board-chat authz boundary", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../routes/board-chat.js");
    vi.doUnmock("../middleware/index.js");
    vi.clearAllMocks();
    mockGetExperimental.mockResolvedValue({ enableConferenceRoomChat: true });
  });

  it("rejects agent-authenticated callers before any host process is spawned", async () => {
    const app = await createApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      source: "agent_key",
    });

    const res = await request(app)
      .post("/api/board/chat/stream")
      .send({ companyId: "company-1", message: "hello" });

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "Board access required" });
    expect(mockSpawn).not.toHaveBeenCalled();
    expect(mockIssueService.addComment).not.toHaveBeenCalled();
    expect(mockIssueService.create).not.toHaveBeenCalled();
  });

  it("rejects non-instance-admin board users before any host process is spawned", async () => {
    const app = await createApp({
      type: "board",
      userId: "user-1",
      source: "session",
      isInstanceAdmin: false,
      companyIds: ["company-1"],
      memberships: [
        { companyId: "company-1", membershipRole: "operator", status: "active" },
      ],
    });

    const res = await request(app)
      .post("/api/board/chat/stream")
      .send({ companyId: "company-1", message: "hello" });

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "Instance admin access required" });
    expect(mockSpawn).not.toHaveBeenCalled();
    expect(mockIssueService.addComment).not.toHaveBeenCalled();
    expect(mockIssueService.create).not.toHaveBeenCalled();
  });

  it("rejects instance admins without access to the requested company", async () => {
    const app = await createApp({
      type: "board",
      userId: "admin-1",
      source: "session",
      isInstanceAdmin: true,
      companyIds: [],
      memberships: [],
    });

    const res = await request(app)
      .post("/api/board/chat/stream")
      .send({ companyId: "company-1", message: "hello" });

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "User does not have access to this company" });
    expect(mockSpawn).not.toHaveBeenCalled();
    expect(mockIssueService.addComment).not.toHaveBeenCalled();
    expect(mockIssueService.create).not.toHaveBeenCalled();
  });
});
