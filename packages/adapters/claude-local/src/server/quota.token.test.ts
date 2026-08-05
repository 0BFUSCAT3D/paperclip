import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readClaudeToken } from "./quota.js";

// These tests prove the host token source order. The host reads the token from
// an environment variable first, then from the on-disk credential file. The
// portable probe uses the same order, so the host and the sandbox resolve the
// same token.
describe("readClaudeToken source order", () => {
  const savedEnv: Record<string, string | undefined> = {};
  let isolatedConfigDir: string;

  function saveEnv(key: string): void {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }

  beforeEach(() => {
    for (const key of ["CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_OAUTH_TOKEN", "CLAUDE_CONFIG_DIR"]) {
      saveEnv(key);
    }
    isolatedConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-claude-quota-token-test-"));
    process.env.CLAUDE_CONFIG_DIR = isolatedConfigDir;
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    try {
      fs.rmSync(isolatedConfigDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  function writeCredentialFile(token: string): void {
    fs.writeFileSync(
      path.join(isolatedConfigDir, ".credentials.json"),
      JSON.stringify({ claudeAiOauth: { accessToken: token } }),
    );
  }

  it("reads the token from CLAUDE_CODE_OAUTH_TOKEN when no file exists", async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "env-primary-token";

    await expect(readClaudeToken()).resolves.toBe("env-primary-token");
  });

  it("reads the token from CLAUDE_OAUTH_TOKEN when no file exists", async () => {
    process.env.CLAUDE_OAUTH_TOKEN = "env-secondary-token";

    await expect(readClaudeToken()).resolves.toBe("env-secondary-token");
  });

  it("prefers CLAUDE_CODE_OAUTH_TOKEN over CLAUDE_OAUTH_TOKEN", async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "env-primary-token";
    process.env.CLAUDE_OAUTH_TOKEN = "env-secondary-token";

    await expect(readClaudeToken()).resolves.toBe("env-primary-token");
  });

  it("prefers an environment token over the credential file", async () => {
    writeCredentialFile("file-token");
    process.env.CLAUDE_OAUTH_TOKEN = "env-secondary-token";

    await expect(readClaudeToken()).resolves.toBe("env-secondary-token");
  });

  it("falls back to the credential file when no environment token exists", async () => {
    writeCredentialFile("file-token");

    await expect(readClaudeToken()).resolves.toBe("file-token");
  });

  it("ignores an empty environment token and falls back to the file", async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "   ";
    writeCredentialFile("file-token");

    await expect(readClaudeToken()).resolves.toBe("file-token");
  });

  it("returns null when no environment token and no file exist", async () => {
    await expect(readClaudeToken()).resolves.toBeNull();
  });
});
