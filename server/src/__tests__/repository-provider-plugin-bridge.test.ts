import { randomUUID } from "node:crypto";
import { describe } from "vitest";
import type { RepositoryConnection } from "@paperclipai/shared";
import type { HostToWorkerMethodName } from "@paperclipai/plugin-sdk";
import { FakeRepositoryProvider } from "../services/repository-providers/index.js";
import { createPluginRepositoryProviderConnector } from "../services/repository-providers/plugin-connector.js";
import {
  runProviderConformance,
  type ProviderConformanceWorld,
} from "./helpers/repository-provider-conformance.js";

/**
 * Parity check for the extension seam: the exact conformance suite the
 * in-process GitHub.com provider passes is run against a provider reached over
 * the plugin worker RPCs. If the wire contract loses a guarantee — a dropped
 * cursor, a Date that never round-trips, an error that stops rejecting — this
 * fails, so an EE package cannot be blocked by a seam that only looks complete.
 *
 * The fake "worker" marshals the wire payloads to the in-memory reference
 * provider, standing in for a real extension's `onRepositoryProvider*` hooks.
 */

const HOST = "github.acme-corp.example";
const PROVIDER = "github-enterprise";

function connectionFromSnapshot(snapshot: {
  id: string;
  companyId: string;
  provider: string;
  host: string;
  installationId: string | null;
  accountId: string | null;
  accountName: string | null;
  syncCursor: string | null;
  providerMetadata: Record<string, unknown> | null;
}): RepositoryConnection {
  const now = new Date();
  return {
    id: snapshot.id,
    companyId: snapshot.companyId,
    provider: snapshot.provider,
    host: snapshot.host,
    installationId: snapshot.installationId,
    accountId: snapshot.accountId,
    accountName: snapshot.accountName,
    status: "active",
    syncStatus: "idle",
    syncCursor: snapshot.syncCursor,
    syncError: null,
    lastSyncedAt: null,
    providerMetadata: snapshot.providerMetadata,
    disconnectedAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

function bridgedWorld(): ProviderConformanceWorld {
  const provider = new FakeRepositoryProvider({ provider: PROVIDER, host: HOST, pageSize: 2 });
  const reference = provider.connector();
  const companyId = randomUUID();
  const userId = randomUUID();
  const installationId = `install-${randomUUID().slice(0, 8)}`;
  const accountName = "acme";

  provider.setInstallation({ installationId, accountId: "account-1", accountName, repositories: [] });

  // Stands in for a plugin worker: JSON-shaped params in, JSON-shaped results
  // out, with every Date crossing the boundary as an ISO-8601 string.
  const workerManager = {
    isRunning: () => true,
    call: (async (_pluginId: string, method: HostToWorkerMethodName, params: never) => {
      const input = params as Record<string, never>;
      switch (method) {
        case "repositoryProviderBeginInstallation": {
          const result = await reference.beginInstallation({
            companyId: input.companyId,
            userId: input.userId,
            redirectPath: input.redirectPath ?? null,
          });
          return { ...result, expiresAt: result.expiresAt.toISOString() };
        }
        case "repositoryProviderCompleteInstallation":
          return await reference.completeInstallation({
            state: input.state,
            installationId: input.installationId,
            companyId: input.companyId,
          });
        case "repositoryProviderDiscover":
          return await reference.discover({
            connection: connectionFromSnapshot(input.connection),
            query: input.query ?? null,
            cursor: input.cursor ?? null,
            pageSize: input.pageSize,
          });
        case "repositoryProviderRefreshMetadata":
          return {
            repository: await reference.refreshMetadata({
              connection: connectionFromSnapshot(input.connection),
              providerRepositoryId: input.providerRepositoryId,
            }),
          };
        case "repositoryProviderSync":
          return await reference.sync({
            connection: connectionFromSnapshot(input.connection),
            cursor: input.cursor ?? null,
          });
        case "repositoryProviderDisconnect":
          await reference.disconnect?.({ connection: connectionFromSnapshot(input.connection) });
          return undefined;
        case "repositoryProviderResolveCloneCredential": {
          const result = await reference.resolveCloneCredential({
            connection: connectionFromSnapshot(input.connection),
            repository: input.repository,
          });
          return {
            username: result.username,
            token: result.token,
            authenticatedCloneUrl: result.authenticatedCloneUrl,
            expiresAt: result.expiresAt.toISOString(),
            audit: { installationId: result.audit.installationId },
          };
        }
        default:
          throw new Error(`unexpected worker method ${method}`);
      }
    }) as never,
  };

  const connector = createPluginRepositoryProviderConnector({
    pluginId: randomUUID(),
    pluginKey: "acme.github-enterprise",
    declaration: { providerKey: PROVIDER, displayName: "GitHub Enterprise", host: HOST },
    workerManager,
  });

  return {
    connector,
    companyId,
    userId,
    installationId,
    accountName,
    seed(repos) {
      provider.setInstallation({
        installationId,
        accountId: "account-1",
        accountName,
        repositories: repos.map((repo) => ({ ...repo })),
      });
    },
    rename(providerRepositoryId, next) {
      provider.rename(installationId, providerRepositoryId, next);
    },
  };
}

describe("plugin-bridged repository provider conformance", () => {
  runProviderConformance(bridgedWorld);
});
