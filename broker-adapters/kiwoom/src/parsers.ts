import type {
  BrokerExecution,
  BrokerOrder,
  BrokerPosition,
  DailyBar,
  Exchange,
  Instrument,
  Quote,
} from "@kstock/shared";
import {
  createInstrumentSafetyMetadata,
  type InstrumentRestrictionCode,
} from "@kstock/shared";

import { KiwoomProtocolError } from "./errors.js";
import {
  assertSymbol,
  brokerDateTimeToIso,
  brokerNumber,
  brokerPrice,
  domainTradingDate,
  exchangeFromKiwoomQuoteSymbol,
  kstNowParts,
  normalizeSymbol,
  parseOrderSide,
  parseOrderStatus,
  parseOrderType,
  percentToBps,
  requiredBrokerNumber,
  requiredBrokerPrice,
  requiredString,
  stringAt,
  type UnknownRecord,
} from "./normalization.js";

export function parseInstrument(record: UnknownRecord): Instrument {
  const symbol = assertSymbol(requiredString(record, "code", "instrument code"));
  const listedRaw = stringAt(record, "regDay");
  const state = stringAt(record, "state") ?? "";
  const auditInfo = stringAt(record, "auditInfo") ?? "";
  const orderWarning = stringAt(record, "orderWarning") ?? "";
  const companyClassName = stringAt(record, "companyClassName") ?? "";
  const marketCode = stringAt(record, "marketCode") ?? "";
  const marketName = stringAt(record, "marketName") ?? "";
  const name = requiredString(record, "name", "instrument name");
  const restrictionCodes = kiwoomInstrumentRestrictions({
    state,
    auditInfo,
    orderWarning,
    companyClassName,
    marketCode,
    marketName,
    name,
  });
  return {
    symbol,
    name,
    market: "KOSPI",
    exchange: "KRX",
    active: !state.includes("상장폐지"),
    ...(listedRaw !== undefined && /^\d{8}$/.test(listedRaw)
      ? { listedDate: domainTradingDate(listedRaw) }
      : {}),
    raw: {
      state,
      auditInfo,
      orderWarning,
      companyClassName,
      marketCode,
      marketName,
      safety: createInstrumentSafetyMetadata("kiwoom-ka10099", restrictionCodes),
    },
  };
}

function isPositiveFlag(value: string): boolean {
  const normalized = value.trim().toUpperCase();
  return normalized !== "" && !["0", "00", "N", "NO", "FALSE", "해당없음", "정상"].includes(normalized);
}

function kiwoomInstrumentRestrictions(input: {
  state: string;
  auditInfo: string;
  orderWarning: string;
  companyClassName: string;
  marketCode: string;
  marketName: string;
  name: string;
}): InstrumentRestrictionCode[] {
  const restrictions: InstrumentRestrictionCode[] = [];
  const state = input.state.replaceAll("관리종목아님", "").replaceAll("관리종목 아님", "");
  if (/상장폐지/.test(state)) restrictions.push("DELISTING");
  if (/거래정지|매매정지|정지종목/.test(state)) restrictions.push("TRADING_SUSPENDED");
  if (/정리매매/.test(state)) restrictions.push("LIQUIDATION_TRADING");
  if (/관리종목/.test(state)) restrictions.push("MANAGED_ISSUE");
  if (/투자경고|투자위험/.test(state)) restrictions.push("MARKET_WARNING");
  if (/투자주의|투자유의/.test(state)) restrictions.push("INVESTMENT_CAUTION");
  if (/단기과열/.test(state)) restrictions.push("SHORT_TERM_OVERHEATED");
  if (isPositiveFlag(input.orderWarning)) restrictions.push("INVESTMENT_CAUTION");
  if (isPositiveFlag(input.auditInfo)) restrictions.push("AUDIT_ISSUE");
  const productText = `${input.name} ${input.companyClassName} ${input.marketName}`;
  // ka10099 identifies ordinary ETFs/ETNs through marketCode/marketName even
  // when companyClassName is empty and the product name has no "ETF" suffix.
  // Kiwoom currently documents/returns 8 for ETF and 60/70/90 for ETN
  // variants. Keep the textual checks as a defensive fallback.
  const exchangeProductMarketCodes = new Set(["8", "60", "70", "90"]);
  if (
    exchangeProductMarketCodes.has(input.marketCode.trim()) ||
    /ETF|ETN|ELW|인버스|레버리지/.test(productText.toUpperCase())
  ) {
    restrictions.push("HIGH_RISK_EXCHANGE_PRODUCT");
  }
  if (/스팩|SPAC|기업인수목적/.test(productText.toUpperCase())) restrictions.push("SPAC");
  return [...new Set(restrictions)];
}

export interface InstrumentParseIssue {
  index: number;
  code: string;
  message: string;
}

export interface InstrumentParseResult {
  instruments: Instrument[];
  issues: InstrumentParseIssue[];
}

/**
 * ka10099 is an exchange-wide response and can contain an independently
 * malformed row. Preserve every valid instrument instead of allowing one bad
 * row to abort the complete KOSPI refresh. The issue list deliberately omits
 * raw broker records so account-adjacent response data cannot leak to logs.
 */
export function parseInstrumentRecords(records: UnknownRecord[]): InstrumentParseResult {
  const instruments: Instrument[] = [];
  const issues: InstrumentParseIssue[] = [];
  records.forEach((record, index) => {
    try {
      instruments.push(parseInstrument(record));
    } catch (error) {
      issues.push({
        index,
        code:
          error instanceof KiwoomProtocolError
            ? error.code ?? "MALFORMED_INSTRUMENT"
            : "UNEXPECTED_INSTRUMENT_PARSE_ERROR",
        message:
          error instanceof Error
            ? error.message
            : "Kiwoom instrument record could not be normalized.",
      });
    }
  });
  return { instruments, issues };
}

export function parseDailyBar(record: UnknownRecord, symbol: string): DailyBar {
  return {
    symbol,
    tradingDate: domainTradingDate(requiredString(record, "dt", "daily-bar date")),
    open: requiredBrokerPrice(record, "open_pric", "daily-bar open"),
    high: requiredBrokerPrice(record, "high_pric", "daily-bar high"),
    low: requiredBrokerPrice(record, "low_pric", "daily-bar low"),
    close: requiredBrokerPrice(record, "cur_prc", "daily-bar close"),
    volume: Math.abs(requiredBrokerNumber(record, "trde_qty", "daily-bar volume")),
    adjusted: true,
  };
}

export function parseQuote(
  record: UnknownRecord,
  receivedAt = new Date(),
  fallbackExchange: Exchange = "KRX",
): Quote {
  const clock = kstNowParts(receivedAt);
  const rawSymbol = requiredString(record, "stk_cd", "quote symbol");
  const rawDate = stringAt(record, "dt");
  const rawExecutionTime = stringAt(record, "cntr_tm")?.replaceAll(":", "");
  const rawBidTime = stringAt(record, "bid_tm")?.replaceAll(":", "");
  const brokerTimestampVerified =
    rawDate !== undefined &&
    /^\d{8}$/.test(rawDate) &&
    isValidBrokerTime(rawExecutionTime);
  const date = rawDate !== undefined && /^\d{8}$/.test(rawDate) ? rawDate : clock.date;
  const time = isValidBrokerTime(rawExecutionTime)
    ? rawExecutionTime
    : isValidBrokerTime(rawBidTime)
      ? rawBidTime
      : clock.time;
  return {
    symbol: assertSymbol(rawSymbol),
    price: requiredBrokerPrice(record, "cur_prc", "quote price"),
    ...(brokerPrice(record.open_pric) === undefined
      ? {}
      : { open: brokerPrice(record.open_pric) }),
    ...(brokerPrice(record.high_pric) === undefined
      ? {}
      : { high: brokerPrice(record.high_pric) }),
    ...(brokerPrice(record.low_pric) === undefined
      ? {}
      : { low: brokerPrice(record.low_pric) }),
    cumulativeVolume: Math.abs(
      requiredBrokerNumber(record, "trde_qty", "quote cumulative volume"),
    ),
    tradingDate: domainTradingDate(date),
    tradingTime: /^\d{6}$/.test(time) ? time : clock.time,
    receivedAt: receivedAt.toISOString(),
    source: "kiwoom",
    exchange: exchangeFromKiwoomQuoteSymbol(rawSymbol, fallbackExchange),
    ...(brokerTimestampVerified ? { brokerTimestampVerified: true } : { stale: true }),
  };
}

function isValidBrokerTime(value: string | undefined): value is string {
  if (value === undefined || !/^\d{6}$/.test(value)) return false;
  const hours = Number(value.slice(0, 2));
  const minutes = Number(value.slice(2, 4));
  const seconds = Number(value.slice(4, 6));
  return hours <= 23 && minutes <= 59 && seconds <= 59;
}

export function parseOpenOrder(record: UnknownRecord, now = new Date()): BrokerOrder {
  const clock = kstNowParts(now);
  const orderedQuantity = Math.abs(
    requiredBrokerNumber(record, "ord_qty", "open-order quantity"),
  );
  const remainingQuantity = Math.abs(
    requiredBrokerNumber(record, "oso_qty", "open-order remaining quantity"),
  );
  const filledQuantity = Math.max(0, orderedQuantity - remainingQuantity);
  const description = stringAt(record, "io_tp_nm");
  const tradeType = stringAt(record, "trde_tp");
  const price = brokerPrice(record.ord_pric);
  return {
    brokerOrderId: requiredString(record, "ord_no", "open-order number"),
    ...(nonBlank(record, "orig_ord_no") === undefined
      ? {}
      : { originalBrokerOrderId: nonBlank(record, "orig_ord_no") }),
    symbol: assertSymbol(requiredString(record, "stk_cd", "open-order symbol")),
    side: parseOrderSide(description),
    orderType: isMarketTradeType(tradeType) ? "market" : parseOrderType(description),
    orderedQuantity,
    filledQuantity,
    remainingQuantity,
    ...(price === undefined || price === 0 ? {} : { limitPrice: price }),
    status: parseOrderStatus(
      stringAt(record, "ord_stt"),
      remainingQuantity,
      filledQuantity,
      description,
    ),
    orderedAt: brokerDateTimeToIso(clock.date, stringAt(record, "tm"), now),
  };
}

export function parsePosition(record: UnknownRecord): BrokerPosition {
  const quantity = Math.abs(requiredBrokerNumber(record, "rmnd_qty", "holding quantity"));
  const availableQuantity = Math.abs(
    requiredBrokerNumber(record, "trde_able_qty", "available holding quantity"),
  );
  const averagePrice = requiredBrokerPrice(record, "pur_pric", "holding average price");
  const currentPrice = requiredBrokerPrice(record, "cur_prc", "holding current price");
  const evaluation = brokerNumber(record.evlt_amt);
  const unrealized = brokerNumber(record.evltv_prft);
  return {
    symbol: assertSymbol(requiredString(record, "stk_cd", "holding symbol")),
    ...(nonBlank(record, "stk_nm") === undefined ? {} : { name: nonBlank(record, "stk_nm") }),
    quantity,
    availableQuantity,
    averagePrice,
    currentPrice,
    marketValue: evaluation ?? currentPrice * quantity,
    unrealizedPnl: unrealized ?? (currentPrice - averagePrice) * quantity,
    unrealizedPnlBps: percentToBps(record.prft_rt),
  };
}

export function parseCurrentExecution(
  record: UnknownRecord,
  executionDate: string,
): BrokerExecution {
  const brokerOrderId = requiredString(record, "ord_no", "execution order number");
  const symbol = assertSymbol(requiredString(record, "stk_cd", "execution symbol"));
  const quantity = Math.abs(requiredBrokerNumber(record, "cntr_qty", "execution quantity"));
  const price = requiredBrokerPrice(record, "cntr_pric", "execution price");
  const time = stringAt(record, "ord_tm");
  const documentedExecutionNumber = nonBlank(record, "cntr_no");
  // ka10076's current official schema does not document a fill number. The
  // composite below is a deterministic local identity made only from broker
  // fields. Reconcile it against the 00 stream/kt00009 before treating two
  // identical same-second partial fills as distinct.
  const executionId =
    documentedExecutionNumber === undefined
      ? `ka10076:${executionDate}:${brokerOrderId}:${time ?? ""}:${price}:${quantity}`
      : `${executionDate}:${documentedExecutionNumber}`;
  return {
    executionId,
    ...(documentedExecutionNumber === undefined ? { syntheticExecutionId: true } : {}),
    brokerOrderId,
    symbol,
    side: parseOrderSide(stringAt(record, "io_tp_nm")),
    quantity,
    price,
    executedAt: brokerDateTimeToIso(executionDate, time),
  };
}

export function parseHistoricalExecution(
  record: UnknownRecord,
  executionDate: string,
): BrokerExecution | undefined {
  const quantity = brokerNumber(record.cntr_qty);
  const price = brokerPrice(record.cntr_uv);
  if (quantity === undefined || quantity === 0 || price === undefined || price === 0) {
    return undefined;
  }
  return {
    executionId: `${executionDate}:${requiredString(record, "cntr_no", "historical execution number")}`,
    brokerOrderId: requiredString(record, "ord_no", "historical execution order number"),
    symbol: assertSymbol(requiredString(record, "stk_cd", "historical execution symbol")),
    side: parseOrderSide(
      nonBlank(record, "io_tp_nm") ?? tradeSideFromCode(stringAt(record, "trde_tp")),
    ),
    quantity: Math.abs(quantity),
    price,
    executedAt: brokerDateTimeToIso(executionDate, stringAt(record, "cntr_tm")),
  };
}

/**
 * kt00009 returns one row per order event/fill, so reconstruct an order-level
 * view without inventing terminal state. In particular, a cancellation request
 * is terminal only after the broker reports a confirmed quantity or an
 * explicit confirmation state.
 */
export function parseHistoricalOrders(
  records: UnknownRecord[],
  orderDate: string,
): BrokerOrder[] {
  const grouped = new Map<string, UnknownRecord[]>();
  for (const record of records) {
    const brokerOrderId = nonBlank(record, "ord_no");
    if (brokerOrderId === undefined) continue;
    const group = grouped.get(brokerOrderId) ?? [];
    group.push(record);
    grouped.set(brokerOrderId, group);
  }

  const result: BrokerOrder[] = [];
  for (const [brokerOrderId, rows] of grouped) {
    const orderedQuantity = Math.max(
      0,
      ...rows.map((row) => Math.abs(brokerNumber(row.ord_qty) ?? 0)),
    );
    const rawSymbol = firstString(rows, "stk_cd");
    if (orderedQuantity <= 0 || rawSymbol === undefined) continue;

    const seenExecutions = new Set<string>();
    let filledQuantity = 0;
    for (const row of rows) {
      const quantity = Math.abs(brokerNumber(row.cntr_qty) ?? 0);
      if (quantity <= 0) continue;
      const identity =
        nonBlank(row, "cntr_no") ??
        `${stringAt(row, "cntr_tm") ?? ""}:${brokerPrice(row.cntr_uv) ?? 0}:${quantity}`;
      if (seenExecutions.has(identity)) continue;
      seenExecutions.add(identity);
      filledQuantity += quantity;
    }
    filledQuantity = Math.min(orderedQuantity, filledQuantity);

    const description = firstString(rows, "io_tp_nm");
    const tradeCode = firstString(rows, "trde_tp");
    const statusText = rows
      .flatMap((row) => [
        stringAt(row, "acpt_tp") ?? "",
        stringAt(row, "mdfy_cncl_tp") ?? "",
        stringAt(row, "io_tp_nm") ?? "",
      ])
      .join(" ");
    const confirmedQuantity = Math.max(
      0,
      ...rows.map((row) => Math.abs(brokerNumber(row.cnfm_qty) ?? 0)),
    );
    const explicitlyConfirmed = statusText.includes("확인") || statusText.includes("완료");
    const rejected = statusText.includes("거부") || statusText.includes("반려");
    const cancellation = statusText.includes("취소");
    const amendment = statusText.includes("정정");
    const terminalCancellation = cancellation &&
      (confirmedQuantity > 0 || explicitlyConfirmed);
    const terminalAmendment = amendment &&
      (confirmedQuantity > 0 || explicitlyConfirmed);
    const status: BrokerOrder["status"] =
      filledQuantity >= orderedQuantity
        ? "FILLED"
        : rejected
          ? "REJECTED"
          : terminalCancellation
            ? "CANCELED"
            : terminalAmendment
              ? "AMENDED"
              : filledQuantity > 0
                ? "PARTIALLY_FILLED"
                : statusText.includes("접수") || explicitlyConfirmed
                  ? "ACKED"
                  : "UNKNOWN";
    const terminal = status === "FILLED" || status === "CANCELED" || status === "REJECTED";
    const price = rows
      .map((row) => brokerPrice(row.ord_uv))
      .find((candidate): candidate is number => candidate !== undefined && candidate > 0);
    const originalBrokerOrderId = rows
      .map((row) => nonBlank(row, "orig_ord_no"))
      .find((candidate): candidate is string => candidate !== undefined);
    const orderType = isMarketTradeType(tradeCode) || description?.includes("시장가") === true
      ? "market"
      : "limit";
    const order: BrokerOrder = {
      brokerOrderId,
      ...(originalBrokerOrderId === undefined ? {} : { originalBrokerOrderId }),
      symbol: assertSymbol(rawSymbol),
      side: parseOrderSide(description ?? tradeSideFromCode(tradeCode)),
      orderType,
      orderedQuantity,
      filledQuantity,
      remainingQuantity: terminal ? 0 : Math.max(0, orderedQuantity - filledQuantity),
      ...(orderType === "limit" && price !== undefined ? { limitPrice: price } : {}),
      status,
      orderedAt: brokerDateTimeToIso(orderDate, firstString(rows, "cntr_tm")),
      raw: rows,
    };
    result.push(order);
  }

  return result.sort((left, right) => left.orderedAt.localeCompare(right.orderedAt));
}

function firstString(records: UnknownRecord[], key: string): string | undefined {
  for (const record of records) {
    const value = stringAt(record, key);
    if (value !== undefined && value !== "") return value;
  }
  return undefined;
}

function nonBlank(record: UnknownRecord, key: string): string | undefined {
  const value = stringAt(record, key);
  return value === undefined || value === "" || /^0+$/.test(value) ? undefined : value;
}

function isMarketTradeType(value: string | undefined): boolean {
  return value === "3" || value === "13" || value === "23";
}

function tradeSideFromCode(value: string | undefined): string | undefined {
  if (value === "1") return "매도";
  if (value === "2") return "매수";
  return undefined;
}

export function ensureUniqueBy<T>(values: T[], keyOf: (value: T) => string): T[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = keyOf(value);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function rejectUnsupportedExecutionRange(days: number): void {
  if (days > 31) {
    throw new KiwoomProtocolError(
      "Kiwoom historical execution reconciliation is limited to 31 calendar days per call.",
      "EXECUTION_RANGE_TOO_LARGE",
    );
  }
}
