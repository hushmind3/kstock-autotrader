import { createHash } from "node:crypto";

export function parseSignedAbsoluteInteger(value: unknown): number {
  const normalized = String(value ?? "0").replaceAll(",", "").trim();
  const parsed = Number.parseInt(normalized, 10);
  return Number.isFinite(parsed) ? Math.abs(parsed) : 0;
}

export function parseInteger(value: unknown): number {
  const normalized = String(value ?? "0").replaceAll(",", "").trim();
  const parsed = Number.parseInt(normalized, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function toIsoDateTime(value = new Date()): string {
  return value.toISOString();
}

export function koreanTradingDate(value = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(value);
}

export function stableHash(input: unknown): string {
  return createHash("sha256").update(stableStringify(input)).digest("hex");
}

function stableStringify(input: unknown): string {
  if (input === null || typeof input !== "object") return JSON.stringify(input);
  if (Array.isArray(input)) return `[${input.map(stableStringify).join(",")}]`;
  const record = input as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}

export function redactSensitive(input: unknown): unknown {
  if (Array.isArray(input)) return input.map(redactSensitive);
  if (!input || typeof input !== "object") return input;
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (/token|secret|appkey|app_key|authorization|account/i.test(key)) {
      output[key] = "[REDACTED]";
    } else {
      output[key] = redactSensitive(value);
    }
  }
  return output;
}

export function maskAccount(accountId: string): string {
  if (accountId.length <= 4) return "****";
  return `${"*".repeat(Math.max(4, accountId.length - 4))}${accountId.slice(-4)}`;
}
