import type { Exchange, OrderSide, OrderStatus, OrderType } from "@kstock/shared";

import { KiwoomProtocolError } from "./errors.js";

export type UnknownRecord = Record<string, unknown>;

const SEOUL_TIME_ZONE = "Asia/Seoul";
const KST_DATE_TIME_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  timeZone: SEOUL_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

export function asRecord(value: unknown): UnknownRecord | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as UnknownRecord;
}

export function recordsAt(record: UnknownRecord, key: string): UnknownRecord[] {
  const value = record[key];
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const parsed = asRecord(entry);
    return parsed === undefined ? [] : [parsed];
  });
}

export function stringAt(record: UnknownRecord, key: string): string | undefined {
  const value = record[key];
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

export function requiredString(
  record: UnknownRecord,
  key: string,
  context: string,
): string {
  const value = stringAt(record, key);
  if (value === undefined || value.length === 0) {
    throw new KiwoomProtocolError(
      `Kiwoom response omitted required ${context} field.`,
      "MALFORMED_RESPONSE",
    );
  }
  return value;
}

export function brokerNumber(value: unknown): number | undefined {
  let normalized: string;
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value !== "string") return undefined;
  normalized = value.trim().replaceAll(",", "").replace(/%$/, "");
  if (normalized.length === 0) return undefined;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function requiredBrokerNumber(
  record: UnknownRecord,
  key: string,
  context: string,
): number {
  const value = brokerNumber(record[key]);
  if (value === undefined) {
    throw new KiwoomProtocolError(
      `Kiwoom response omitted or malformed required ${context} field.`,
      "MALFORMED_RESPONSE",
    );
  }
  return value;
}

/**
 * Kiwoom prefixes current prices with the direction sign. A value such as
 * "-82000" means KRW 82,000 after a downward move, not a negative price.
 */
export function brokerPrice(value: unknown): number | undefined {
  const parsed = brokerNumber(value);
  return parsed === undefined ? undefined : Math.abs(parsed);
}

export function requiredBrokerPrice(
  record: UnknownRecord,
  key: string,
  context: string,
): number {
  const value = brokerPrice(record[key]);
  if (value === undefined) {
    throw new KiwoomProtocolError(
      `Kiwoom response omitted or malformed required ${context} field.`,
      "MALFORMED_RESPONSE",
    );
  }
  return value;
}

export function normalizeSymbol(value: string): string {
  // Kiwoom can prefix domestic symbols with A/J/Q and append an exchange
  // suffix (for example, A005930_KRX). KRX short codes are six characters,
  // but are not necessarily numeric: preferred shares such as 00088K are
  // valid order/quote symbols.
  const withoutExchangeSuffix = value.trim().toUpperCase().split("_", 1)[0] ?? "";
  if (/^[AJQ][0-9A-Z]{6}$/.test(withoutExchangeSuffix)) {
    return withoutExchangeSuffix.slice(1);
  }
  return withoutExchangeSuffix;
}

/** Convert the engine's canonical six-character code to Kiwoom's quote route. */
export function kiwoomQuoteSymbol(symbol: string, exchange: Exchange): string {
  const normalized = assertSymbol(symbol);
  switch (exchange) {
    case "KRX":
      return normalized;
    case "NXT":
      return `${normalized}_NX`;
    case "SOR":
      return `${normalized}_AL`;
  }
}

/** Infer the actual requested quote route from a Kiwoom REST/WS symbol. */
export function exchangeFromKiwoomQuoteSymbol(
  value: string,
  fallback: Exchange = "KRX",
): Exchange {
  const normalized = value.trim().toUpperCase();
  if (normalized.endsWith("_NX")) return "NXT";
  if (normalized.endsWith("_AL")) return "SOR";
  if (normalized.endsWith("_KRX")) return "KRX";
  return fallback;
}

export function assertSymbol(symbol: string): string {
  const normalized = normalizeSymbol(symbol);
  if (!/^[0-9A-Z]{6}$/.test(normalized)) {
    throw new KiwoomProtocolError(
      "Kiwoom domestic stock symbols must contain exactly six ASCII letters or digits.",
      "INVALID_SYMBOL",
    );
  }
  return normalized;
}

export function normalizeAccountId(accountId: string): string {
  return accountId.replaceAll(/[^0-9]/g, "");
}

/**
 * Kiwoom's account lookup and real-time streams use the full 10-digit account
 * number, while users commonly enter the 8-digit account root. Keep the
 * comparison strict when both sides are full account numbers so two product
 * suffixes under the same root can never be mixed.
 */
export function isSameKiwoomAccount(
  leftAccountId: string,
  rightAccountId: string,
): boolean {
  const left = normalizeAccountId(leftAccountId);
  const right = normalizeAccountId(rightAccountId);
  if (!isKiwoomAccountId(left) || !isKiwoomAccountId(right)) return false;
  if (left === right) return true;
  if (left.length === 8 && right.length === 10) return right.startsWith(left);
  if (left.length === 10 && right.length === 8) return left.startsWith(right);
  return false;
}

export function isKiwoomAccountId(accountId: string): boolean {
  return /^\d{8}(?:\d{2})?$/.test(normalizeAccountId(accountId));
}

export interface KstDateTimeParts {
  date: string;
  time: string;
}

export function kstNowParts(now = new Date()): KstDateTimeParts {
  const parts = Object.fromEntries(
    KST_DATE_TIME_FORMATTER.formatToParts(now)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  const year = parts.year;
  const month = parts.month;
  const day = parts.day;
  const hour = parts.hour;
  const minute = parts.minute;
  const second = parts.second;
  if (
    year === undefined ||
    month === undefined ||
    day === undefined ||
    hour === undefined ||
    minute === undefined ||
    second === undefined
  ) {
    throw new KiwoomProtocolError(
      "Failed to resolve the Asia/Seoul trading clock.",
      "CLOCK_ERROR",
    );
  }
  return {
    date: `${year}${month}${day}`,
    time: `${hour}${minute}${second}`,
  };
}

export function brokerDateTimeToIso(
  tradingDate: string,
  tradingTime: string | undefined,
  receivedAt = new Date(),
): string {
  if (!/^\d{8}$/.test(tradingDate)) return receivedAt.toISOString();
  const compactTime = tradingTime?.replaceAll(":", "");
  if (compactTime === undefined || !/^\d{6}$/.test(compactTime)) {
    return receivedAt.toISOString();
  }
  const timestamp = `${tradingDate.slice(0, 4)}-${tradingDate.slice(4, 6)}-${tradingDate.slice(6, 8)}T${compactTime.slice(0, 2)}:${compactTime.slice(2, 4)}:${compactTime.slice(4, 6)}+09:00`;
  const parsed = new Date(timestamp);
  return Number.isNaN(parsed.getTime()) ? receivedAt.toISOString() : parsed.toISOString();
}

export function parseOrderSide(value: string | undefined): OrderSide {
  return value?.includes("매도") === true ? "sell" : "buy";
}

export function parseOrderType(value: string | undefined): OrderType {
  return value?.includes("시장가") === true ? "market" : "limit";
}

export function parseOrderStatus(
  value: string | undefined,
  remainingQuantity: number,
  filledQuantity: number,
  orderDescription?: string,
): OrderStatus {
  const status = value ?? "";
  const description = orderDescription ?? "";
  if (status.includes("거부")) return "REJECTED";
  if (status.includes("취소") || description.includes("취소")) return "CANCELED";
  if (status.includes("정정") || description.includes("정정")) return "AMENDED";
  if (remainingQuantity <= 0 && filledQuantity > 0) return "FILLED";
  if (filledQuantity > 0) return "PARTIALLY_FILLED";
  if (status.includes("접수") || status.includes("확인")) return "ACKED";
  return "UNKNOWN";
}

export function percentToBps(value: unknown): number {
  const percent = brokerNumber(value) ?? 0;
  return Math.round(percent * 100);
}

export function redactText(value: string, sensitiveValues: readonly string[]): string {
  let redacted = value;
  for (const sensitive of sensitiveValues) {
    if (sensitive.length >= 4) redacted = redacted.replaceAll(sensitive, "[REDACTED]");
  }
  return redacted;
}

export function isYyyyMmDd(value: string): boolean {
  return /^\d{8}$/.test(value);
}

export function domainTradingDate(value: string): string {
  if (!isYyyyMmDd(value)) {
    throw new KiwoomProtocolError(
      "Kiwoom returned a malformed trading date.",
      "MALFORMED_RESPONSE",
    );
  }
  return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
}

export function enumerateKstDates(fromDate: string, toDate: string): string[] {
  if (!isYyyyMmDd(fromDate) || !isYyyyMmDd(toDate) || fromDate > toDate) {
    throw new KiwoomProtocolError(
      "Execution date range must use YYYYMMDD and cannot run backwards.",
      "INVALID_DATE_RANGE",
    );
  }
  const parseUtc = (value: string): Date =>
    new Date(`${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T00:00:00Z`);
  const cursor = parseUtc(fromDate);
  const end = parseUtc(toDate);
  if (Number.isNaN(cursor.getTime()) || Number.isNaN(end.getTime())) {
    throw new KiwoomProtocolError("Execution date range is invalid.", "INVALID_DATE_RANGE");
  }
  const result: string[] = [];
  while (cursor <= end) {
    const iso = cursor.toISOString();
    result.push(iso.slice(0, 10).replaceAll("-", ""));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return result;
}
