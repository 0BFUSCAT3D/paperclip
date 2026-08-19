import type { Db } from "@paperclipai/db";
import { createGitHubExternalObjectProvider } from "./github-external-object-provider.js";

export type GitHubPullRequestReference = {
  host: "github.com";
  owner: string;
  repo: string;
  number: number;
};

export type GitHubRepositoryReference = {
  owner: string;
  repo: string;
};

export type PullRequestMergeState = "merged" | "open" | "closed" | "unknown";

export type PullRequestMergeDetails = {
  state: PullRequestMergeState;
  headRef: string | null;
  headSha: string | null;
  headRepositoryFullName?: string | null;
};

export type PullRequestMergeStateResolver = (
  companyId: string,
  reference: GitHubPullRequestReference,
) => Promise<PullRequestMergeState>;

export type PullRequestMergeDetailsResolver = (
  companyId: string,
  reference: GitHubPullRequestReference,
) => Promise<PullRequestMergeDetails>;

export const PULL_REQUEST_CACHE_MAX_ENTRIES = 1_000;

export function setBoundedPullRequestCacheEntry<T>(
  cache: Map<string, T>,
  key: string,
  value: T,
) {
  cache.delete(key);
  while (cache.size >= PULL_REQUEST_CACHE_MAX_ENTRIES) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey === undefined) break;
    cache.delete(oldestKey);
  }
  cache.set(key, value);
}

const GITHUB_PULL_REQUEST_URL_PATTERN = /https:\/\/(?:www\.)?github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/([1-9][0-9]*)/gi;
const GITHUB_PULL_REQUEST_SHORTHAND_PATTERN = /(^|[^A-Za-z0-9_.-])([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#([1-9][0-9]*)\b/g;
const GITHUB_REPOSITORY_URL_PATTERN = /^(?:https?:\/\/(?:www\.)?github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/i;

export function parseGitHubRepositoryReference(repoUrl: string | null | undefined): GitHubRepositoryReference | null {
  if (!repoUrl) return null;
  const match = GITHUB_REPOSITORY_URL_PATTERN.exec(repoUrl.trim());
  if (!match) return null;
  return { owner: match[1]!.toLowerCase(), repo: match[2]!.toLowerCase() };
}

function addPullRequestReference(
  references: Map<string, GitHubPullRequestReference>,
  owner: string,
  repo: string,
  rawNumber: string,
) {
  const number = Number(rawNumber);
  if (!Number.isSafeInteger(number) || number <= 0) return;
  const reference = { host: "github.com", owner, repo, number } as const;
  const key = `${owner.toLowerCase()}/${repo.toLowerCase()}#${number}`;
  if (!references.has(key)) references.set(key, reference);
}

export function extractGitHubPullRequestReferences(values: readonly unknown[]) {
  const references = new Map<string, GitHubPullRequestReference>();
  for (const value of values) {
    if (typeof value !== "string" || value.length === 0) continue;
    GITHUB_PULL_REQUEST_URL_PATTERN.lastIndex = 0;
    for (const match of value.matchAll(GITHUB_PULL_REQUEST_URL_PATTERN)) {
      addPullRequestReference(references, match[1]!, match[2]!, match[3]!);
    }
    GITHUB_PULL_REQUEST_SHORTHAND_PATTERN.lastIndex = 0;
    for (const match of value.matchAll(GITHUB_PULL_REQUEST_SHORTHAND_PATTERN)) {
      addPullRequestReference(references, match[2]!, match[3]!, match[4]!);
    }
  }
  return [...references.values()];
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function createPullRequestMergeDetailsResolver(db: Db): PullRequestMergeDetailsResolver {
  const resolver = createGitHubExternalObjectProvider(db).resolvers
    .find((candidate) => candidate.objectType === "pull_request") ?? null;

  return async (companyId, reference) => {
    if (!resolver) return { state: "unknown", headRef: null, headSha: null };
    const result = await resolver.resolve({
      companyId,
      object: {
        externalId: `${reference.owner}/${reference.repo}#pull/${reference.number}`,
        sanitizedCanonicalUrl: `https://github.com/${reference.owner}/${reference.repo}/pull/${reference.number}`,
      } as never,
    });
    if (!result.ok) return { state: "unknown", headRef: null, headSha: null };
    const data = readRecord(result.snapshot.data);
    const state = result.snapshot.statusKey === "merged" || data?.merged === true
      ? "merged"
      : result.snapshot.statusKey === "open" && data?.state === "open"
        ? "open"
        : result.snapshot.statusKey === "closed" || data?.state === "closed"
          ? "closed"
          : "unknown";
    return {
      state,
      headRef: typeof data?.headRef === "string" ? data.headRef : null,
      headSha: typeof data?.headSha === "string" ? data.headSha : null,
      headRepositoryFullName: typeof data?.headRepositoryFullName === "string"
        ? data.headRepositoryFullName
        : null,
    };
  };
}

export function createPullRequestMergeStateResolver(db: Db): PullRequestMergeStateResolver {
  const resolveDetails = createPullRequestMergeDetailsResolver(db);
  return async (companyId, reference) => (await resolveDetails(companyId, reference)).state;
}
