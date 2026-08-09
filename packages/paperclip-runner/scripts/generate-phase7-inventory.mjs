import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  buildInventories,
  encodeInventory,
  renderContractModule,
  renderDocumentation,
  validateInventorySchema,
  validateInventories,
} from "./lib/phase7-inventory.mjs";

const packageRoot = resolve(import.meta.dirname, "..");
const repoRoot = resolve(packageRoot, "../..");
const evalCandidates = [
  resolve(repoRoot, "../paperclip-evals/paperclip-skill-optimization"),
  resolve(repoRoot, "../../../../paperclip-evals/paperclip-skill-optimization"),
];
const evalRoot = process.env.PAPERCLIP_EVALS_ROOT
  ?? (await (async () => {
    for (const candidate of evalCandidates) {
      if (await access(candidate).then(() => true, () => false)) return candidate;
    }
    throw new Error(`Paperclip eval corpus not found. Set PAPERCLIP_EVALS_ROOT. Checked:\n${evalCandidates.join("\n")}`);
  })());
const outputPaths = {
  capabilities: resolve(packageRoot, "spec/phase-07/capabilities.yaml"),
  evaluations: resolve(packageRoot, "spec/phase-07/eval-traceability.yaml"),
  legacyMcpAliases: resolve(packageRoot, "spec/phase-07/mcp-tool-map.yaml"),
  contract: resolve(packageRoot, "src/generated/phase7-capability-contract.ts"),
  documentation: resolve(packageRoot, "docs/phase-07-capability-contract.md"),
};

const inventories = await buildInventories({ repoRoot, evalRoot });
const inventorySchema = JSON.parse(await readFile(resolve(packageRoot, "spec/phase-07/inventory.schema.json"), "utf8"));
const errors = [
  ...validateInventorySchema(inventories, inventorySchema),
  ...validateInventories(inventories),
];
if (errors.length > 0) throw new Error(`Phase 7 inventory generation failed:\n${errors.join("\n")}`);

const outputs = {
  [outputPaths.capabilities]: encodeInventory(inventories.capabilities),
  [outputPaths.evaluations]: encodeInventory(inventories.evaluations),
  [outputPaths.legacyMcpAliases]: encodeInventory(inventories.legacyMcpAliases),
  [outputPaths.contract]: renderContractModule(inventories),
  [outputPaths.documentation]: renderDocumentation(inventories),
};

if (process.argv.includes("--check")) {
  const stale = [];
  for (const [path, content] of Object.entries(outputs)) {
    if (await readFile(path, "utf8").catch(() => "") !== content) stale.push(path);
  }
  if (stale.length > 0) throw new Error(`Phase 7 generated outputs are stale:\n${stale.join("\n")}`);
  process.stdout.write("Phase 7 inventories and generated contract match the canonical baselines.\n");
} else {
  await Promise.all(Object.entries(outputs).map(async ([path, content]) => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  }));
  process.stdout.write("Generated Phase 7 capability inventories, TypeScript contract, and documentation.\n");
}
