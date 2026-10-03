import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const sourceDirectory = dirname(fileURLToPath(import.meta.url));

function localModuleGraph(entry: string, visited = new Set<string>()): Set<string> {
  if (visited.has(entry)) return visited;
  visited.add(entry);
  const source = readFileSync(entry, "utf8");
  for (const match of source.matchAll(/(?:from\s+|export\s+\*\s+from\s+|import\s*)["'](\.[^"']+)["']/g)) {
    const specifier = match[1];
    if (!specifier) continue;
    localModuleGraph(resolve(dirname(entry), specifier.replace(/\.js$/, ".ts")), visited);
  }
  return visited;
}

it("keeps the default browser-consumable contracts entry free of Node built-ins", () => {
  const modules = [...localModuleGraph(resolve(sourceDirectory, "index.ts"))];
  for (const module of modules) expect(readFileSync(module, "utf8"), module).not.toMatch(/(?:from\s+|import\s*)["']node:/);
  expect(modules.some((module) => module.endsWith("goal-bundle-hash.server.ts"))).toBe(false);
});
