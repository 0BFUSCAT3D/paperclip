import { z } from "zod";
import {
  AUTH_BASE_URL_MODES,
  BIND_MODES,
  DEPLOYMENT_EXPOSURES,
  DEPLOYMENT_MODES,
  SECRET_PROVIDERS,
  STORAGE_PROVIDERS,
} from "./constants.js";
import { validateConfiguredBindMode } from "./network-bind.js";

export const configMetaSchema = z.object({
  version: z.literal(1),
  updatedAt: z.string(),
  source: z.enum(["onboard", "configure", "doctor"]),
}).passthrough();

export const llmConfigSchema = z.object({
  provider: z.enum(["claude", "openai"]),
  apiKey: z.string().optional(),
}).passthrough();

export const databaseBackupConfigSchema = z.object({
  enabled: z.boolean().default(true),
  intervalMinutes: z.number().int().min(1).max(7 * 24 * 60).default(60),
  retentionDays: z.number().int().min(1).max(3650).default(7),
  dir: z.string().default("~/.paperclip/instances/default/data/backups"),
}).passthrough();

export const databaseConfigSchema = z.object({
  mode: z.enum(["embedded-postgres", "postgres"]).default("embedded-postgres"),
  connectionString: z.string().optional(),
  embeddedPostgresDataDir: z.string().default("~/.paperclip/instances/default/db"),
  embeddedPostgresPort: z.number().int().min(1).max(65535).default(54329),
  backup: databaseBackupConfigSchema.default({
    enabled: true,
    intervalMinutes: 60,
    retentionDays: 7,
    dir: "~/.paperclip/instances/default/data/backups",
  }),
}).passthrough();

export const loggingConfigSchema = z.object({
  mode: z.enum(["file", "cloud"]),
  logDir: z.string().default("~/.paperclip/instances/default/logs"),
}).passthrough();

export const serverConfigSchema = z.object({
  deploymentMode: z.enum(DEPLOYMENT_MODES).default("local_trusted"),
  exposure: z.enum(DEPLOYMENT_EXPOSURES).default("private"),
  bind: z.enum(BIND_MODES).optional(),
  customBindHost: z.string().optional(),
  host: z.string().default("127.0.0.1"),
  port: z.number().int().min(1).max(65535).default(3100),
  allowedHostnames: z.array(z.string().min(1)).default([]),
  serveUi: z.boolean().default(true),
}).passthrough();

export const authConfigSchema = z.object({
  baseUrlMode: z.enum(AUTH_BASE_URL_MODES).default("auto"),
  publicBaseUrl: z.string().url().optional(),
  disableSignUp: z.boolean().default(false),
}).passthrough();

export const storageLocalDiskConfigSchema = z.object({
  baseDir: z.string().default("~/.paperclip/instances/default/data/storage"),
}).passthrough();

export const storageS3ConfigSchema = z.object({
  bucket: z.string().min(1).default("paperclip"),
  region: z.string().min(1).default("us-east-1"),
  endpoint: z.string().optional(),
  prefix: z.string().default(""),
  forcePathStyle: z.boolean().default(false),
}).passthrough();

export const storageConfigSchema = z.object({
  provider: z.enum(STORAGE_PROVIDERS).default("local_disk"),
  localDisk: storageLocalDiskConfigSchema.default({
    baseDir: "~/.paperclip/instances/default/data/storage",
  }),
  s3: storageS3ConfigSchema.default({
    bucket: "paperclip",
    region: "us-east-1",
    prefix: "",
    forcePathStyle: false,
  }),
}).passthrough();

export const secretsLocalEncryptedConfigSchema = z.object({
  keyFilePath: z.string().default("~/.paperclip/instances/default/secrets/master.key"),
}).passthrough();

export const secretsConfigSchema = z.object({
  provider: z.enum(SECRET_PROVIDERS).default("local_encrypted"),
  strictMode: z.boolean().default(false),
  localEncrypted: secretsLocalEncryptedConfigSchema.default({
    keyFilePath: "~/.paperclip/instances/default/secrets/master.key",
  }),
}).passthrough();

export const telemetryConfigSchema = z.object({
  enabled: z.boolean().default(true),
}).passthrough().default({});

export const updatesConfigSchema = z.object({
  checkEnabled: z.boolean().default(true),
}).passthrough().default({});

export const paperclipConfigSchema = z
  .object({
    $meta: configMetaSchema,
    llm: llmConfigSchema.optional(),
    database: databaseConfigSchema,
    logging: loggingConfigSchema,
    server: serverConfigSchema,
    telemetry: telemetryConfigSchema,
    updates: updatesConfigSchema.optional(),
    auth: authConfigSchema.default({
      baseUrlMode: "auto",
      disableSignUp: false,
    }),
    storage: storageConfigSchema.default({
      provider: "local_disk",
      localDisk: {
        baseDir: "~/.paperclip/instances/default/data/storage",
      },
      s3: {
        bucket: "paperclip",
        region: "us-east-1",
        prefix: "",
        forcePathStyle: false,
      },
    }),
    secrets: secretsConfigSchema.default({
      provider: "local_encrypted",
      strictMode: false,
      localEncrypted: {
        keyFilePath: "~/.paperclip/instances/default/secrets/master.key",
      },
    }),
  })
  .passthrough()
  .superRefine((value, ctx) => {
    if (value.server.deploymentMode === "local_trusted" && value.server.exposure !== "private") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "server.exposure must be private when deploymentMode is local_trusted",
        path: ["server", "exposure"],
      });
    }

    for (const message of validateConfiguredBindMode({
      deploymentMode: value.server.deploymentMode,
      deploymentExposure: value.server.exposure,
      bind: value.server.bind,
      host: value.server.host,
      customBindHost: value.server.customBindHost,
    })) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message,
        path: message.includes("customBindHost") ? ["server", "customBindHost"] : ["server", "bind"],
      });
    }

    if (value.auth.baseUrlMode === "explicit" && !value.auth.publicBaseUrl) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "auth.publicBaseUrl is required when auth.baseUrlMode is explicit",
        path: ["auth", "publicBaseUrl"],
      });
    }

    if (value.server.exposure === "public" && value.auth.baseUrlMode !== "explicit") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "auth.baseUrlMode must be explicit when deploymentMode=authenticated and exposure=public",
        path: ["auth", "baseUrlMode"],
      });
    }

    if (value.server.exposure === "public" && !value.auth.publicBaseUrl) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "auth.publicBaseUrl is required when deploymentMode=authenticated and exposure=public",
        path: ["auth", "publicBaseUrl"],
      });
    }
  });

const CONFIG_OBJECT_KEYS = new Map<string, readonly string[]>([
  ["", ["$meta", "llm", "database", "logging", "server", "telemetry", "updates", "auth", "storage", "secrets"]],
  ["$meta", ["version", "updatedAt", "source"]],
  ["llm", ["provider", "apiKey"]],
  ["database", ["mode", "connectionString", "embeddedPostgresDataDir", "embeddedPostgresPort", "backup"]],
  ["database.backup", ["enabled", "intervalMinutes", "retentionDays", "dir"]],
  ["logging", ["mode", "logDir"]],
  ["server", ["deploymentMode", "exposure", "bind", "customBindHost", "host", "port", "allowedHostnames", "serveUi"]],
  ["telemetry", ["enabled"]],
  ["updates", ["checkEnabled"]],
  ["auth", ["baseUrlMode", "publicBaseUrl", "disableSignUp"]],
  ["storage", ["provider", "localDisk", "s3"]],
  ["storage.localDisk", ["baseDir"]],
  ["storage.s3", ["bucket", "region", "endpoint", "prefix", "forcePathStyle"]],
  ["secrets", ["provider", "strictMode", "localEncrypted"]],
  ["secrets.localEncrypted", ["keyFilePath"]],
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function valueAtPath(value: unknown, objectPath: string): Record<string, unknown> | null {
  let current = value;
  for (const segment of objectPath.split(".").filter(Boolean)) {
    if (!isRecord(current)) return null;
    current = current[segment];
  }
  return isRecord(current) ? current : null;
}

function editDistance(left: string, right: string): number {
  if (left.length === right.length) {
    const differences = Array.from(left, (character, index) => character === right[index] ? -1 : index)
      .filter((index) => index >= 0);
    if (
      differences.length === 2
      && differences[1] === differences[0]! + 1
      && left[differences[0]!] === right[differences[1]!]
      && left[differences[1]!] === right[differences[0]!]
    ) {
      return 1;
    }
  }

  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      current[rightIndex] = Math.min(
        (current[rightIndex - 1] ?? 0) + 1,
        (previous[rightIndex] ?? 0) + 1,
        (previous[rightIndex - 1] ?? 0) + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
      );
    }
    previous.splice(0, previous.length, ...current);
  }
  return previous[right.length] ?? right.length;
}

/**
 * Reports likely misspellings without rejecting or deleting extension keys.
 * Unknown keys that are not close to a managed key remain silent passthrough data.
 */
export function findConfigNearMatchWarnings(raw: unknown): string[] {
  const warnings: string[] = [];

  for (const [objectPath, knownKeys] of CONFIG_OBJECT_KEYS) {
    const object = valueAtPath(raw, objectPath);
    if (!object) continue;

    for (const key of Object.keys(object)) {
      if (knownKeys.includes(key)) continue;
      const nearMatch = knownKeys
        .map((knownKey) => ({ knownKey, distance: editDistance(key.toLowerCase(), knownKey.toLowerCase()) }))
        .filter(({ knownKey, distance }) => distance <= (knownKey.length >= 8 ? 2 : 1))
        .sort((left, right) => left.distance - right.distance || left.knownKey.localeCompare(right.knownKey))[0];
      if (!nearMatch) continue;

      const keyPath = objectPath ? `${objectPath}.${key}` : key;
      const matchPath = objectPath ? `${objectPath}.${nearMatch.knownKey}` : nearMatch.knownKey;
      warnings.push(`Unknown config key ${keyPath}; did you mean ${matchPath}? The unknown key will be preserved.`);
    }
  }

  return warnings;
}

export type PaperclipConfig = z.infer<typeof paperclipConfigSchema>;
export type LlmConfig = z.infer<typeof llmConfigSchema>;
export type DatabaseConfig = z.infer<typeof databaseConfigSchema>;
export type LoggingConfig = z.infer<typeof loggingConfigSchema>;
export type ServerConfig = z.infer<typeof serverConfigSchema>;
export type StorageConfig = z.infer<typeof storageConfigSchema>;
export type StorageLocalDiskConfig = z.infer<typeof storageLocalDiskConfigSchema>;
export type StorageS3Config = z.infer<typeof storageS3ConfigSchema>;
export type SecretsConfig = z.infer<typeof secretsConfigSchema>;
export type SecretsLocalEncryptedConfig = z.infer<typeof secretsLocalEncryptedConfigSchema>;
export type AuthConfig = z.infer<typeof authConfigSchema>;
export type TelemetryConfig = z.infer<typeof telemetryConfigSchema>;
export type UpdatesConfig = z.infer<typeof updatesConfigSchema>;
export type ConfigMeta = z.infer<typeof configMetaSchema>;
export type DatabaseBackupConfig = z.infer<typeof databaseBackupConfigSchema>;
