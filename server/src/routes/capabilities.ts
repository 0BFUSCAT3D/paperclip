import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { paperclipCapabilitiesV1 } from "@paperclipai/shared";
import { assertBoardOrAgent } from "./authz.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { supportsExactLocalProcessStartIdentity } from "../services/process-start-identity.js";

export function capabilityRoutes(
  db: Db,
  options: {
    readIsolatedWorkspacesEnabled?: () => Promise<boolean>;
    supportsExactProcessStartIdentity?: () => boolean;
  } = {},
) {
  const router = Router();
  const readIsolatedWorkspacesEnabled = options.readIsolatedWorkspacesEnabled
    ?? (async () => (await instanceSettingsService(db).getExperimental()).enableIsolatedWorkspaces === true);
  const supportsExactProcessStartIdentity = options.supportsExactProcessStartIdentity
    ?? supportsExactLocalProcessStartIdentity;

  router.get("/", async (req, res) => {
    assertBoardOrAgent(req);
    const exactProcessStartIdentityAvailable = supportsExactProcessStartIdentity();
    res.json(paperclipCapabilitiesV1({
      enableIsolatedWorkspaces: await readIsolatedWorkspacesEnabled(),
      exactProcessStartIdentityAvailable,
    }));
  });

  return router;
}
