import type { Db } from "@paperclipai/db";
import { DEFAULT_GITHUB_TOKEN_SECRET_NAMES } from "./git-credentials.js";
import { ghFetch } from "./github-fetch.js";
import { secretService } from "./secrets.js";
import type { GitHubPullRequestReference } from "./github-pull-request-merge.js";

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export type GitHubPullRequestMergeFailureKind =
  | "invalid_request"
  | "auth_required"
  | "forbidden"
  | "not_found"
  | "head_mismatch"
  | "not_mergeable"
  | "rate_limited"
  | "timed_out"
  | "provider_unavailable"
  | "invalid_response";

export type GitHubPullRequestMergeOutcome =
  | {
      ok: true;
      kind: "merged";
      provider: "github";
      mergeMethod: "merge";
      mergeCommitSha: string;
      providerObservedAt: string;
    }
  | {
      ok: false;
      kind: GitHubPullRequestMergeFailureKind;
      provider: "github";
      mergeMethod: "merge";
      httpStatus: number | null;
      retryable: boolean;
      providerObservedAt: string;
    };

export type GitHubPullRequestMergeExecutor = (input: {
  companyId: string;
  reference: GitHubPullRequestReference;
  expectedHeadSha: string;
}) => Promise<GitHubPullRequestMergeOutcome>;

export interface GitHubPullRequestMergeExecutorOptions {
  fetch?: FetchLike;
  tokenProvider?: (companyId: string) => Promise<string | null> | string | null;
  secretNames?: readonly string[];
  now?: () => Date;
  timeoutMs?: number;
}

const GITHUB_NAME_PATTERN = /^[A-Za-z0-9_.-]+$/;
const GIT_REVISION_PATTERN = /^[0-9a-f]{40,64}$/;
export const GITHUB_PULL_REQUEST_MERGE_TIMEOUT_DEFAULT_MS = 15_000;
export const GITHUB_PULL_REQUEST_MERGE_TIMEOUT_MIN_MS = 1;
export const GITHUB_PULL_REQUEST_MERGE_TIMEOUT_MAX_MS = 120_000;
const MERGE_TIMEOUT = Symbol("github_pull_request_merge_timeout");

function boundedTimeoutMs(value: number | undefined) {
  if (value === undefined || !Number.isFinite(value)) return GITHUB_PULL_REQUEST_MERGE_TIMEOUT_DEFAULT_MS;
  return Math.min(
    GITHUB_PULL_REQUEST_MERGE_TIMEOUT_MAX_MS,
    Math.max(GITHUB_PULL_REQUEST_MERGE_TIMEOUT_MIN_MS, Math.floor(value)),
  );
}

async function resolveCompanyGitHubToken(db: Db, companyId: string, secretNames: readonly string[]) {
  const secrets = secretService(db);
  for (const secretName of secretNames) {
    const secret = await secrets.getByName(companyId, secretName);
    if (!secret) continue;
    const value = (await secrets.resolveSecretValue(companyId, secret.id, "latest")).trim();
    if (value) return value;
  }
  return null;
}

function failure(
  kind: GitHubPullRequestMergeFailureKind,
  observedAt: string,
  httpStatus: number | null,
  retryable: boolean,
): GitHubPullRequestMergeOutcome {
  return {
    ok: false,
    kind,
    provider: "github",
    mergeMethod: "merge",
    httpStatus,
    retryable,
    providerObservedAt: observedAt,
  };
}

function parseMergeCommitSha(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const sha = (value as Record<string, unknown>).sha;
  return typeof sha === "string" && GIT_REVISION_PATTERN.test(sha.toLowerCase())
    ? sha.toLowerCase()
    : null;
}

/**
 * Executes the sole supported provider mutation for Ship. The expected head is
 * sent as GitHub's `sha` precondition and the merge method cannot be overridden.
 * Outcomes are deliberately closed and sanitized: response bodies, credential
 * values, provider messages, and request headers never cross this seam.
 */
export function createGitHubPullRequestMergeExecutor(
  db: Db,
  options: GitHubPullRequestMergeExecutorOptions = {},
): GitHubPullRequestMergeExecutor {
  const fetchImpl = options.fetch ?? ghFetch;
  const secretNames = options.secretNames ?? DEFAULT_GITHUB_TOKEN_SECRET_NAMES;
  const tokenProvider = options.tokenProvider ?? ((companyId: string) =>
    resolveCompanyGitHubToken(db, companyId, secretNames));
  const now = options.now ?? (() => new Date());
  const timeoutMs = boundedTimeoutMs(options.timeoutMs);

  return async ({ companyId, reference, expectedHeadSha }) => {
    const observedAt = () => now().toISOString();
    const normalizedHeadSha = expectedHeadSha.trim().toLowerCase();
    if (
      reference.host !== "github.com"
      || !GITHUB_NAME_PATTERN.test(reference.owner)
      || !GITHUB_NAME_PATTERN.test(reference.repo)
      || !Number.isSafeInteger(reference.number)
      || reference.number <= 0
      || !GIT_REVISION_PATTERN.test(normalizedHeadSha)
    ) {
      return failure("invalid_request", observedAt(), null, false);
    }

    let token: string | null;
    try {
      token = (await tokenProvider(companyId))?.trim() || null;
    } catch {
      return failure("auth_required", observedAt(), null, false);
    }
    if (!token) return failure("auth_required", observedAt(), null, false);

    let response: Response;
    const controller = new AbortController();
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<never>((_resolve, reject) => {
      timeoutHandle = setTimeout(() => {
        controller.abort();
        reject(MERGE_TIMEOUT);
      }, timeoutMs);
    });
    try {
      response = await Promise.race([
        fetchImpl(
          `https://api.github.com/repos/${encodeURIComponent(reference.owner)}/${encodeURIComponent(reference.repo)}/pulls/${reference.number}/merge`,
          {
            method: "PUT",
            headers: {
              accept: "application/vnd.github+json",
              authorization: `Bearer ${token}`,
              "content-type": "application/json",
              "user-agent": "paperclip-artifact-director-ship",
              "x-github-api-version": "2022-11-28",
            },
            body: JSON.stringify({
              sha: normalizedHeadSha,
              merge_method: "merge",
            }),
            signal: controller.signal,
          },
        ),
        timeout,
      ]);
    } catch (error) {
      return failure(
        error === MERGE_TIMEOUT || controller.signal.aborted ? "timed_out" : "provider_unavailable",
        observedAt(),
        null,
        true,
      );
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }

    if (response.ok) {
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        return failure("invalid_response", observedAt(), response.status, true);
      }
      const mergeCommitSha = parseMergeCommitSha(body);
      if (!mergeCommitSha || (body as Record<string, unknown>).merged !== true) {
        return failure("invalid_response", observedAt(), response.status, true);
      }
      return {
        ok: true,
        kind: "merged",
        provider: "github",
        mergeMethod: "merge",
        mergeCommitSha,
        providerObservedAt: observedAt(),
      };
    }

    if (response.status === 401) return failure("auth_required", observedAt(), 401, false);
    if (response.status === 403) {
      return response.headers.get("x-ratelimit-remaining") === "0"
        ? failure("rate_limited", observedAt(), 403, true)
        : failure("forbidden", observedAt(), 403, false);
    }
    if (response.status === 404) return failure("not_found", observedAt(), 404, false);
    if (response.status === 409) return failure("head_mismatch", observedAt(), 409, false);
    if (response.status === 405) return failure("not_mergeable", observedAt(), 405, false);
    if (response.status === 422) return failure("invalid_request", observedAt(), 422, false);
    if (response.status === 429) return failure("rate_limited", observedAt(), 429, true);
    if (response.status >= 500) return failure("provider_unavailable", observedAt(), response.status, true);
    return failure("invalid_response", observedAt(), response.status, false);
  };
}
