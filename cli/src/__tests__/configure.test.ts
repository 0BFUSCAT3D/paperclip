import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { configure } from "../commands/configure.js";
import type { PaperclipConfig } from "../config/schema.js";
import { promptServer } from "../prompts/server.js";

vi.mock("../prompts/server.js", () => ({
  promptServer: vi.fn(),
}));

const ORIGINAL_EXIT_CODE = process.exitCode;

afterEach(() => {
  process.exitCode = ORIGINAL_EXIT_CODE;
  vi.mocked(promptServer).mockReset();
});

function writeBaseConfig(configPath: string) {
  const base: PaperclipConfig = {
    $meta: {
      version: 1,
      updatedAt: "2026-01-01T00:00:00.000Z",
      source: "configure",
    },
    database: {
      mode: "embedded-postgres",
      embeddedPostgresDataDir: "/tmp/paperclip-db",
      embeddedPostgresPort: 54329,
      backup: {
        enabled: true,
        intervalMinutes: 60,
        retentionDays: 30,
        dir: "/tmp/paperclip-backups",
      },
    },
    logging: {
      mode: "file",
      logDir: "/tmp/paperclip-logs",
    },
    server: {
      deploymentMode: "local_trusted",
      exposure: "private",
      bind: "loopback",
      host: "127.0.0.1",
      port: 3100,
      allowedHostnames: [],
      serveUi: true,
    },
    auth: {
      baseUrlMode: "auto",
      disableSignUp: false,
    },
    telemetry: {
      enabled: true,
    },
    storage: {
      provider: "local_disk",
      localDisk: { baseDir: "/tmp/paperclip-storage" },
      s3: {
        bucket: "paperclip",
        region: "us-east-1",
        prefix: "",
        forcePathStyle: false,
      },
    },
    secrets: {
      provider: "local_encrypted",
      strictMode: false,
      localEncrypted: { keyFilePath: "/tmp/paperclip-secrets/master.key" },
    },
  };
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(base, null, 2));
}

describe("configure command", () => {
  it("sets a failing exit code for unknown sections", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-configure-"));
    const configPath = path.join(root, "config.json");
    writeBaseConfig(configPath);

    try {
      await configure({ config: configPath, section: "invalid-section" });

      expect(process.exitCode).toBe(1);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("sets a failing exit code when no config exists", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-configure-missing-"));
    const configPath = path.join(root, "missing.json");

    try {
      await configure({ config: configPath, section: "server" });

      expect(process.exitCode).toBe(1);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("backs up an invalid config and preserves it in non-interactive mode", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-configure-invalid-"));
    const configPath = path.join(root, "config.json");
    const invalidContents = "{\n  invalid: true\n}\n";
    fs.writeFileSync(configPath, invalidContents);

    try {
      await configure({ config: configPath, section: "server" });

      expect(process.exitCode).toBe(1);
      expect(fs.readFileSync(configPath, "utf8")).toBe(invalidContents);
      expect(fs.readFileSync(`${configPath}.invalid-1`, "utf8")).toBe(invalidContents);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("clears a stale public URL while preserving unknown auth keys", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-configure-private-"));
    const configPath = path.join(root, "config.json");
    writeBaseConfig(configPath);
    const existing = JSON.parse(fs.readFileSync(configPath, "utf8"));
    existing.server = {
      ...existing.server,
      deploymentMode: "authenticated",
      exposure: "public",
      bind: "lan",
      host: "0.0.0.0",
    };
    existing.auth = {
      baseUrlMode: "explicit",
      publicBaseUrl: "https://old.example.com",
      disableSignUp: false,
      futureAuthOption: "preserved",
    };
    fs.writeFileSync(configPath, `${JSON.stringify(existing, null, 2)}\n`);

    vi.mocked(promptServer).mockResolvedValue({
      server: {
        deploymentMode: "local_trusted",
        exposure: "private",
        bind: "loopback",
        host: "127.0.0.1",
        port: 3100,
        allowedHostnames: [],
        serveUi: true,
      },
      auth: {
        baseUrlMode: "auto",
        disableSignUp: false,
      },
    });

    try {
      await configure({ config: configPath, section: "server" });

      const written = JSON.parse(fs.readFileSync(configPath, "utf8"));
      expect(written.auth).not.toHaveProperty("publicBaseUrl");
      expect(written.auth.futureAuthOption).toBe("preserved");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
