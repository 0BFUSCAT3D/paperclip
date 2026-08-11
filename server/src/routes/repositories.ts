import { eq } from "drizzle-orm";
import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import { agents, projects } from "@paperclipai/db";
import {
  attachProjectRepositorySchema,
  createManualRepositorySchema,
  createRepositoryConnectionSchema,
  grantAgentRepositorySchema,
  updateRepositorySchema,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import {
  accessService,
  logActivity,
  repositoryAccessService,
  repositoryConnectionService,
  repositoryService,
} from "../services/index.js";
import { assertBoard, assertCompanyAccess, getAccessibleResource, getActorInfo } from "./authz.js";

function activityActor(req: Request) {
  const actor = getActorInfo(req);
  return {
    actor,
    attribution: {
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      agentApiKeyId: actor.agentApiKeyId,
    },
  };
}

export function repositoryRoutes(db: Db) {
  const router = Router();
  const repositories = repositoryService(db);
  const connections = repositoryConnectionService(db);
  const repositoryAccess = repositoryAccessService(db);
  const access = accessService(db);

  router.get("/companies/:companyId/repositories", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await repositories.list(companyId, { includeArchived: req.query.includeArchived === "true" }));
  });

  router.post(
    "/companies/:companyId/repositories",
    validate(createManualRepositorySchema),
    async (req, res) => {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const result = await repositories.createManual(companyId, req.body);
      const { attribution } = activityActor(req);
      if (result.created) {
        await logActivity(db, {
          companyId,
          ...attribution,
          action: "repository.created",
          entityType: "repository",
          entityId: result.repository.id,
          details: {
            provider: result.repository.provider,
            host: result.repository.host,
            owner: result.repository.owner,
            name: result.repository.name,
          },
        });
      }
      res.status(result.created ? 201 : 200).json(result.repository);
    },
  );

  router.get("/repositories/:repositoryId", async (req, res) => {
    assertBoard(req);
    const repository = await getAccessibleResource(
      req,
      res,
      repositories.getById(req.params.repositoryId as string),
      "Repository not found",
    );
    if (!repository) return;
    res.json(repository);
  });

  router.patch("/repositories/:repositoryId", validate(updateRepositorySchema), async (req, res) => {
    assertBoard(req);
    const repositoryId = req.params.repositoryId as string;
    const existing = await getAccessibleResource(req, res, repositories.getById(repositoryId), "Repository not found");
    if (!existing) return;
    const updated = await repositories.update(existing.companyId, repositoryId, req.body);
    if (!updated) {
      res.status(404).json({ error: "Repository not found" });
      return;
    }
    const { attribution } = activityActor(req);
    await logActivity(db, {
      companyId: existing.companyId,
      ...attribution,
      action: "repository.updated",
      entityType: "repository",
      entityId: repositoryId,
      details: { changedKeys: Object.keys(req.body).sort() },
    });
    res.json(updated);
  });

  router.delete("/repositories/:repositoryId", async (req, res) => {
    assertBoard(req);
    const repositoryId = req.params.repositoryId as string;
    const existing = await getAccessibleResource(req, res, repositories.getById(repositoryId), "Repository not found");
    if (!existing) return;
    const archived = await repositories.archive(existing.companyId, repositoryId);
    const { attribution } = activityActor(req);
    await logActivity(db, {
      companyId: existing.companyId,
      ...attribution,
      action: "repository.archived",
      entityType: "repository",
      entityId: repositoryId,
      details: { retainedRelationships: true },
    });
    res.json(archived);
  });

  router.get("/companies/:companyId/repository-connections", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await connections.list(companyId));
  });

  router.post(
    "/companies/:companyId/repository-connections",
    validate(createRepositoryConnectionSchema),
    async (req, res) => {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const result = await connections.create(companyId, req.body);
      const { attribution } = activityActor(req);
      if (result.created) {
        await logActivity(db, {
          companyId,
          ...attribution,
          action: "repository_connection.created",
          entityType: "repository_connection",
          entityId: result.connection.id,
          details: { provider: result.connection.provider, host: result.connection.host },
        });
      }
      res.status(result.created ? 201 : 200).json(result.connection);
    },
  );

  router.get("/repository-connections/:connectionId", async (req, res) => {
    assertBoard(req);
    const connection = await getAccessibleResource(
      req,
      res,
      connections.getById(req.params.connectionId as string),
      "Repository connection not found",
    );
    if (!connection) return;
    res.json(connection);
  });

  router.post("/repository-connections/:connectionId/sync", async (req, res) => {
    assertBoard(req);
    const connectionId = req.params.connectionId as string;
    const existing = await getAccessibleResource(
      req,
      res,
      connections.getById(connectionId),
      "Repository connection not found",
    );
    if (!existing) return;
    const { attribution } = activityActor(req);
    try {
      const result = await connections.sync(existing.companyId, connectionId);
      await logActivity(db, {
        companyId: existing.companyId,
        ...attribution,
        action: "repository_connection.synced",
        entityType: "repository_connection",
        entityId: connectionId,
        details: { repositoryCount: result?.repositories.length ?? 0 },
      });
      res.json(result);
    } catch (error) {
      await logActivity(db, {
        companyId: existing.companyId,
        ...attribution,
        action: "repository_connection.sync_failed",
        entityType: "repository_connection",
        entityId: connectionId,
        details: { provider: existing.provider, status: "failed" },
      });
      throw error;
    }
  });

  router.delete("/repository-connections/:connectionId", async (req, res) => {
    assertBoard(req);
    const connectionId = req.params.connectionId as string;
    const existing = await getAccessibleResource(
      req,
      res,
      connections.getById(connectionId),
      "Repository connection not found",
    );
    if (!existing) return;
    const { attribution } = activityActor(req);
    try {
      const result = await connections.disconnect(existing.companyId, connectionId);
      await logActivity(db, {
        companyId: existing.companyId,
        ...attribution,
        action: "repository_connection.disconnected",
        entityType: "repository_connection",
        entityId: connectionId,
        details: { unavailableRepositoryCount: result?.repositories.length ?? 0 },
      });
      res.json(result);
    } catch (error) {
      await logActivity(db, {
        companyId: existing.companyId,
        ...attribution,
        action: "repository_connection.disconnect_failed",
        entityType: "repository_connection",
        entityId: connectionId,
        details: { provider: existing.provider, status: "failed" },
      });
      throw error;
    }
  });

  router.get("/projects/:projectId/repositories", async (req, res) => {
    const projectId = req.params.projectId as string;
    const project = await getAccessibleResource(
      req,
      res,
      db.select({ id: projects.id, companyId: projects.companyId }).from(projects).where(eq(projects.id, projectId)).then((rows) => rows[0] ?? null),
      "Project not found",
    );
    if (!project) return;
    const decision = await access.decide({
      actor: req.actor,
      action: "project:read",
      resource: { type: "project", companyId: project.companyId, projectId },
    });
    if (!decision.allowed) {
      res.status(403).json({ error: "Project is outside this actor's authorization boundary" });
      return;
    }
    res.json(await repositoryAccess.listProjectRepositories(project.companyId, projectId));
  });

  router.put(
    "/projects/:projectId/repositories/:repositoryId",
    validate(attachProjectRepositorySchema),
    async (req, res) => {
      assertBoard(req);
      const projectId = req.params.projectId as string;
      const repositoryId = req.params.repositoryId as string;
      const project = await getAccessibleResource(
        req,
        res,
        db.select({ id: projects.id, companyId: projects.companyId }).from(projects).where(eq(projects.id, projectId)).then((rows) => rows[0] ?? null),
        "Project not found",
      );
      if (!project) return;
      const { actor, attribution } = activityActor(req);
      const result = await repositoryAccess.attachProjectRepository({
        companyId: project.companyId,
        projectId,
        repositoryId,
        displayOrder: req.body.displayOrder,
        createdByAgentId: actor.actorType === "agent" ? actor.agentId : null,
        createdByUserId: actor.actorType === "user" ? actor.actorId : null,
      });
      if (!result) {
        res.status(404).json({ error: "Repository not found" });
        return;
      }
      if (result.created) {
        await logActivity(db, {
          companyId: project.companyId,
          ...attribution,
          action: "project_repository.attached",
          entityType: "project_repository",
          entityId: result.entry.link.id,
          details: { projectId, repositoryId },
        });
      }
      res.status(result.created ? 201 : 200).json(result.entry);
    },
  );

  router.delete("/projects/:projectId/repositories/:repositoryId", async (req, res) => {
    assertBoard(req);
    const projectId = req.params.projectId as string;
    const repositoryId = req.params.repositoryId as string;
    const project = await getAccessibleResource(
      req,
      res,
      db.select({ id: projects.id, companyId: projects.companyId }).from(projects).where(eq(projects.id, projectId)).then((rows) => rows[0] ?? null),
      "Project not found",
    );
    if (!project) return;
    const result = await repositoryAccess.detachProjectRepository(project.companyId, projectId, repositoryId);
    if (!result) {
      res.status(404).json({ error: "Repository not found" });
      return;
    }
    if (result.removed) {
      const { attribution } = activityActor(req);
      await logActivity(db, {
        companyId: project.companyId,
        ...attribution,
        action: "project_repository.detached",
        entityType: "project_repository",
        entityId: result.link!.id,
        details: { projectId, repositoryId },
      });
    }
    res.json({ removed: result.removed });
  });

  router.get("/agents/:agentId/repositories", async (req, res) => {
    const agentId = req.params.agentId as string;
    const agent = await getAccessibleResource(
      req,
      res,
      db.select({ id: agents.id, companyId: agents.companyId }).from(agents).where(eq(agents.id, agentId)).then((rows) => rows[0] ?? null),
      "Agent not found",
    );
    if (!agent) return;
    const decision = await access.decide({
      actor: req.actor,
      action: "agent:read",
      resource: { type: "agent", companyId: agent.companyId, agentId },
    });
    if (!decision.allowed) {
      res.status(403).json({ error: "Agent is outside this actor's authorization boundary" });
      return;
    }
    if (req.query.effective !== "true") {
      res.json(await repositoryAccess.listDirectGrants(agent.companyId, agentId));
      return;
    }

    const projectAuthorizationActor = req.actor.type === "agent" && req.actor.agentId === agentId
      ? req.actor
      : { type: "agent" as const, agentId, companyId: agent.companyId, source: "agent_key" as const };
    const result = await repositoryAccess.listEffectiveRepositories({
      companyId: agent.companyId,
      agentId,
      canAccessProject: async (project) => (await access.decide({
        actor: projectAuthorizationActor,
        action: "project:read",
        resource: { type: "project", companyId: project.companyId, projectId: project.id },
      })).allowed,
    });
    res.json(result);
  });

  router.put(
    "/agents/:agentId/repositories/:repositoryId",
    validate(grantAgentRepositorySchema),
    async (req, res) => {
      assertBoard(req);
      const agentId = req.params.agentId as string;
      const repositoryId = req.params.repositoryId as string;
      const agent = await getAccessibleResource(
        req,
        res,
        db.select({ id: agents.id, companyId: agents.companyId }).from(agents).where(eq(agents.id, agentId)).then((rows) => rows[0] ?? null),
        "Agent not found",
      );
      if (!agent) return;
      const { actor, attribution } = activityActor(req);
      const result = await repositoryAccess.grantAgentRepository({
        companyId: agent.companyId,
        agentId,
        repositoryId,
        grantedByAgentId: actor.actorType === "agent" ? actor.agentId : null,
        grantedByUserId: actor.actorType === "user" ? actor.actorId : null,
      });
      if (!result) {
        res.status(404).json({ error: "Repository not found" });
        return;
      }
      if (result.created) {
        await logActivity(db, {
          companyId: agent.companyId,
          ...attribution,
          action: "agent_repository.granted",
          entityType: "agent_repository_grant",
          entityId: result.entry.grant.id,
          details: { agentId, repositoryId },
        });
      }
      res.status(result.created ? 201 : 200).json(result.entry);
    },
  );

  router.delete("/agents/:agentId/repositories/:repositoryId", async (req, res) => {
    assertBoard(req);
    const agentId = req.params.agentId as string;
    const repositoryId = req.params.repositoryId as string;
    const agent = await getAccessibleResource(
      req,
      res,
      db.select({ id: agents.id, companyId: agents.companyId }).from(agents).where(eq(agents.id, agentId)).then((rows) => rows[0] ?? null),
      "Agent not found",
    );
    if (!agent) return;
    const result = await repositoryAccess.revokeAgentRepository(agent.companyId, agentId, repositoryId);
    if (!result) {
      res.status(404).json({ error: "Repository not found" });
      return;
    }
    if (result.removed) {
      const { attribution } = activityActor(req);
      await logActivity(db, {
        companyId: agent.companyId,
        ...attribution,
        action: "agent_repository.revoked",
        entityType: "agent_repository_grant",
        entityId: result.grant!.id,
        details: { agentId, repositoryId },
      });
    }
    res.json({ removed: result.removed });
  });

  return router;
}
