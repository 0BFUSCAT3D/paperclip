import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  SubscriptionAuthAuthorityInspectInput,
  SubscriptionAuthAuthorityOpaqueDomain,
} from "@paperclipai/adapter-utils";
import {
  readSecureEffectiveCodexSubscriptionAuth,
  resolveManagedCodexHomeDir,
  seedManagedCodexHome,
} from "./codex-home.js";
import { inspectCodexSubscriptionAuthAuthority } from "./subscription-auth-authority.js";

const COMPANY_ID = "11111111-1111-4111-8111-111111111111";
const AGENT_ID = "22222222-2222-4222-8222-222222222222";
const tempRoots: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

function signOpaque(domain: SubscriptionAuthAuthorityOpaqueDomain, material: Uint8Array) {
  return `decision-spec-v1.${createHash("sha256").update(domain).update(material).digest("hex")}`;
}

function auth(accountId: string, marker: string) {
  return JSON.stringify({
    auth_mode: "chatgpt",
    tokens: {
      account_id: accountId,
      id_token: `id-${marker}`,
      access_token: `access-${marker}`,
      refresh_token: `refresh-${marker}`,
    },
  });
}

async function fixture(bytes = auth("account-a", "one")) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-auth-authority-test-")));
  tempRoots.push(root);
  vi.stubEnv("PAPERCLIP_HOME", root);
  const home = resolveManagedCodexHomeDir(process.env, COMPANY_ID, AGENT_ID);
  await fs.mkdir(home, { recursive: true, mode: 0o700 });
  await secureManagedChain(root, home);
  await fs.writeFile(path.join(home, "auth.json"), bytes, { mode: 0o600 });
  const input: SubscriptionAuthAuthorityInspectInput = {
    mode: "inspect",
    adapterType: "codex_local",
    companyId: COMPANY_ID,
    agentId: AGENT_ID,
    config: { billingPolicy: "subscription_only", engine: "cli", env: {} },
    env: {},
    authSource: { kind: "managed_local_profile", profile: "codex_agent_home", location: home },
    signOpaque,
  };
  return { root, home, authPath: path.join(home, "auth.json"), input };
}

describe("Codex subscription auth authority", () => {
  it("is deterministic; account changes identity while byte changes rotate revisions", async () => {
    const fx = await fixture();
    const first = await inspectCodexSubscriptionAuthAuthority(fx.input);
    const second = await inspectCodexSubscriptionAuthAuthority(fx.input);
    expect(first).toEqual(second);
    expect(first.prepared).toBeUndefined();
    expect(first.proof.account.evidence).toBe("account_id_bound");
    expect(JSON.stringify(first.proof)).not.toContain("account-a");
    expect(JSON.stringify(first.proof)).not.toContain(fx.home);

    await fs.writeFile(fx.authPath, auth("account-a", "two"), { mode: 0o600 });
    const changedBytes = await inspectCodexSubscriptionAuthAuthority(fx.input);
    expect(changedBytes.proof.account.identityFingerprint).toBe(first.proof.account.identityFingerprint);
    expect(changedBytes.proof.account.revisionFingerprint).not.toBe(first.proof.account.revisionFingerprint);
    expect(changedBytes.proof.credentialRevisionFingerprint).not.toBe(first.proof.credentialRevisionFingerprint);

    await fs.writeFile(fx.authPath, auth("account-b", "two"), { mode: 0o600 });
    const changedAccount = await inspectCodexSubscriptionAuthAuthority(fx.input);
    expect(changedAccount.proof.authProfile.identityFingerprint).toBe(first.proof.authProfile.identityFingerprint);
    expect(changedAccount.proof.account.identityFingerprint).not.toBe(first.proof.account.identityFingerprint);
    expect(changedAccount.proof.principal.identityFingerprint).not.toBe(first.proof.principal.identityFingerprint);
  });

  it("rejects symlink, permissive, oversized, and malformed auth sources", async () => {
    const fx = await fixture();
    const target = path.join(fx.root, "target-auth.json");
    await fs.rename(fx.authPath, target);
    await fs.symlink(target, fx.authPath);
    await expect(inspectCodexSubscriptionAuthAuthority(fx.input)).rejects.toMatchObject({
      code: "subscription_auth_unverifiable",
    });

    await fs.rm(fx.authPath);
    await fs.writeFile(fx.authPath, auth("account-a", "mode"), { mode: 0o666 });
    if (process.platform !== "win32") {
      await fs.chmod(fx.authPath, 0o666);
      await expect(inspectCodexSubscriptionAuthAuthority(fx.input)).rejects.toMatchObject({
        code: "subscription_auth_unverifiable",
      });
    }

    await fs.writeFile(fx.authPath, "x".repeat(64 * 1024 + 1), { mode: 0o600 });
    if (process.platform !== "win32") await fs.chmod(fx.authPath, 0o600);
    await expect(inspectCodexSubscriptionAuthAuthority(fx.input)).rejects.toMatchObject({
      code: "subscription_auth_unverifiable",
    });
    await fs.writeFile(fx.authPath, JSON.stringify({ auth_mode: "chatgpt", tokens: { account_id: randomUUID() } }), { mode: 0o600 });
    if (process.platform !== "win32") await fs.chmod(fx.authPath, 0o600);
    await expect(inspectCodexSubscriptionAuthAuthority(fx.input)).rejects.toMatchObject({
      code: "subscription_auth_unverifiable",
    });
  });

  it("inspect writes nothing; prepare snapshots exact captured bytes, applies, and cleans without copyback", async () => {
    const original = auth("account-a", "captured");
    const replacement = auth("account-b", "mutated");
    const fx = await fixture(original);
    const beforeTmp = new Set((await fs.readdir(os.tmpdir())).filter((name) => name.startsWith("paperclip-codex-auth-authority-")));
    const inspected = await inspectCodexSubscriptionAuthAuthority(fx.input);
    expect(inspected.prepared).toBeUndefined();
    const afterTmp = new Set((await fs.readdir(os.tmpdir())).filter((name) => name.startsWith("paperclip-codex-auth-authority-")));
    expect(afterTmp).toEqual(beforeTmp);

    const prepared = await inspectCodexSubscriptionAuthAuthority({ ...fx.input, mode: "prepare" });
    expect(prepared.prepared).toBeDefined();
    await fs.writeFile(fx.authPath, replacement, { mode: 0o600 });
    const env: Record<string, string> = {};
    await prepared.prepared!.apply({ env });
    const snapshotHome = env.CODEX_HOME!;
    const [homeStats, authStats, snapshotBytes] = await Promise.all([
      fs.stat(snapshotHome),
      fs.stat(path.join(snapshotHome, "auth.json")),
      fs.readFile(path.join(snapshotHome, "auth.json"), "utf8"),
    ]);
    if (process.platform !== "win32") {
      expect(homeStats.mode & 0o777).toBe(0o700);
      expect(authStats.mode & 0o777).toBe(0o600);
    }
    expect(snapshotBytes).toBe(original);
    await prepared.prepared!.dispose();
    await expect(fs.stat(snapshotHome)).rejects.toMatchObject({ code: "ENOENT" });
    expect(env.CODEX_HOME).toBeUndefined();
    expect(await fs.readFile(fx.authPath, "utf8")).toBe(replacement);
  });

  it("accepts only the standard seeded shared-auth symlink and captures its exact bytes", async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-auth-authority-seed-")));
    tempRoots.push(root);
    const sharedHome = path.join(root, "shared-codex");
    vi.stubEnv("PAPERCLIP_HOME", root);
    vi.stubEnv("CODEX_HOME", sharedHome);
    await fs.mkdir(sharedHome, { recursive: true, mode: 0o700 });
    const original = auth("account-seeded", "captured");
    await fs.writeFile(path.join(sharedHome, "auth.json"), original, { mode: 0o600 });
    const home = resolveManagedCodexHomeDir(process.env, COMPANY_ID, AGENT_ID);
    await seedManagedCodexHome(home, process.env, async () => undefined);
    expect((await fs.lstat(path.join(home, "auth.json"))).isSymbolicLink()).toBe(true);
    const prepared = await inspectCodexSubscriptionAuthAuthority({
      ...inputForHome(home),
      mode: "prepare",
    });
    await fs.writeFile(path.join(sharedHome, "auth.json"), auth("account-other", "mutated"), { mode: 0o600 });
    const env: Record<string, string> = {};
    await prepared.prepared!.apply({ env });
    expect(await fs.readFile(path.join(env.CODEX_HOME!, "auth.json"), "utf8")).toBe(original);
    await prepared.prepared!.dispose();
  });

  it("rejects a managed symlink swapped after opening its canonical target", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-auth-authority-swap-"));
    tempRoots.push(root);
    const sharedHome = path.join(root, "shared-codex");
    vi.stubEnv("CODEX_HOME", sharedHome);
    await fs.mkdir(sharedHome, { recursive: true });
    await fs.writeFile(path.join(sharedHome, "auth.json"), auth("account-a", "one"), { mode: 0o600 });
    const home = path.join(root, "agent-home");
    await fs.mkdir(home);
    const agentAuth = path.join(home, "auth.json");
    await fs.symlink(path.join(sharedHome, "auth.json"), agentAuth);
    const alternate = path.join(root, "alternate.json");
    await fs.writeFile(alternate, auth("account-b", "two"), { mode: 0o600 });
    const result = await readSecureEffectiveCodexSubscriptionAuth(home, process.env, {
      afterOpen: async () => {
        await fs.rm(agentAuth);
        await fs.symlink(alternate, agentAuth);
      },
    });
    expect(result.status).toBe("unverifiable");
    expect(result.snapshot).toBeUndefined();
  });

  it("rechecks opened-file permissions after open", async () => {
    if (process.platform === "win32") return;
    const fx = await fixture();
    const result = await readSecureEffectiveCodexSubscriptionAuth(fx.home, process.env, {
      afterOpen: () => fs.chmod(fx.authPath, 0o666),
    });
    expect(result.status).toBe("unverifiable");
  });

  it("rejects a managed ancestor swapped out and restored during auth capture", async () => {
    const fx = await fixture();
    const instanceRoot = path.join(fx.root, "instances", "default");
    const companyDir = path.join(instanceRoot, "companies", COMPANY_ID);
    const heldCompanyDir = path.join(fx.root, "held-company");
    const externalCompanyDir = path.join(fx.root, "external-company-swap");
    await fs.mkdir(externalCompanyDir, { recursive: true, mode: 0o700 });

    await expect(inspectCodexSubscriptionAuthAuthority(fx.input, {
      authRead: {
        afterRead: async () => {
          await fs.rename(companyDir, heldCompanyDir);
          await fs.symlink(externalCompanyDir, companyDir);
          await fs.rm(companyDir);
          await fs.rename(heldCompanyDir, companyDir);
        },
      },
    })).rejects.toMatchObject({ code: "subscription_auth_unverifiable" });
  });

  it("repairs replaced bytes and mode before every apply and retries failed cleanup", async () => {
    const original = auth("account-a", "captured");
    const fx = await fixture(original);
    const prepared = await inspectCodexSubscriptionAuthAuthority({ ...fx.input, mode: "prepare" });
    const env: Record<string, string> = {};
    await prepared.prepared!.apply({ env });
    const snapshotHome = env.CODEX_HOME!;
    const snapshotAuth = path.join(snapshotHome, "auth.json");
    await fs.writeFile(snapshotAuth, auth("forged", "forged"));
    if (process.platform !== "win32") await fs.chmod(snapshotAuth, 0o666);
    await prepared.prepared!.apply({ env });
    expect(await fs.readFile(snapshotAuth, "utf8")).toBe(original);
    if (process.platform !== "win32") expect((await fs.stat(snapshotAuth)).mode & 0o777).toBe(0o600);

    const originalRm = fs.rm.bind(fs);
    const rmSpy = vi.spyOn(fs, "rm").mockRejectedValueOnce(new Error("injected cleanup failure"));
    await expect(prepared.prepared!.dispose()).rejects.toThrow("injected cleanup failure");
    rmSpy.mockImplementation(originalRm);
    await prepared.prepared!.dispose();
    expect(await fs.lstat(snapshotHome).catch(() => null)).toBeNull();
    rmSpy.mockRestore();
  });

  it.each([
    "canonical home symlink",
    "company parent symlink",
    "managed root symlink",
    "non-directory parent",
  ] as const)("rejects redirectable managed ancestry: %s", async (attack) => {
    const fx = await fixture();
    const instanceRoot = path.join(fx.root, "instances", "default");
    const companyDir = path.join(instanceRoot, "companies", COMPANY_ID);
    const agentDir = path.join(companyDir, "agents", AGENT_ID);
    if (attack === "canonical home symlink") {
      const external = path.join(fx.root, "external-home");
      await fs.mkdir(external, { recursive: true, mode: 0o700 });
      await fs.writeFile(path.join(external, "auth.json"), auth("external", "home"), { mode: 0o600 });
      await fs.rm(fx.home, { recursive: true });
      await fs.symlink(external, fx.home);
    } else if (attack === "company parent symlink") {
      const external = path.join(fx.root, "external-company");
      const externalHome = path.join(external, "agents", AGENT_ID, "codex-home");
      await fs.mkdir(externalHome, { recursive: true, mode: 0o700 });
      await fs.writeFile(path.join(externalHome, "auth.json"), auth("external", "company"), { mode: 0o600 });
      await fs.rm(companyDir, { recursive: true });
      await fs.symlink(external, companyDir);
    } else if (attack === "managed root symlink") {
      const external = path.join(fx.root, "external-instance");
      const externalHome = path.join(external, "companies", COMPANY_ID, "agents", AGENT_ID, "codex-home");
      await fs.mkdir(externalHome, { recursive: true, mode: 0o700 });
      await fs.writeFile(path.join(externalHome, "auth.json"), auth("external", "root"), { mode: 0o600 });
      await fs.rm(instanceRoot, { recursive: true });
      await fs.symlink(external, instanceRoot);
    } else {
      await fs.rm(agentDir, { recursive: true });
      await fs.writeFile(agentDir, "not-a-directory", { mode: 0o600 });
    }
    await expect(inspectCodexSubscriptionAuthAuthority(fx.input)).rejects.toMatchObject({
      code: "subscription_auth_unverifiable",
    });
  });

  it("rejects group/other-accessible managed parents and a mismatched owner", async () => {
    if (process.platform === "win32") return;
    const fx = await fixture();
    const companyDir = path.join(fx.root, "instances", "default", "companies", COMPANY_ID);
    await fs.chmod(companyDir, 0o750);
    await expect(inspectCodexSubscriptionAuthAuthority(fx.input)).rejects.toMatchObject({
      code: "subscription_auth_unverifiable",
    });
    await fs.chmod(companyDir, 0o700);

    const realLstat = fs.lstat.bind(fs);
    const lstatSpy = vi.spyOn(fs, "lstat").mockImplementation((async (candidate: Parameters<typeof fs.lstat>[0]) => {
      const stats = await realLstat(candidate);
      if (path.resolve(String(candidate)) !== companyDir) return stats;
      return new Proxy(stats, {
        get(target, property, receiver) {
          if (property === "uid") return target.uid + 1;
          return Reflect.get(target, property, receiver);
        },
      });
    }) as typeof fs.lstat);
    await expect(inspectCodexSubscriptionAuthAuthority(fx.input)).rejects.toMatchObject({
      code: "subscription_auth_unverifiable",
    });
    lstatSpy.mockRestore();
  });
});

async function secureManagedChain(root: string, home: string): Promise<void> {
  const instanceRoot = path.join(root, "instances", "default");
  let cursor = instanceRoot;
  await fs.chmod(cursor, 0o700);
  const relative = path.relative(instanceRoot, home).split(path.sep).filter(Boolean);
  for (const component of relative) {
    cursor = path.join(cursor, component);
    await fs.chmod(cursor, 0o700);
  }
}

function inputForHome(home: string): SubscriptionAuthAuthorityInspectInput {
  return {
    mode: "inspect",
    adapterType: "codex_local",
    companyId: COMPANY_ID,
    agentId: AGENT_ID,
    config: { billingPolicy: "subscription_only", engine: "cli", env: {} },
    env: {},
    authSource: { kind: "managed_local_profile", profile: "codex_agent_home", location: home },
    signOpaque,
  };
}
