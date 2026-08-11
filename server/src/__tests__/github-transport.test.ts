import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createGitHubAppTransport } from "../services/repository-providers/github-transport.js";
import { makeGitHubRepository } from "./helpers/fake-github-transport.js";

const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ type: "pkcs8", format: "pem" })
  .toString();

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("GitHub App transport", () => {
  it("searches the complete installation catalog before paginating matches", async () => {
    const repositories = Array.from({ length: 205 }, (_, index) => makeGitHubRepository({
      id: index + 1,
      owner: index === 100 || index === 101 || index === 200 ? "matching-owner" : "other-owner",
      name: `repo-${index + 1}`,
    }));
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
      if (url.pathname.endsWith("/access_tokens")) {
        return jsonResponse({ token: "ghs_test", expires_at: "2099-01-01T00:00:00.000Z" });
      }
      const page = Number(url.searchParams.get("page"));
      const perPage = Number(url.searchParams.get("per_page"));
      const start = (page - 1) * perPage;
      return jsonResponse({ total_count: repositories.length, repositories: repositories.slice(start, start + perPage) });
    });
    const transport = createGitHubAppTransport({ appId: "1", privateKey, fetchImpl });

    await expect(transport.listRepositories({
      installationId: "installation-1",
      page: 1,
      perPage: 2,
      query: "matching-owner",
    })).resolves.toMatchObject({
      totalCount: 3,
      items: [{ id: 101 }, { id: 102 }],
    });
    await expect(transport.listRepositories({
      installationId: "installation-1",
      page: 2,
      perPage: 2,
      query: "matching-owner",
    })).resolves.toMatchObject({
      totalCount: 3,
      items: [{ id: 201 }],
    });
    expect(fetchImpl.mock.calls.some(([input]) => String(input).includes("per_page=100&page=3"))).toBe(true);
  });

  it("does not expose provider request paths in operator-facing failures", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
      if (url.pathname.endsWith("/access_tokens")) {
        return jsonResponse({ token: "ghs_test", expires_at: "2099-01-01T00:00:00.000Z" });
      }
      return jsonResponse({ message: "unavailable" }, 503);
    });
    const transport = createGitHubAppTransport({ appId: "1", privateKey, fetchImpl });

    await expect(transport.listRepositories({
      installationId: "sensitive-installation",
      page: 1,
      perPage: 20,
      query: null,
    })).rejects.toThrow("GitHub repository provider request failed with status 503");
    await expect(transport.listRepositories({
      installationId: "sensitive-installation",
      page: 1,
      perPage: 20,
      query: null,
    })).rejects.not.toThrow("sensitive-installation");
  });
});
