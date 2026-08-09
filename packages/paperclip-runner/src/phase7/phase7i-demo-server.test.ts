import { readFile } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  assertPhase7iEnvironmentSafe,
  forbiddenPhase7iEnvironmentNames,
  Phase7iDemoRuntime,
} from "./phase7i-demo-server.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const sourceRoot = resolve(packageRoot, "src");

describe("Phase 7I deployment boundary", () => {
  it("constructs the concrete mock and initializes a ready, bounded runtime", async () => {
    const runtime = new Phase7iDemoRuntime({
      publicOrigin: "https://phase7i.example.ts.net",
      basePath: "/phase7i",
      commitSha: "deadbeef",
      packageRoot,
      log: () => undefined,
    });
    await runtime.initialize();
    expect(runtime.health()).toMatchObject({
      ready: true,
      commitSha: "deadbeef",
      controlPlane: "phase7-mock",
      providerAuthentication: "server-side",
      credentialsExposed: false,
      networkEgress: "denied",
      retention: "memory-only",
      activeSessions: 0,
    });
    await runtime.shutdown();
  });

  it("rejects ambient credential families by name without inspecting values", () => {
    const unsafe = {
      PATH: "/usr/bin",
      PAPERCLIP_API_KEY: "not-read",
      AWS_SECRET_ACCESS_KEY: "not-read",
      OPENAI_API_KEY: "not-read",
      VERCEL_TOKEN: "not-read",
    };
    expect(forbiddenPhase7iEnvironmentNames(unsafe)).toEqual([
      "AWS_SECRET_ACCESS_KEY",
      "OPENAI_API_KEY",
      "PAPERCLIP_API_KEY",
      "VERCEL_TOKEN",
    ]);
    expect(() => assertPhase7iEnvironmentSafe(unsafe)).toThrow(/forbidden environment names/);
    expect(() => assertPhase7iEnvironmentSafe({
      NODE_ENV: "production",
      PATH: "/usr/bin",
      PHASE7I_COMMIT_SHA: "deadbeef",
      PHASE7I_PUBLIC_ORIGIN: "https://phase7i.example.ts.net",
    })).not.toThrow();
  });

  it("keeps the deployed source closure package-local, mock-only, and free of dynamic imports", async () => {
    const closure = await sourceClosure(resolve(sourceRoot, "phase7/phase7i-demo-server.ts"));
    const rootSource = await readFile(resolve(sourceRoot, "phase7/phase7i-demo-server.ts"), "utf8");
    expect(rootSource).toContain('import { Phase7MockControlPlaneAdapter }');
    expect(rootSource).toContain("new Phase7MockControlPlaneAdapter(fixture.seed)");
    expect(closure.size).toBeGreaterThan(10);

    for (const [path, source] of closure) {
      expect(source, path).not.toMatch(/\bimport\s*\(/);
      expect(source, path).not.toMatch(/PaperclipControlPlanePort|PAPERCLIP_API_(?:URL|KEY)|@paperclipai\/db/);
      for (const specifier of importSpecifiers(source)) {
        expect(specifier, `${path} imports outside the standalone boundary`).not.toMatch(
          /^(?:server|ui|cli)(?:\/|$)|^@paperclipai\/(?!paperclip-runner(?:\/|$))/,
        );
      }
    }
  });
});

function importSpecifiers(source: string): string[] {
  const matches = source.matchAll(/\b(?:import|export)\s+(?:type\s+)?(?:[^"'`;]{0,500}?\s+from\s+)?["']([^"']+)["']/g);
  return [...matches].map((match) => match[1]!);
}

async function sourceClosure(entry: string): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  const visit = async (path: string): Promise<void> => {
    if (found.has(path)) return;
    const source = await readFile(path, "utf8");
    found.set(path, source);
    for (const specifier of importSpecifiers(source)) {
      if (!specifier.startsWith(".")) continue;
      const imported = resolve(dirname(path), specifier);
      const target = extname(imported) === ".js" ? `${imported.slice(0, -3)}.ts` : imported;
      await visit(target);
    }
  };
  await visit(entry);
  return found;
}
