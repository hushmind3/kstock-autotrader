import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const TOKEN_FILE = ".admin-token";

export async function ensureAdminToken(dataDirectory: string): Promise<string> {
  const configured = process.env.KSTOCK_ADMIN_TOKEN?.trim();
  if (configured) {
    if (configured.length < 32) throw new Error("KSTOCK_ADMIN_TOKEN must be at least 32 characters");
    return configured;
  }
  await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
  const tokenPath = path.join(dataDirectory, TOKEN_FILE);
  try {
    const existing = (await readFile(tokenPath, "utf8")).trim();
    if (existing.length >= 32) return existing;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const token = randomBytes(32).toString("hex");
  await writeFile(tokenPath, `${token}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  return token;
}

export function adminTokenMatches(expected: string, provided: string | undefined): boolean {
  if (!provided) return false;
  const expectedBuffer = Buffer.from(expected);
  const providedBuffer = Buffer.from(provided);
  return expectedBuffer.length === providedBuffer.length && timingSafeEqual(expectedBuffer, providedBuffer);
}
