import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import type { Db } from "@paperclipai/db";
import { validatePreparedExecutionWorkspace } from "./prepared-execution-workspaces.js";
import { ensurePersistedExecutionWorkspaceAvailable } from "./workspace-runtime.js";
import { assertExternalPreparedWorkspaceSameHost } from "./heartbeat.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]) {
  return execFileAsync("git", args, { cwd, encoding: "utf8" });
}

function projectWorkspaceDb(row: {
  id: string;
  companyId: string;
  projectId: string;
  cwd: string;
}): Db {
  return {
    select: () => ({
      from: () => ({
        where: () => Promise.resolve([row]),
      }),
    }),
  } as unknown as Db;
}

describe("prepared execution workspace validation", () => {
  it("allows only same-host execution for externally prepared custody", () => {
    expect(() => assertExternalPreparedWorkspaceSameHost({
      workspace: { custodyKind: "external_prepared" },
      executionTarget: { kind: "local" },
    })).not.toThrow();
    expect(() => assertExternalPreparedWorkspaceSameHost({
      workspace: { custodyKind: "paperclip" },
      executionTarget: { kind: "sandbox" },
    })).not.toThrow();
    expect(() => assertExternalPreparedWorkspaceSameHost({
      workspace: { custodyKind: "external_prepared" },
      executionTarget: { kind: "sandbox" },
    })).toThrow(expect.objectContaining({
      status: 409,
      details: { code: "external_prepared_workspace_same_host_required" },
    }));
  });

  it("independently proves canonical registration, repository, branch, head, and cleanliness", async () => {
    const parent = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-prepared-workspace-")),
    );
    const root = path.join(parent, "repository");
    const worktree = path.join(parent, "prepared");
    await fs.mkdir(root);
    try {
      await git(root, ["init", "-b", "main"]);
      await git(root, ["config", "user.email", "test@example.com"]);
      await git(root, ["config", "user.name", "Test"]);
      await fs.writeFile(path.join(root, "README.md"), "ready\n", "utf8");
      await git(root, ["add", "README.md"]);
      await git(root, ["commit", "-m", "initial"]);
      await git(root, ["worktree", "add", "-b", "reeve/task-1", worktree, "HEAD"]);
      const head = (await git(worktree, ["rev-parse", "HEAD"])).stdout.trim();
      const commonGitDirectory = await fs.realpath(path.join(root, ".git"));
      const companyId = "10000000-0000-4000-8000-000000000001";
      const projectId = "10000000-0000-4000-8000-000000000002";
      const projectWorkspaceId = "10000000-0000-4000-8000-000000000003";
      const prepared = {
        version: 1 as const,
        companyId,
        projectWorkspaceId,
        connectionId: "10000000-0000-4000-8000-000000000004",
        lifecycleId: "10000000-0000-4000-8000-000000000005",
        taskId: "task-1",
        path: worktree,
        root,
        commonGitDirectory,
        branch: "reeve/task-1",
        authorizedStartHeadSha: head,
        repositoryIdentitySha256: "a".repeat(64),
        inspectionReceiptSha256: "b".repeat(64),
        preparedIdentitySha256: "c".repeat(64),
      };
      const db = projectWorkspaceDb({ id: projectWorkspaceId, companyId, projectId, cwd: root });

      await expect(validatePreparedExecutionWorkspace({ db, projectId, prepared })).resolves.toEqual({
        path: worktree,
        root,
        commonGitDirectory,
        branchName: "reeve/task-1",
        headSha: head,
      });

      const dotGitPointer = await fs.readFile(path.join(worktree, ".git"), "utf8");
      const adminPointerValue = dotGitPointer.trim().slice("gitdir: ".length);
      const adminDirectory = await fs.realpath(
        path.isAbsolute(adminPointerValue) ? adminPointerValue : path.resolve(worktree, adminPointerValue),
      );
      const reversePointerPath = path.join(adminDirectory, "gitdir");
      const originalReversePointer = await fs.readFile(reversePointerPath, "utf8");
      await fs.rm(reversePointerPath);
      await expect(validatePreparedExecutionWorkspace({ db, projectId, prepared })).rejects.toMatchObject({
        details: { code: "prepared_workspace_linked_gitdir_reverse_mismatch" },
      });
      await fs.writeFile(reversePointerPath, originalReversePointer, "utf8");

      await fs.writeFile(reversePointerPath, `${path.join(root, ".git")}\n`, "utf8");
      await expect(validatePreparedExecutionWorkspace({ db, projectId, prepared })).rejects.toMatchObject({
        details: { code: "prepared_workspace_linked_gitdir_reverse_mismatch" },
      });
      await fs.writeFile(reversePointerPath, originalReversePointer, "utf8");

      const swappedWorktree = path.join(parent, "swapped");
      await git(root, ["worktree", "add", "-b", "reeve/swapped", swappedWorktree, "HEAD"]);
      await fs.writeFile(reversePointerPath, `${path.join(swappedWorktree, ".git")}\n`, "utf8");
      await expect(validatePreparedExecutionWorkspace({ db, projectId, prepared })).rejects.toMatchObject({
        details: { code: "prepared_workspace_linked_gitdir_reverse_mismatch" },
      });
      await fs.writeFile(reversePointerPath, originalReversePointer, "utf8");

      const indirectReversePointer = path.join(parent, "indirect-gitdir");
      await fs.rename(reversePointerPath, indirectReversePointer);
      await fs.symlink(indirectReversePointer, reversePointerPath);
      await expect(validatePreparedExecutionWorkspace({ db, projectId, prepared })).rejects.toMatchObject({
        details: { code: "prepared_workspace_linked_gitdir_reverse_mismatch" },
      });
      await fs.rm(reversePointerPath);
      await fs.rename(indirectReversePointer, reversePointerPath);
      await expect(ensurePersistedExecutionWorkspaceAvailable({
        db,
        base: {
          baseCwd: root,
          source: "task_session",
          projectId,
          workspaceId: projectWorkspaceId,
          repoUrl: "https://github.com/example/production-shaped.git",
          repoRef: "main",
        },
        workspace: {
          id: "10000000-0000-4000-8000-000000000006",
          mode: "isolated_workspace",
          strategyType: "git_worktree",
          cwd: worktree,
          providerRef: worktree,
          projectId,
          projectWorkspaceId,
          repoUrl: null,
          baseRef: head,
          branchName: prepared.branch,
          custodyKind: "external_prepared",
          externalConnectionId: prepared.connectionId,
          externalLifecycleId: prepared.lifecycleId,
          externalTaskId: prepared.taskId,
          preparedIdentitySha256: prepared.preparedIdentitySha256,
          authorizedStartHeadSha: prepared.authorizedStartHeadSha,
          repositoryIdentitySha256: prepared.repositoryIdentitySha256,
          inspectionReceiptSha256: prepared.inspectionReceiptSha256,
          externalRoot: root,
          externalCommonGitDirectory: commonGitDirectory,
        },
        issue: { id: "issue-1", identifier: "TEST-1", title: "Prepared run" },
        agent: { id: "agent-1", name: "Builder", companyId },
      })).resolves.toMatchObject({
        cwd: worktree,
        worktreePath: worktree,
        branchName: prepared.branch,
        baseRefSha: head,
        created: false,
        repoUrl: null,
      });

      await fs.writeFile(path.join(worktree, "dirty.txt"), "changed\n", "utf8");
      await expect(validatePreparedExecutionWorkspace({ db, projectId, prepared })).rejects.toMatchObject({
        details: { code: "prepared_workspace_dirty" },
      });
      await fs.rm(path.join(worktree, "dirty.txt"));

      const excludePath = path.join(commonGitDirectory, "info", "exclude");
      const originalExclude = await fs.readFile(excludePath, "utf8");
      await fs.appendFile(excludePath, "\nignored-output\n", "utf8");
      await fs.writeFile(path.join(worktree, "ignored-output"), "ignored but present\n", "utf8");
      await expect(validatePreparedExecutionWorkspace({ db, projectId, prepared })).rejects.toMatchObject({
        details: { code: "prepared_workspace_dirty" },
      });
      await fs.rm(path.join(worktree, "ignored-output"));
      await fs.writeFile(excludePath, originalExclude, "utf8");

      await git(worktree, ["update-index", "--skip-worktree", "README.md"]);
      await expect(validatePreparedExecutionWorkspace({ db, projectId, prepared })).rejects.toMatchObject({
        details: { code: "prepared_workspace_hidden_index_flags" },
      });
      await git(worktree, ["update-index", "--no-skip-worktree", "README.md"]);
      await git(worktree, ["update-index", "--assume-unchanged", "README.md"]);
      await expect(validatePreparedExecutionWorkspace({ db, projectId, prepared })).rejects.toMatchObject({
        details: { code: "prepared_workspace_hidden_index_flags" },
      });
      await git(worktree, ["update-index", "--no-assume-unchanged", "README.md"]);

      const hostileMarker = path.join(parent, "hostile-git-config-ran");
      const hostile = path.join(parent, "hostile-git-helper.sh");
      await fs.writeFile(hostile, `#!/bin/sh\nprintf ran > ${JSON.stringify(hostileMarker)}\n`, "utf8");
      await fs.chmod(hostile, 0o755);
      const hooks = path.join(parent, "hooks");
      await fs.mkdir(hooks);
      await fs.writeFile(path.join(hooks, "post-checkout"), `#!/bin/sh\nexec ${JSON.stringify(hostile)}\n`, "utf8");
      await fs.chmod(path.join(hooks, "post-checkout"), 0o755);
      await git(root, ["config", "core.fsmonitor", hostile]);
      await git(root, ["config", "core.hooksPath", hooks]);
      await expect(validatePreparedExecutionWorkspace({ db, projectId, prepared })).resolves.toMatchObject({
        path: worktree,
        headSha: head,
      });
      await expect(fs.access(hostileMarker)).rejects.toThrow();
      const priorGitDir = process.env.GIT_DIR;
      const priorGitWorkTree = process.env.GIT_WORK_TREE;
      const priorPath = process.env.PATH;
      process.env.GIT_DIR = path.join(parent, "not-the-repository");
      process.env.GIT_WORK_TREE = path.join(parent, "not-the-worktree");
      process.env.PATH = parent;
      try {
        await expect(validatePreparedExecutionWorkspace({ db, projectId, prepared })).resolves.toMatchObject({
          path: worktree,
          headSha: head,
        });
      } finally {
        if (priorGitDir === undefined) delete process.env.GIT_DIR;
        else process.env.GIT_DIR = priorGitDir;
        if (priorGitWorkTree === undefined) delete process.env.GIT_WORK_TREE;
        else process.env.GIT_WORK_TREE = priorGitWorkTree;
        if (priorPath === undefined) delete process.env.PATH;
        else process.env.PATH = priorPath;
      }
      await git(root, ["config", "--unset", "core.fsmonitor"]);
      await git(root, ["config", "--unset", "core.hooksPath"]);

      const submoduleRoot = path.join(parent, "submodule");
      await fs.mkdir(submoduleRoot);
      await git(submoduleRoot, ["init", "-b", "main"]);
      await git(submoduleRoot, ["config", "user.email", "test@example.com"]);
      await git(submoduleRoot, ["config", "user.name", "Test"]);
      await fs.writeFile(path.join(submoduleRoot, "tracked.txt"), "clean\n", "utf8");
      await git(submoduleRoot, ["add", "tracked.txt"]);
      await git(submoduleRoot, ["commit", "-m", "submodule"]);
      await git(worktree, ["-c", "protocol.file.allow=always", "submodule", "add", submoduleRoot, "vendor/sub"]);
      await git(worktree, ["add", ".gitmodules", "vendor/sub"]);
      await git(worktree, ["commit", "-m", "add submodule"]);
      prepared.authorizedStartHeadSha = (await git(worktree, ["rev-parse", "HEAD"])).stdout.trim();
      await fs.writeFile(path.join(worktree, "vendor", "sub", "tracked.txt"), "dirty\n", "utf8");
      await expect(validatePreparedExecutionWorkspace({ db, projectId, prepared })).rejects.toMatchObject({
        details: { code: "prepared_workspace_dirty" },
      });

      const primaryPrepared = {
        ...prepared,
        path: root,
        branch: "main",
        authorizedStartHeadSha: (await git(root, ["rev-parse", "HEAD"])).stdout.trim(),
      };
      await expect(validatePreparedExecutionWorkspace({ db, projectId, prepared: primaryPrepared })).rejects.toMatchObject({
        details: { code: "prepared_workspace_primary_checkout_forbidden" },
      });
    } finally {
      await fs.rm(parent, { recursive: true, force: true });
    }
  });
});
