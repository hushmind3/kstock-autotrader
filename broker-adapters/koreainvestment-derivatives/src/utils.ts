import { BrokerRejectedError, BrokerTransportError } from "@kstock/shared";
import type {
  DerivativeDirection,
  DerivativeInstrumentKind,
  DerivativeOrder,
  DerivativePosition,
  DerivativeSession,
} from "./types.js";

export type JsonRecord = Record<string, unknown>;

export function asRecord(value: unknown): JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

export function asRecords(value: unknown): JsonRecord[] {
  if (!Array.isArray(value)) return [];
  return value.map(asRecord).filter((row) => Object.keys(row).length > 0);
}

export function stringValue(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

export function numericValue(value: unknown): number | undefined {
  const normalized = stringValue(value).replaceAll(",", "");
  if (normalized === "") return undefined;
  const result = Number(normalized);
  return Number.isFinite(result) ? result : undefined;
}

export function pickString(row: JsonRecord, ...keys: string[]): string {
  for (const key of keys) {
    const value = stringValue(row[key] ?? row[key.toUpperCase()]);
    if (value !== "") return value;
  }
  return "";
}

export function pickNumber(row: JsonRecord, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = numericValue(row[key] ?? row[key.toUpperCase()]);
    if (value !== undefined) return value;
  }
  return undefined;
}

export function requireDerivativeSymbol(value: string): string {
  const symbol = value.trim().toUpperCase();
  if (!/^[0-9A-Z]{6,12}$/.test(symbol)) {
    throw new BrokerRejectedError(
      "KIS derivative symbol must contain 6 to 12 uppercase letters or digits",
      "KIS_DERIVATIVE_SYMBOL_INVALID",
    );
  }
  return symbol;
}

export function requirePositiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new BrokerRejectedError(`${field} must be a positive integer`, "KIS_DERIVATIVE_QUANTITY_INVALID");
  }
  return value;
}

export function parseDerivativeAccount(
  accountId: string,
  accountProductCode?: string,
): { cano: string; productCode: "03"; scopedAccountId: string } {
  const trimmed = accountId.trim();
  if (!/^[0-9-]+$/.test(trimmed)) {
    throw new BrokerRejectedError("KIS derivatives account number may contain only digits and hyphens", "KIS_DERIVATIVE_ACCOUNT_INVALID");
  }
  const compact = trimmed.replaceAll("-", "");
  if (!/^(?:\d{8}|\d{10})$/.test(compact)) {
    throw new BrokerRejectedError("KIS derivatives account number must contain eight digits, optionally followed by product code 03", "KIS_DERIVATIVE_ACCOUNT_INVALID");
  }
  const cano = compact.length === 10 ? compact.slice(0, 8) : compact;
  const embeddedProduct = compact.length === 10 ? compact.slice(8) : "";
  if (embeddedProduct !== "" && embeddedProduct !== "03") {
    throw new BrokerRejectedError(
      "KIS domestic derivatives account number must end with product code 03",
      "KIS_DERIVATIVE_PRODUCT_CODE_INVALID",
    );
  }
  const productCode = accountProductCode?.trim() || embeddedProduct;
  if (productCode !== "03") {
    throw new BrokerRejectedError(
      "KIS domestic derivatives require account product code 03; cash product code 01 is refused",
      "KIS_DERIVATIVE_PRODUCT_CODE_INVALID",
    );
  }
  return { cano, productCode: "03", scopedAccountId: `${cano}-03` };
}

export function yyyymmdd(date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}${values.month}${values.day}`;
}

export function sideFromDirectionEffect(
  direction: DerivativeDirection,
  positionEffect: "OPEN" | "CLOSE",
): "BUY" | "SELL" {
  if (direction === "LONG") return positionEffect === "OPEN" ? "BUY" : "SELL";
  return positionEffect === "OPEN" ? "SELL" : "BUY";
}

export function directionFromBroker(row: JsonRecord): DerivativeDirection {
  const value = pickString(
    row,
    "sll_buy_dvsn_cd",
    "sll_buy_dvsn_name",
    "trad_dvsn_name",
    "trad_dvsn_cd",
  ).toUpperCase();
  if (["02", "2", "BUY", "매수"].includes(value)) return "LONG";
  if (["01", "1", "SELL", "매도"].includes(value)) return "SHORT";
  throw new BrokerTransportError(
    "KIS derivative position omitted a recognized buy/sell direction",
    "KIS_DERIVATIVE_POSITION_DIRECTION_MALFORMED",
    { keys: Object.keys(row) },
  );
}

export function parsePosition(row: JsonRecord): DerivativePosition {
  const symbol = requireDerivativeSymbol(
    pickString(row, "shtn_pdno", "pdno", "futs_shrn_iscd", "optn_shrn_iscd"),
  );
  const quantity = pickNumber(
    row,
    "cblc_qty",
    "ccld_qty_smtl",
    "ccld_qty",
    "hldg_qty",
    "fuop_hldg_qty",
    "ord_psbl_qty",
  );
  const averagePrice = pickNumber(
    row,
    "ccld_avg_unpr1",
    "ccld_avg_unpr",
    "avg_unpr",
    "pchs_avg_pric",
  );
  if (quantity === undefined || quantity < 0 || averagePrice === undefined || averagePrice < 0) {
    throw new BrokerTransportError(
      "KIS derivative position omitted required quantity or average-price fields",
      "KIS_DERIVATIVE_POSITION_MALFORMED",
      { symbol, keys: Object.keys(row) },
    );
  }
  const position: DerivativePosition = {
    symbol,
    direction: directionFromBroker(row),
    quantity,
    averagePrice,
    raw: row,
  };
  const name = pickString(row, "prdt_name", "hts_kor_isnm", "item_name");
  if (name !== "") position.name = name;
  const currentPrice = pickNumber(row, "idx_clpr", "stck_prpr", "now_pric", "prpr");
  if (currentPrice !== undefined) position.currentPrice = currentPrice;
  const profitLoss = pickNumber(row, "evlu_pfls_amt", "evlu_pfls_amt1", "evlu_pfls");
  if (profitLoss !== undefined) position.evaluationProfitLoss = profitLoss;
  return position;
}

function sideFromOrderRow(row: JsonRecord): "BUY" | "SELL" {
  return directionFromBroker(row) === "LONG" ? "BUY" : "SELL";
}

export function parseOrder(row: JsonRecord, session: DerivativeSession): DerivativeOrder {
  const brokerOrderId = pickString(row, "odno", "oder_no", "ord_no");
  const symbol = requireDerivativeSymbol(
    pickString(row, "pdno", "shtn_pdno", "stck_shrn_iscd", "futs_shrn_iscd", "optn_shrn_iscd"),
  );
  const requestedQuantity = pickNumber(row, "ord_qty", "oder_qty");
  const filledQuantity = pickNumber(row, "tot_ccld_qty", "ccld_qty", "cntg_qty") ?? 0;
  const explicitRemaining = pickNumber(row, "qty", "nccs_qty", "rmn_qty");
  if (brokerOrderId === "" || requestedQuantity === undefined || requestedQuantity < 0) {
    throw new BrokerTransportError(
      "KIS derivative order omitted order number or quantity",
      "KIS_DERIVATIVE_ORDER_MALFORMED",
      { symbol, keys: Object.keys(row) },
    );
  }
  const remainingQuantity = explicitRemaining ?? Math.max(0, requestedQuantity - filledQuantity);
  const canceled = ["Y", "1"].includes(pickString(row, "cncl_yn").toUpperCase()) ||
    ["2", "02"].includes(pickString(row, "rctf_cls").toUpperCase());
  const rejectedQuantity = pickNumber(row, "rjct_qty") ?? 0;
  const rejected = ["Y", "1"].includes(pickString(row, "rfus_yn").toUpperCase()) || rejectedQuantity > 0;
  const status = rejected
    ? "REJECTED"
    : canceled
      ? "CANCELED"
      : remainingQuantity === 0 && filledQuantity > 0
        ? "FILLED"
        : filledQuantity > 0
          ? "PARTIALLY_FILLED"
          : "OPEN";
  const order: DerivativeOrder = {
    brokerOrderId,
    symbol,
    side: sideFromOrderRow(row),
    requestedQuantity,
    filledQuantity,
    remainingQuantity,
    status,
    session,
    raw: row,
  };
  const original = pickString(row, "orgn_odno", "ooder_no");
  if (original !== "") order.originalBrokerOrderId = original;
  const orderPrice = pickNumber(row, "ord_idx", "ord_idx4", "ord_unpr", "order_prc", "unit_price");
  if (orderPrice !== undefined) order.orderPrice = orderPrice;
  const fillPrice = pickNumber(row, "avg_idx", "avg_prvs", "ccld_avg_unpr", "cntg_unpr");
  if (fillPrice !== undefined) order.averageFillPrice = fillPrice;
  const date = pickString(row, "ord_dt");
  const time = pickString(row, "ord_tmd", "stck_cntg_hour");
  if (/^\d{8}$/.test(date) && /^\d{6}$/.test(time)) {
    order.orderedAt = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T${time.slice(0, 2)}:${time.slice(2, 4)}:${time.slice(4, 6)}+09:00`;
  }
  return order;
}

export function instrumentMarketCode(kind: DerivativeInstrumentKind): "F" | "O" | "JF" | "JO" {
  if (kind === "INDEX_FUTURE" || kind === "COMMODITY_FUTURE") return "F";
  if (kind === "INDEX_OPTION") return "O";
  if (kind === "STOCK_FUTURE") return "JF";
  return "JO";
}
