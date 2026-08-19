import { Router } from "express";
import { PAPERCLIP_CAPABILITIES_V1 } from "@paperclipai/shared";
import { assertBoardOrAgent } from "./authz.js";

export function capabilityRoutes() {
  const router = Router();

  router.get("/", (req, res) => {
    assertBoardOrAgent(req);
    res.json(PAPERCLIP_CAPABILITIES_V1);
  });

  return router;
}
