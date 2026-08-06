import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readConfigFile } from "../config-file.js";

const ORIGINAL_PAPERCLIP_CONFIG = process.env.PAPERCLIP_CONFIG;

function writeConfig(configPath: string, value: unknown): void {
  fs.writeFileSync(configPath, `${JSON.stringify(value, null, 2)}\n`);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function minimalConfig(): unknown {
  return {
    $meta: {
      version: 1,
      updatedAt: "2026-07-05T00:00:00.000Z",
      source: "configure",
    },
    database: {
      mode: "embedded-postgres",
    },
    logging: {
      mode: "file",
    },
    server: {},
  };
}

describe("readConfigFile", () => {
  let tempDir: string;
  let configPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-config-file-test-"));
    configPath = path.join(tempDir, "config.json");
    process.env.PAPERCLIP_CONFIG = configPath;
  });

  afterEach(() => {
    if (ORIGINAL_PAPERCLIP_CONFIG === undefined) {
      delete process.env.PAPERCLIP_CONFIG;
    } else {
      process.env.PAPERCLIP_CONFIG = ORIGINAL_PAPERCLIP_CONFIG;
    }

    fs.rmSync(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("returns null when the config file does not exist", () => {
    expect(readConfigFile()).toBeNull();
  });

  it("throws a path-specific error when the config file is invalid JSON", () => {
    fs.writeFileSync(configPath, "{");

    expect(() => readConfigFile()).toThrow(
      new RegExp(`Invalid Paperclip config at ${escapeRegExp(configPath)}: failed to read or parse JSON`),
    );
  });

  it("throws a field-specific error when the config file fails schema validation", () => {
    const config = minimalConfig();
    if (typeof config === "object" && config !== null) {
      (config as { $meta: { source: string } }).$meta.source = "edited-by-hand";
    }

    writeConfig(configPath, config);

    expect(() => readConfigFile()).toThrow(/Invalid Paperclip config .* \$meta\.source:/);
  });

  it("parses a valid config file", () => {
    writeConfig(configPath, minimalConfig());

    expect(readConfigFile()).toMatchObject({
      $meta: {
        source: "configure",
      },
      database: {
        mode: "embedded-postgres",
      },
      logging: {
        mode: "file",
      },
    });
  });

  it("preserves near-match keys and warns instead of deleting them", () => {
    const config = minimalConfig() as { server: Record<string, unknown> };
    config.server.potr = 3200;
    writeConfig(configPath, config);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const parsed = readConfigFile();

    expect(parsed?.server.potr).toBe(3200);
    expect(warn).toHaveBeenCalledWith(
      "Warning: Unknown config key server.potr; did you mean server.port? The unknown key will be preserved.",
    );
  });
});
