import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { PAPERCLIP_CAPABILITIES_V1 } from "@paperclipai/shared";
import { errorHandler } from "../middleware/index.js";
import { capabilityRoutes } from "../routes/capabilities.js";

function appForActor(actor: unknown) {
  const app = express();
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api/capabilities", capabilityRoutes());
  app.use(errorHandler);
  return app;
}

describe("GET /api/capabilities", () => {
  it("returns the exact versioned execution-governance contract to authenticated actors", async () => {
    const response = await request(appForActor({
      type: "agent",
      agentId: "11111111-1111-4111-8111-111111111111",
      companyId: "22222222-2222-4222-8222-222222222222",
      runId: null,
    })).get("/api/capabilities");

    expect(response.status).toBe(200);
    expect(response.body).toEqual(PAPERCLIP_CAPABILITIES_V1);
  });

  it("does not expose the contract to anonymous callers", async () => {
    const response = await request(appForActor({ type: "none" })).get("/api/capabilities");
    expect(response.status).toBe(403);
  });
});
