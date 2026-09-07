import { readFile } from "node:fs/promises";
import path from "node:path";

export async function findProjectRoot(start = process.cwd()): Promise<string> {
  let current = path.resolve(start);
  while (true) {
    try {
      const packageJson = JSON.parse(await readFile(path.join(current, "package.json"), "utf8")) as {
        name?: string;
      };
      if (packageJson.name === "kstock-autotrader") return current;
    } catch {
      // Walk up to the monorepo root.
    }
    const parent = path.dirname(current);
    if (parent === current) throw new Error("K-Stock project root was not found");
    current = parent;
  }
}
