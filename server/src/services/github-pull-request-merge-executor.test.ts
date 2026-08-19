import { describe, expect, it, vi } from "vitest";
import { createGitHubPullRequestMergeExecutor } from "./github-pull-request-merge-executor.js";

const reference = {
  host: "github.com" as const,
  owner: "paperclipai",
  repo: "paperclip",
  number: 42,
};
const headSha = "a".repeat(40);
const observedAt = new Date("2026-08-19T12:00:00.000Z");

describe("GitHub pull request merge executor", () => {
  it("uses GitHub's exact-head CAS and fixed merge method", async () => {
    const events: string[] = [];
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) => {
      events.push("response");
      return new Response(JSON.stringify({
      sha: "b".repeat(40),
      merged: true,
      message: "Pull Request successfully merged",
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const execute = createGitHubPullRequestMergeExecutor({} as never, {
      fetch,
      tokenProvider: () => "secret-token",
      now: () => {
        events.push("observed");
        return observedAt;
      },
    });

    await expect(execute({ companyId: "company-1", reference, expectedHeadSha: headSha })).resolves.toEqual({
      ok: true,
      kind: "merged",
      provider: "github",
      mergeMethod: "merge",
      mergeCommitSha: "b".repeat(40),
      providerObservedAt: observedAt.toISOString(),
    });
    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("https://api.github.com/repos/paperclipai/paperclip/pulls/42/merge");
    expect(init).toMatchObject({
      method: "PUT",
      body: JSON.stringify({ sha: headSha, merge_method: "merge" }),
      headers: expect.objectContaining({
        authorization: "Bearer secret-token",
        "x-github-api-version": "2022-11-28",
      }),
    });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(events).toEqual(["response", "observed"]);
  });

  it("normalizes provider conflicts without exposing response bodies or credentials", async () => {
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({
      message: "secret-token and provider internals must not escape",
    }), { status: 409 }));
    const execute = createGitHubPullRequestMergeExecutor({} as never, {
      fetch,
      tokenProvider: () => "secret-token",
      now: () => observedAt,
    });

    const outcome = await execute({ companyId: "company-1", reference, expectedHeadSha: headSha });
    expect(outcome).toEqual({
      ok: false,
      kind: "head_mismatch",
      provider: "github",
      mergeMethod: "merge",
      httpStatus: 409,
      retryable: false,
      providerObservedAt: observedAt.toISOString(),
    });
    expect(JSON.stringify(outcome)).not.toContain("secret-token");
    expect(JSON.stringify(outcome)).not.toContain("provider internals");
  });

  it("fails closed before a request when a credential is unavailable", async () => {
    const fetch = vi.fn();
    const execute = createGitHubPullRequestMergeExecutor({} as never, {
      fetch,
      tokenProvider: () => null,
      now: () => observedAt,
    });

    await expect(execute({ companyId: "company-1", reference, expectedHeadSha: headSha })).resolves.toMatchObject({
      ok: false,
      kind: "auth_required",
      httpStatus: null,
      retryable: false,
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects invalid GitHub identities and revisions before resolving credentials", async () => {
    const tokenProvider = vi.fn(() => "secret-token");
    const execute = createGitHubPullRequestMergeExecutor({} as never, {
      tokenProvider,
      now: () => observedAt,
    });

    await expect(execute({
      companyId: "company-1",
      reference: { ...reference, owner: "../escape" },
      expectedHeadSha: headSha,
    })).resolves.toMatchObject({ ok: false, kind: "invalid_request" });
    expect(tokenProvider).not.toHaveBeenCalled();
  });

  it("aborts a bounded merge request and timestamps the observed timeout afterward", async () => {
    const events: string[] = [];
    let requestSignal: AbortSignal | undefined;
    const fetch = vi.fn((_url: string, init?: RequestInit) => {
      requestSignal = init?.signal ?? undefined;
      return new Promise<Response>(() => undefined);
    });
    const execute = createGitHubPullRequestMergeExecutor({} as never, {
      fetch,
      tokenProvider: () => "timeout-secret",
      timeoutMs: 1,
      now: () => {
        events.push(requestSignal?.aborted ? "observed-after-abort" : "observed-before-abort");
        return observedAt;
      },
    });

    const outcome = await execute({ companyId: "company-1", reference, expectedHeadSha: headSha });
    expect(outcome).toEqual({
      ok: false,
      kind: "timed_out",
      provider: "github",
      mergeMethod: "merge",
      httpStatus: null,
      retryable: true,
      providerObservedAt: observedAt.toISOString(),
    });
    expect(requestSignal?.aborted).toBe(true);
    expect(events).toEqual(["observed-after-abort"]);
    expect(JSON.stringify(outcome)).not.toContain("timeout-secret");
  });
});
