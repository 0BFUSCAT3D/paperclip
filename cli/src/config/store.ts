import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  findConfigNearMatchWarnings,
  mergeConfigValues,
  paperclipConfigSchema,
  type PaperclipConfig,
} from "./schema.js";
import {
  resolveDefaultConfigPath,
  resolvePaperclipInstanceId,
} from "./home.js";

const DEFAULT_CONFIG_BASENAME = "config.json";

function findConfigFileFromAncestors(startDir: string): string | null {
  const absoluteStartDir = path.resolve(startDir);
  let currentDir = absoluteStartDir;

  while (true) {
    const candidate = path.resolve(currentDir, ".paperclip", DEFAULT_CONFIG_BASENAME);
    if (fs.existsSync(candidate)) {
      return candidate;
    }

    const nextDir = path.resolve(currentDir, "..");
    if (nextDir === currentDir) break;
    currentDir = nextDir;
  }

  return null;
}

export function resolveConfigPath(overridePath?: string): string {
  if (overridePath) return path.resolve(overridePath);
  if (process.env.PAPERCLIP_CONFIG) return path.resolve(process.env.PAPERCLIP_CONFIG);
  return findConfigFileFromAncestors(process.cwd()) ?? resolveDefaultConfigPath(resolvePaperclipInstanceId());
}

function parseJson(filePath: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch (err) {
    throw new Error(`Failed to parse JSON at ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function migrateLegacyConfig(raw: unknown): unknown {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return raw;
  const config = { ...(raw as Record<string, unknown>) };
  const databaseRaw = config.database;
  if (typeof databaseRaw !== "object" || databaseRaw === null || Array.isArray(databaseRaw)) {
    return config;
  }

  const database = { ...(databaseRaw as Record<string, unknown>) };
  if (database.mode === "pglite") {
    database.mode = "embedded-postgres";

    if (typeof database.embeddedPostgresDataDir !== "string" && typeof database.pgliteDataDir === "string") {
      database.embeddedPostgresDataDir = database.pgliteDataDir;
    }
    if (
      typeof database.embeddedPostgresPort !== "number" &&
      typeof database.pglitePort === "number" &&
      Number.isFinite(database.pglitePort)
    ) {
      database.embeddedPostgresPort = database.pglitePort;
    }
  }

  config.database = database;
  return config;
}

function formatValidationError(err: unknown): string {
  const issues = (err as { issues?: Array<{ path?: unknown; message?: unknown }> })?.issues;
  if (Array.isArray(issues) && issues.length > 0) {
    return issues
      .map((issue) => {
        const pathParts = Array.isArray(issue.path) ? issue.path.map(String) : [];
        const issuePath = pathParts.length > 0 ? pathParts.join(".") : "config";
        const message = typeof issue.message === "string" ? issue.message : "Invalid value";
        return `${issuePath}: ${message}`;
      })
      .join("; ");
  }
  return err instanceof Error ? err.message : String(err);
}

function parseConfig(filePath: string, options: { warnNearMatches?: boolean } = {}): PaperclipConfig {
  const raw = parseJson(filePath);
  const migrated = migrateLegacyConfig(raw);
  const parsed = paperclipConfigSchema.safeParse(migrated);
  if (!parsed.success) {
    throw new Error(`Invalid config at ${filePath}: ${formatValidationError(parsed.error)}`);
  }
  if (options.warnNearMatches !== false) {
    for (const warning of findConfigNearMatchWarnings(raw)) {
      console.warn(`Warning: ${warning}`);
    }
  }
  return parsed.data;
}

function writeFileAtomic(filePath: string, contents: string): void {
  const temporaryPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.tmp-${process.pid}-${randomUUID()}`,
  );
  try {
    fs.writeFileSync(temporaryPath, contents, { mode: 0o600, flag: "wx" });
    fs.renameSync(temporaryPath, filePath);
  } finally {
    fs.rmSync(temporaryPath, { force: true });
  }
}

function effectiveConfigEquals(source: PaperclipConfig, candidate: PaperclipConfig): boolean {
  const normalizedCandidate: PaperclipConfig = {
    ...candidate,
    $meta: {
      ...candidate.$meta,
      source: source.$meta.source,
      updatedAt: source.$meta.updatedAt,
    },
  };
  return isDeepStrictEqual(source, normalizedCandidate);
}

export type ConfigReadState =
  | { status: "missing"; path: string }
  | { status: "valid"; path: string; config: PaperclipConfig }
  | { status: "invalid"; path: string; error: Error };

export function readConfigState(configPath?: string): ConfigReadState {
  const filePath = resolveConfigPath(configPath);
  if (!fs.existsSync(filePath)) return { status: "missing", path: filePath };
  try {
    return { status: "valid", path: filePath, config: parseConfig(filePath) };
  } catch (error) {
    return {
      status: "invalid",
      path: filePath,
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
}

export function backupInvalidConfig(configPath?: string): string {
  const filePath = resolveConfigPath(configPath);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Cannot back up missing config at ${filePath}`);
  }

  for (let index = 1; ; index += 1) {
    const backupPath = `${filePath}.invalid-${index}`;
    try {
      fs.copyFileSync(filePath, backupPath, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(backupPath, 0o600);
      return backupPath;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw error;
    }
  }
}

export function readConfig(configPath?: string): PaperclipConfig | null {
  const filePath = resolveConfigPath(configPath);
  if (!fs.existsSync(filePath)) return null;
  return parseConfig(filePath);
}

export function writeConfig(
  config: PaperclipConfig,
  configPath?: string,
  options: { allowInvalidReplace?: boolean } = {},
): boolean {
  const filePath = resolveConfigPath(configPath);
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });

  let sourceConfig: PaperclipConfig | null = null;
  if (fs.existsSync(filePath)) {
    try {
      sourceConfig = parseConfig(filePath, { warnNearMatches: false });
    } catch (error) {
      if (!options.allowInvalidReplace) {
        throw new Error(
          `Refusing to overwrite invalid config at ${filePath}. Back it up and explicitly confirm repair first. ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  const merged = sourceConfig ? mergeConfigValues(sourceConfig, config) : config;
  const parsed = paperclipConfigSchema.safeParse(merged);
  if (!parsed.success) {
    throw new Error(`Invalid config update for ${filePath}: ${formatValidationError(parsed.error)}`);
  }

  if (sourceConfig && effectiveConfigEquals(sourceConfig, parsed.data)) {
    return false;
  }

  // Backup existing config before overwriting
  if (fs.existsSync(filePath)) {
    const backupPath = filePath + ".backup";
    fs.copyFileSync(filePath, backupPath);
    fs.chmodSync(backupPath, 0o600);
  }

  writeFileAtomic(filePath, JSON.stringify(parsed.data, null, 2) + "\n");
  return true;
}

export function configExists(configPath?: string): boolean {
  return fs.existsSync(resolveConfigPath(configPath));
}
