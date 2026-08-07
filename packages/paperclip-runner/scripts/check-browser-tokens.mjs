import { readFile, readdir } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = resolve(packageRoot, "devtools/browser/src");

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const path = resolve(directory, entry.name);
      return entry.isDirectory() ? sourceFiles(path) : [path];
    }),
  );
  return nested.flat();
}

const componentRules = [
  ["hex color", /#[0-9a-f]{3,8}\b/i],
  ["raw pixel value", /\b\d+(?:\.\d+)?px\b/],
  ["inline style", /\bstyle\s*=\s*\{/],
  ["raw font size", /\bfont(?:-size|Size)\s*[:=]/],
  ["arbitrary Tailwind value", /\b[a-z-]+-\[[^\]]+\]/],
];
const violations = [];

for (const path of await sourceFiles(sourceRoot)) {
  if (![".ts", ".tsx"].includes(extname(path))) {
    continue;
  }
  const source = await readFile(path, "utf8");
  for (const [label, pattern] of componentRules) {
    if (pattern.test(source)) {
      violations.push(`${path.slice(packageRoot.length + 1)}: ${label}`);
    }
  }
}

const styles = await readFile(resolve(sourceRoot, "styles.css"), "utf8");
for (const token of [
  "--background",
  "--foreground",
  "--card",
  "--primary",
  "--muted",
  "--border",
  "--ring",
  "--font-sans",
  "--font-mono",
  "--space-1",
  "--radius-sm",
  "--motion-fast",
]) {
  if (!styles.includes(`${token}:`)) {
    violations.push(`devtools/browser/src/styles.css: missing ${token}`);
  }
}

if (violations.length > 0) {
  process.stderr.write(`Standalone browser token check failed:\n- ${violations.join("\n- ")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(
    "Standalone browser token check passed; component visual values stay in styles.css.\n",
  );
}
