import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  backupInvalidConfig,
  readConfig,
  writeConfig,
} from "../config/store.js";
import type { PaperclipConfig } from "../config/schema.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function configFixture(): PaperclipConfig {
  return {
    $meta: {
      version: 1,
      updatedAt: "2026-08-06T00:00:00.000Z",
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
    logging: { mode: "file", logDir: "/tmp/paperclip-logs" },
    server: {
      deploymentMode: "local_trusted",
      exposure: "private",
      bind: "loopback",
      host: "127.0.0.1",
      port: 3100,
      allowedHostnames: [],
      serveUi: true,
    },
    auth: { baseUrlMode: "auto", disableSignUp: false },
    telemetry: { enabled: true },
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
}

function tempConfigPath(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-config-store-"));
  roots.push(root);
  return path.join(root, "config.json");
}

describe("config store", () => {
  it("preserves unknown top-level and nested keys through a known-field update", () => {
    const configPath = tempConfigPath();
    const raw = {
      ...configFixture(),
      futurePlugin: { enabled: true },
      storage: {
        ...configFixture().storage,
        localDisk: {
          ...configFixture().storage.localDisk,
          futureMountOption: "cached",
        },
      },
    };
    fs.writeFileSync(configPath, `${JSON.stringify(raw, null, 2)}\n`);

    const config = readConfig(configPath)!;
    config.server.port = 3200;
    expect(writeConfig(config, configPath)).toBe(true);

    const written = JSON.parse(fs.readFileSync(configPath, "utf8"));
    expect(written.server.port).toBe(3200);
    expect(written.futurePlugin).toEqual({ enabled: true });
    expect(written.storage.localDisk.futureMountOption).toBe("cached");
  });

  it("skips semantically unchanged writes and keeps the original mtime and bytes", () => {
    const configPath = tempConfigPath();
    const contents = `${JSON.stringify(configFixture())}\n`;
    fs.writeFileSync(configPath, contents);
    const stableTime = new Date("2026-01-01T00:00:00.000Z");
    fs.utimesSync(configPath, stableTime, stableTime);

    const config = readConfig(configPath)!;
    config.$meta.updatedAt = new Date().toISOString();
    config.$meta.source = "configure";

    expect(writeConfig(config, configPath)).toBe(false);
    expect(fs.readFileSync(configPath, "utf8")).toBe(contents);
    expect(fs.statSync(configPath).mtimeMs).toBe(stableTime.getTime());
    expect(fs.existsSync(`${configPath}.backup`)).toBe(false);
  });

  it("removes an explicitly cleared owned optional section", () => {
    const configPath = tempConfigPath();
    const configWithLlm: PaperclipConfig = {
      ...configFixture(),
      llm: { provider: "openai", futureProviderOption: true },
    };
    fs.writeFileSync(configPath, `${JSON.stringify(configWithLlm, null, 2)}\n`);

    const config = readConfig(configPath)!;
    config.llm = undefined;

    expect(writeConfig(config, configPath)).toBe(true);
    expect(JSON.parse(fs.readFileSync(configPath, "utf8"))).not.toHaveProperty("llm");
  });

  it("creates collision-safe byte-for-byte invalid backups", () => {
    const configPath = tempConfigPath();
    const invalidBytes = Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0xff, 0x7d]);
    fs.writeFileSync(configPath, invalidBytes);

    const first = backupInvalidConfig(configPath);
    const second = backupInvalidConfig(configPath);

    expect(first).toBe(`${configPath}.invalid-1`);
    expect(second).toBe(`${configPath}.invalid-2`);
    expect(fs.readFileSync(first)).toEqual(invalidBytes);
    expect(fs.readFileSync(second)).toEqual(invalidBytes);
  });

  it("refuses to overwrite an invalid config without explicit repair authorization", () => {
    const configPath = tempConfigPath();
    fs.writeFileSync(configPath, "{ invalid");

    expect(() => writeConfig(configFixture(), configPath)).toThrow(/Refusing to overwrite invalid config/);
    expect(fs.readFileSync(configPath, "utf8")).toBe("{ invalid");
  });
});
