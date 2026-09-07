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
      // Continue walking until the workspace package is found.
    }
    const parent = path.dirname(current);
    if (parent === current) throw new Error("Unable to locate the kstock-autotrader project root");
    current = parent;
  }
}

export async function resolveDataDirectory(): Promise<string> {
  if (process.env.KSTOCK_DATA_DIR) return path.resolve(process.env.KSTOCK_DATA_DIR);
  return path.join(await findProjectRoot(), "data");
}
