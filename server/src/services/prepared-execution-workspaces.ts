import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { projectWorkspaces } from "@paperclipai/db";
import type { AdoptPreparedExecutionWorkspace } from "@paperclipai/shared";
import { conflict, unprocessable } from "../errors.js";

const execFileAsync = promisify(execFile);
const GIT_EXECUTABLE = "/usr/bin/git";
const GIT_TIMEOUT_MS = 10_000;
const GIT_MAX_BUFFER_BYTES = 4 * 1024 * 1024;
const SAFE_GIT_ENV: NodeJS.ProcessEnv = {
  HOME: "/var/empty",
  XDG_CONFIG_HOME: "/var/empty",
  PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
  LANG: "C",
  LC_ALL: "C",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_ATTR_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
  GIT_ASKPASS: "/usr/bin/false",
  SSH_ASKPASS: "/usr/bin/false",
  GIT_OPTIONAL_LOCKS: "0",
  GIT_NO_LAZY_FETCH: "1",
  GIT_NO_REPLACE_OBJECTS: "1",
};
const SAFE_GIT_CONFIG = [
  "-c", "core.hooksPath=/dev/null",
  "-c", "core.fsmonitor=false",
  "-c", "core.untrackedCache=false",
  "-c", "core.preloadindex=false",
  "-c", "core.attributesFile=/dev/null",
  "-c", "core.excludesFile=/dev/null",
  "-c", "core.sparseCheckout=false",
  "-c", "core.sparseCheckoutCone=false",
  "-c", "submodule.recurse=false",
  "-c", "fetch.recurseSubmodules=false",
  "-c", "diff.ignoreSubmodules=none",
  "-c", "credential.helper=",
  "-c", "protocol.allow=never",
  "-c", "protocol.https.allow=never",
  "-c", "protocol.http.allow=never",
  "-c", "protocol.ssh.allow=never",
  "-c", "protocol.git.allow=never",
  "-c", "protocol.file.allow=never",
  "-c", "protocol.ext.allow=never",
] as const;

async function gitRaw(cwd: string, args: readonly string[]): Promise<string> {
  const result = await execFileAsync(GIT_EXECUTABLE, [...SAFE_GIT_CONFIG, ...args], {
    cwd,
    encoding: "utf8",
    maxBuffer: GIT_MAX_BUFFER_BYTES,
    timeout: GIT_TIMEOUT_MS,
    killSignal: "SIGKILL",
    env: SAFE_GIT_ENV,
  });
  return result.stdout;
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
  return (await gitRaw(cwd, args)).trim();
}

async function canonicalDirectory(value: string, label: string): Promise<string> {
  if (!path.isAbsolute(value)) {
    throw unprocessable(`${label} must be an absolute same-host path`, {
      code: "prepared_workspace_path_not_absolute",
    });
  }
  const resolved = await fs.realpath(value).catch(() => null);
  if (!resolved) {
    throw unprocessable(`${label} does not exist`, { code: "prepared_workspace_path_missing" });
  }
  const stat = await fs.stat(resolved).catch(() => null);
  if (!stat?.isDirectory()) {
    throw unprocessable(`${label} is not a directory`, { code: "prepared_workspace_path_not_directory" });
  }
  if (resolved !== value) {
    throw unprocessable(`${label} must use its canonical path`, {
      code: "prepared_workspace_path_not_canonical",
    });
  }
  return resolved;
}

async function gitCommonDirectory(cwd: string): Promise<string> {
  const raw = await git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  return fs.realpath(path.isAbsolute(raw) ? raw : path.resolve(cwd, raw));
}

async function gitDirectory(cwd: string): Promise<string> {
  const raw = await git(cwd, ["rev-parse", "--path-format=absolute", "--git-dir"]);
  return fs.realpath(path.isAbsolute(raw) ? raw : path.resolve(cwd, raw));
}

async function assertLinkedWorktreeIdentity(input: {
  worktreePath: string;
  root: string;
  commonGitDirectory: string;
}): Promise<string> {
  if (input.worktreePath === input.root) {
    throw conflict("Prepared workspace must be a separate linked Git worktree", {
      code: "prepared_workspace_primary_checkout_forbidden",
    });
  }
  const dotGitPath = path.join(input.worktreePath, ".git");
  const dotGitStat = await fs.lstat(dotGitPath).catch(() => null);
  if (!dotGitStat?.isFile() || dotGitStat.isSymbolicLink()) {
    throw conflict("Prepared workspace must have a linked-worktree Git admin pointer", {
      code: "prepared_workspace_linked_gitdir_required",
    });
  }
  const pointer = await fs.readFile(dotGitPath, "utf8").catch(() => "");
  const match = /^gitdir: (.+)\r?\n?$/.exec(pointer);
  if (!match) {
    throw conflict("Prepared workspace Git admin pointer is invalid", {
      code: "prepared_workspace_linked_gitdir_required",
    });
  }
  const pointerPath = path.isAbsolute(match[1]!)
    ? match[1]!
    : path.resolve(input.worktreePath, match[1]!);
  const pointerGitDirectory = await fs.realpath(pointerPath).catch(() => null);
  const observedGitDirectory = await gitDirectory(input.worktreePath).catch(() => null);
  const worktreeAdminRoot = path.join(input.commonGitDirectory, "worktrees");
  const relativeAdminPath = pointerGitDirectory
    ? path.relative(worktreeAdminRoot, pointerGitDirectory)
    : "";
  if (
    !pointerGitDirectory
    || !observedGitDirectory
    || pointerGitDirectory !== observedGitDirectory
    || pointerGitDirectory === input.commonGitDirectory
    || !relativeAdminPath
    || relativeAdminPath.startsWith("..")
    || path.isAbsolute(relativeAdminPath)
    || relativeAdminPath.includes(path.sep)
  ) {
    throw conflict("Prepared workspace does not have a separate registered Git admin identity", {
      code: "prepared_workspace_linked_gitdir_mismatch",
    });
  }
  const reversePointerPath = path.join(pointerGitDirectory, "gitdir");
  const reversePointerStat = await fs.lstat(reversePointerPath).catch(() => null);
  if (!reversePointerStat?.isFile() || reversePointerStat.isSymbolicLink()) {
    throw conflict("Prepared workspace linked-worktree reverse pointer is missing or indirect", {
      code: "prepared_workspace_linked_gitdir_reverse_mismatch",
    });
  }
  const reversePointer = (await fs.readFile(reversePointerPath, "utf8").catch(() => "")).trim();
  const reversePointerTarget = reversePointer
    ? path.isAbsolute(reversePointer)
      ? reversePointer
      : path.resolve(pointerGitDirectory, reversePointer)
    : "";
  const [canonicalReverseTarget, canonicalPreparedDotGit] = await Promise.all([
    reversePointerTarget ? fs.realpath(reversePointerTarget).catch(() => null) : Promise.resolve(null),
    fs.realpath(dotGitPath).catch(() => null),
  ]);
  if (
    !canonicalReverseTarget
    || !canonicalPreparedDotGit
    || canonicalReverseTarget !== canonicalPreparedDotGit
  ) {
    throw conflict("Prepared workspace linked-worktree reverse pointer does not name its .git file", {
      code: "prepared_workspace_linked_gitdir_reverse_mismatch",
    });
  }
  return pointerGitDirectory;
}

async function assertExactCleanRepositoryState(cwd: string, expectedHeadSha: string): Promise<void> {
  const observedHeadSha = await git(cwd, ["rev-parse", "--verify", "HEAD^{commit}"]);
  if (observedHeadSha !== expectedHeadSha) {
    throw conflict("Prepared workspace head changed", { code: "prepared_workspace_head_mismatch" });
  }

  const indexFields = (await gitRaw(cwd, ["ls-files", "-v", "-z"]))
    .split("\0")
    .filter(Boolean);
  if (indexFields.some((entry) => entry[0] === "S" || /[a-z]/.test(entry[0] ?? ""))) {
    throw conflict("Prepared workspace index contains hidden file-state flags", {
      code: "prepared_workspace_hidden_index_flags",
    });
  }

  try {
    await gitRaw(cwd, ["diff", "--no-ext-diff", "--quiet", "--ignore-submodules=none", "HEAD", "--"]);
  } catch {
    throw conflict("Prepared workspace is not clean", { code: "prepared_workspace_dirty" });
  }
  const statusFields = (await gitRaw(cwd, [
    "-c", "status.showUntrackedFiles=all",
    "status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignored=matching",
  ])).split("\0").filter(Boolean);
  if (statusFields.length > 0) {
    throw conflict("Prepared workspace is not clean", { code: "prepared_workspace_dirty" });
  }
}

async function registeredWorktrees(root: string): Promise<Map<string, { head: string | null; branch: string | null }>> {
  const output = await git(root, ["worktree", "list", "--porcelain"]);
  const result = new Map<string, { head: string | null; branch: string | null }>();
  let currentPath: string | null = null;
  let currentHead: string | null = null;
  let currentBranch: string | null = null;
  const flush = () => {
    if (currentPath) result.set(currentPath, { head: currentHead, branch: currentBranch });
    currentPath = null;
    currentHead = null;
    currentBranch = null;
  };
  for (const line of `${output}\n`.split("\n")) {
    if (!line) {
      flush();
    } else if (line.startsWith("worktree ")) {
      currentPath = line.slice("worktree ".length);
    } else if (line.startsWith("HEAD ")) {
      currentHead = line.slice("HEAD ".length);
    } else if (line.startsWith("branch refs/heads/")) {
      currentBranch = line.slice("branch refs/heads/".length);
    }
  }
  return result;
}

export type ValidatedPreparedExecutionWorkspace = {
  path: string;
  root: string;
  commonGitDirectory: string;
  branchName: string;
  headSha: string;
};

/**
 * Re-proves the local facts instead of treating the caller's receipt hashes as
 * filesystem authority. This function is also used immediately before a run.
 */
export async function validatePreparedExecutionWorkspace(input: {
  db: Db;
  projectId: string;
  prepared: AdoptPreparedExecutionWorkspace;
}): Promise<ValidatedPreparedExecutionWorkspace> {
  const prepared = input.prepared;
  const projectWorkspace = await input.db
    .select({
      id: projectWorkspaces.id,
      companyId: projectWorkspaces.companyId,
      projectId: projectWorkspaces.projectId,
      cwd: projectWorkspaces.cwd,
    })
    .from(projectWorkspaces)
    .where(and(
      eq(projectWorkspaces.id, prepared.projectWorkspaceId),
      eq(projectWorkspaces.projectId, input.projectId),
      eq(projectWorkspaces.companyId, prepared.companyId),
    ))
    .then((rows) => rows[0] ?? null);
  if (!projectWorkspace?.cwd) {
    throw conflict("Prepared workspace is not bound to a local project workspace", {
      code: "prepared_workspace_project_scope_mismatch",
    });
  }

  const [worktreePath, root, commonGitDirectory, projectRoot] = await Promise.all([
    canonicalDirectory(prepared.path, "Prepared worktree path"),
    canonicalDirectory(prepared.root, "Prepared repository root"),
    canonicalDirectory(prepared.commonGitDirectory, "Prepared common Git directory"),
    canonicalDirectory(projectWorkspace.cwd, "Project workspace path"),
  ]);
  if (root !== projectRoot) {
    throw conflict("Prepared workspace repository root differs from the project workspace", {
      code: "prepared_workspace_repository_mismatch",
    });
  }
  await assertLinkedWorktreeIdentity({ worktreePath, root, commonGitDirectory });

  let worktreeTop: string;
  let rootTop: string;
  let worktreeCommon: string;
  let rootCommon: string;
  let headSha: string;
  let branchName: string;
  let registrations: Map<string, { head: string | null; branch: string | null }>;
  try {
    [worktreeTop, rootTop, worktreeCommon, rootCommon, headSha, branchName, registrations] = await Promise.all([
      git(worktreePath, ["rev-parse", "--show-toplevel"]),
      git(root, ["rev-parse", "--show-toplevel"]),
      gitCommonDirectory(worktreePath),
      gitCommonDirectory(root),
      git(worktreePath, ["rev-parse", "--verify", "HEAD^{commit}"]),
      git(worktreePath, ["symbolic-ref", "--quiet", "--short", "HEAD"]),
      registeredWorktrees(root),
    ]);
  } catch {
    throw conflict("Prepared workspace Git identity could not be proven", {
      code: "prepared_workspace_git_validation_failed",
    });
  }
  const registration = registrations.get(worktreePath);
  if (
    worktreeTop !== worktreePath
    || rootTop !== root
    || worktreeCommon !== commonGitDirectory
    || rootCommon !== commonGitDirectory
    || !registration
    || registration.head !== headSha
    || registration.branch !== branchName
  ) {
    throw conflict("Prepared workspace is not the registered worktree described by the request", {
      code: "prepared_workspace_registration_mismatch",
    });
  }
  if (branchName !== prepared.branch) {
    throw conflict("Prepared workspace branch changed", { code: "prepared_workspace_branch_mismatch" });
  }
  await assertExactCleanRepositoryState(worktreePath, prepared.authorizedStartHeadSha);
  return { path: worktreePath, root, commonGitDirectory, branchName, headSha };
}

export async function validateStoredPreparedExecutionWorkspace(input: {
  db: Db;
  companyId: string;
  workspace: {
    projectId: string;
    projectWorkspaceId: string | null;
    externalConnectionId: string | null;
    externalLifecycleId: string | null;
    externalTaskId: string | null;
    cwd: string | null;
    externalRoot: string | null;
    externalCommonGitDirectory: string | null;
    branchName: string | null;
    authorizedStartHeadSha: string | null;
    repositoryIdentitySha256: string | null;
    inspectionReceiptSha256: string | null;
    preparedIdentitySha256: string | null;
  };
}): Promise<ValidatedPreparedExecutionWorkspace> {
  const workspace = input.workspace;
  const values = [
    workspace.projectWorkspaceId,
    workspace.externalConnectionId,
    workspace.externalLifecycleId,
    workspace.externalTaskId,
    workspace.cwd,
    workspace.externalRoot,
    workspace.externalCommonGitDirectory,
    workspace.branchName,
    workspace.authorizedStartHeadSha,
    workspace.repositoryIdentitySha256,
    workspace.inspectionReceiptSha256,
    workspace.preparedIdentitySha256,
  ];
  if (values.some((value) => !value)) {
    throw conflict("External prepared workspace identity is incomplete", {
      code: "external_prepared_identity_incomplete",
    });
  }
  return validatePreparedExecutionWorkspace({
    db: input.db,
    projectId: workspace.projectId,
    prepared: {
      version: 1,
      companyId: input.companyId,
      projectWorkspaceId: workspace.projectWorkspaceId!,
      connectionId: workspace.externalConnectionId!,
      lifecycleId: workspace.externalLifecycleId!,
      taskId: workspace.externalTaskId!,
      path: workspace.cwd!,
      root: workspace.externalRoot!,
      commonGitDirectory: workspace.externalCommonGitDirectory!,
      branch: workspace.branchName!,
      authorizedStartHeadSha: workspace.authorizedStartHeadSha!,
      repositoryIdentitySha256: workspace.repositoryIdentitySha256!,
      inspectionReceiptSha256: workspace.inspectionReceiptSha256!,
      preparedIdentitySha256: workspace.preparedIdentitySha256!,
    },
  });
}
