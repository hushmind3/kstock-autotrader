import { BrokerRejectedError } from "@kstock/shared";
import type { JsonRecord } from "./types.js";

const SENSITIVE_KEY =
  /(?:app.?secret|app.?key|access.?token|approval.?key|authorization|secretkey|account.?name|cust.?id)/i;

export function asRecord(value: unknown): JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

export function asRecords(value: unknown): JsonRecord[] {
  return Array.isArray(value) ? value.map(asRecord) : [];
}

export function stringValue(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

export function numberValue(value: unknown, fallback = 0): number {
  const normalized = stringValue(value).replaceAll(",", "");
  if (normalized === "") return fallback;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function requirePositiveInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new BrokerRejectedError(`${field} must be a positive integer`, "VALIDATION");
  }
}

export function requireSymbol(symbol: string): string {
  const normalized = symbol.trim().toUpperCase();
  if (!/^[0-9A-Z]{6}$/.test(normalized)) {
    throw new BrokerRejectedError(
      "KIS domestic-stock symbol must be six alphanumeric characters",
      "INVALID_SYMBOL",
    );
  }
  return normalized;
}

export function redactSensitive(value: unknown, depth = 0): unknown {
  if (depth > 5) return "[TRUNCATED]";
  if (Array.isArray(value)) {
    return value.slice(0, 100).map((item) => redactSensitive(item, depth + 1));
  }
  if (value !== null && typeof value === "object") {
    const redacted: JsonRecord = {};
    for (const [key, child] of Object.entries(value as JsonRecord)) {
      redacted[key] = SENSITIVE_KEY.test(key)
        ? "[REDACTED]"
        : redactSensitive(child, depth + 1);
    }
    return redacted;
  }
  if (typeof value === "string" && value.length > 4_096) {
    return `${value.slice(0, 4_096)}…`;
  }
  return value;
}

export function parseAccountId(
  accountId: string,
  explicitProductCode?: string,
): { cano: string; productCode: string } {
  const compact = accountId.replaceAll("-", "").trim();
  const cano = compact.slice(0, 8);
  const productCode = explicitProductCode ?? (compact.slice(8, 10) || "01");
  if (!/^\d{8}$/.test(cano) || !/^\d{2}$/.test(productCode)) {
    throw new BrokerRejectedError(
      "KIS accountId must contain an eight-digit CANO and a two-digit product code",
      "INVALID_ACCOUNT",
    );
  }
  return { cano, productCode };
}

export function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function yyyymmdd(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}${get("month")}${get("day")}`;
}

export function currentKisDateTime(now = new Date()): {
  date: string;
  time: string;
} {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? "00";
  return {
    date: `${get("year")}${get("month")}${get("day")}`,
    time: `${get("hour")}${get("minute")}${get("second")}`,
  };
}

export function domainTradingDate(value: string): string {
  if (!/^\d{8}$/.test(value)) {
    throw new BrokerRejectedError("KIS returned a malformed trading date", "MALFORMED_DATE");
  }
  return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
}

export function isoFromKis(date: string, time: string): string {
  if (!/^\d{8}$/.test(date) || !/^\d{6}$/.test(time)) {
    return new Date().toISOString();
  }
  return `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T${time.slice(0, 2)}:${time.slice(2, 4)}:${time.slice(4, 6)}+09:00`;
}

export function dateDaysAgo(days: number, now = new Date()): Date {
  return new Date(now.getTime() - days * 86_400_000);
}

export function isYyyymmdd(value: string): boolean {
  return /^\d{8}$/.test(value) && !Number.isNaN(Date.parse(
    `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T00:00:00Z`,
  ));
}

export function encodeBrokerOrderId(branch: string, orderNumber: string): string {
  const cleanBranch = branch.trim();
  const cleanOrder = orderNumber.trim();
  return cleanBranch === "" ? cleanOrder : `${cleanBranch}:${cleanOrder}`;
}

export function decodeBrokerOrderId(value: string): {
  branch: string;
  orderNumber: string;
} {
  const separator = value.indexOf(":");
  if (separator < 0) return { branch: "", orderNumber: value.trim() };
  return {
    branch: value.slice(0, separator).trim(),
    orderNumber: value.slice(separator + 1).trim(),
  };
}

export function sideFromKis(value: unknown): "buy" | "sell" {
  const code = stringValue(value);
  const lower = code.toLowerCase();
  return code === "01" || lower.includes("sell") || code.includes("매도")
    ? "sell"
    : "buy";
}

export function orderTypeFromKis(code: unknown, price: unknown): "market" | "limit" {
  return stringValue(code) === "01" || numberValue(price) === 0
    ? "market"
    : "limit";
}
