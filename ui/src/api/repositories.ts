import type {
  AgentRepositoryGrantEntry,
  CreateManualRepository,
  CreateRepositoryConnection,
  EffectiveRepositoryAccess,
  ProjectRepositoryEntry,
  Repository,
  RepositoryCatalogItem,
  RepositoryConnection,
  UpdateRepository,
} from "@paperclipai/shared";
import { api } from "./client";

export const repositoriesApi = {
  list: (companyId: string, opts: { includeArchived?: boolean } = {}) =>
    api.get<RepositoryCatalogItem[]>(
      `/companies/${encodeURIComponent(companyId)}/repositories${opts.includeArchived ? "?includeArchived=true" : ""}`,
    ),
  get: (repositoryId: string) => api.get<Repository>(`/repositories/${encodeURIComponent(repositoryId)}`),
  createManual: (companyId: string, input: CreateManualRepository) =>
    api.post<Repository>(`/companies/${encodeURIComponent(companyId)}/repositories`, input),
  update: (repositoryId: string, input: UpdateRepository) =>
    api.patch<Repository>(`/repositories/${encodeURIComponent(repositoryId)}`, input),
  archive: (repositoryId: string) =>
    api.delete<Repository>(`/repositories/${encodeURIComponent(repositoryId)}`),

  listConnections: (companyId: string) =>
    api.get<RepositoryConnection[]>(`/companies/${encodeURIComponent(companyId)}/repository-connections`),
  getConnection: (connectionId: string) =>
    api.get<RepositoryConnection>(`/repository-connections/${encodeURIComponent(connectionId)}`),
  createConnection: (companyId: string, input: CreateRepositoryConnection) =>
    api.post<RepositoryConnection>(
      `/companies/${encodeURIComponent(companyId)}/repository-connections`,
      input,
    ),
  syncConnection: (connectionId: string) =>
    api.post<{ connection: RepositoryConnection; repositories: Repository[] }>(
      `/repository-connections/${encodeURIComponent(connectionId)}/sync`,
      {},
    ),
  disconnectConnection: (connectionId: string) =>
    api.delete<{ connection: RepositoryConnection; repositories: Repository[] }>(
      `/repository-connections/${encodeURIComponent(connectionId)}`,
    ),

  listProjectRepositories: (projectId: string) =>
    api.get<ProjectRepositoryEntry[]>(`/projects/${encodeURIComponent(projectId)}/repositories`),
  attachProjectRepository: (projectId: string, repositoryId: string, displayOrder = 0) =>
    api.put<ProjectRepositoryEntry>(
      `/projects/${encodeURIComponent(projectId)}/repositories/${encodeURIComponent(repositoryId)}`,
      { displayOrder },
    ),
  detachProjectRepository: (projectId: string, repositoryId: string) =>
    api.delete<{ removed: boolean }>(
      `/projects/${encodeURIComponent(projectId)}/repositories/${encodeURIComponent(repositoryId)}`,
    ),

  listDirectAgentGrants: (agentId: string) =>
    api.get<AgentRepositoryGrantEntry[]>(`/agents/${encodeURIComponent(agentId)}/repositories`),
  listEffectiveAgentRepositories: (agentId: string) =>
    api.get<EffectiveRepositoryAccess[]>(`/agents/${encodeURIComponent(agentId)}/repositories?effective=true`),
  grantAgentRepository: (agentId: string, repositoryId: string) =>
    api.put<AgentRepositoryGrantEntry>(
      `/agents/${encodeURIComponent(agentId)}/repositories/${encodeURIComponent(repositoryId)}`,
      {},
    ),
  revokeAgentRepository: (agentId: string, repositoryId: string) =>
    api.delete<{ removed: boolean }>(
      `/agents/${encodeURIComponent(agentId)}/repositories/${encodeURIComponent(repositoryId)}`,
    ),
};
