import { readFile, readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const assetsDirectory = resolve(packageRoot, "dist-phase7/assets");
const bundleNames = (await readdir(assetsDirectory)).filter((name) => name.endsWith(".js"));

if (bundleNames.length === 0) {
  throw new Error("Phase 7 build produced no JavaScript bundle");
}

const forbidden = [
  ["new Function", "dynamic Function construction"],
  ["Error compiling schema, function code:", "AJV runtime schema compilation"],
];

for (const name of bundleNames) {
  const source = await readFile(resolve(assetsDirectory, name), "utf8");
  for (const [needle, description] of forbidden) {
    if (source.includes(needle)) {
      throw new Error(`${name} contains ${description}, which strict Phase 7I CSP blocks`);
    }
  }
}

process.stdout.write("Phase 7 bundle is compatible with the strict Phase 7I CSP.\n");
