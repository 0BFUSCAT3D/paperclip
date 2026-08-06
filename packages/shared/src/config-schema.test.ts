import { describe, expect, it } from "vitest";
import { findConfigNearMatchWarnings, paperclipConfigSchema } from "./config-schema.js";

function minimalConfig() {
  return {
    $meta: {
      version: 1,
      updatedAt: "2026-05-10T00:00:00.000Z",
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

describe("paperclip config schema", () => {
  it("defaults omitted runtime paths to legacy instance-root locations", () => {
    const parsed = paperclipConfigSchema.parse(minimalConfig());

    expect(parsed.database.embeddedPostgresDataDir).toBe("~/.paperclip/instances/default/db");
    expect(parsed.database.backup.dir).toBe("~/.paperclip/instances/default/data/backups");
    expect(parsed.logging.logDir).toBe("~/.paperclip/instances/default/logs");
    expect(parsed.storage.localDisk.baseDir).toBe("~/.paperclip/instances/default/data/storage");
    expect(parsed.secrets.localEncrypted.keyFilePath).toBe("~/.paperclip/instances/default/secrets/master.key");
  });

  it("preserves unknown top-level and nested provider keys", () => {
    const parsed = paperclipConfigSchema.parse({
      ...minimalConfig(),
      futurePlugin: { enabled: true },
      storage: {
        provider: "local_disk",
        localDisk: {
          futureMountOption: "cached",
        },
      },
    });

    expect(parsed.futurePlugin).toEqual({ enabled: true });
    expect(parsed.storage.localDisk.futureMountOption).toBe("cached");
  });

  it("still rejects invalid values for known fields", () => {
    expect(() => paperclipConfigSchema.parse({
      ...minimalConfig(),
      server: { port: "3100" },
    })).toThrow();
  });

  it("warns about near-match keys without rejecting them", () => {
    const raw = {
      ...minimalConfig(),
      server: { potr: 3200 },
    };

    expect(paperclipConfigSchema.parse(raw).server.potr).toBe(3200);
    expect(findConfigNearMatchWarnings(raw)).toEqual([
      "Unknown config key server.potr; did you mean server.port? The unknown key will be preserved.",
    ]);
  });
});
