import {
  BrokerRejectedError,
  BrokerTransportError,
  type AccountScope,
} from "@kstock/shared";
import {
  KIS_ENDPOINTS,
  KisRequestLimiter,
  KisRestClient,
} from "@kstock/broker-kis";
import {
  derivativeRequestsPerSecond,
  KIS_DERIVATIVE_PATHS,
  KIS_DERIVATIVE_TR_IDS,
} from "./constants.js";
import type {
  AmendDerivativeOrderRequest,
  CancelDerivativeOrderRequest,
  DerivativeAccountSnapshot,
  DerivativeExecution,
  DerivativeDailyBar,
  DerivativeInstrumentKind,
  DerivativeOrder,
  DerivativeOrderCapacity,
  DerivativeOrderSubmission,
  DerivativeQuote,
  DerivativeQuoteSubscription,
  DerivativeSession,
  KisDerivativeAdapterOptions,
  KisDerivativeEvent,
  IndexFutureContractQuote,
  PlaceDerivativeOrderRequest,
} from "./types.js";
import {
  asRecord,
  asRecords,
  instrumentMarketCode,
  numericValue,
  parseDerivativeAccount,
  parseOrder,
  parsePosition,
  pickNumber,
  pickString,
  requireDerivativeSymbol,
  requirePositiveInteger,
  sideFromDirectionEffect,
  stringValue,
  type JsonRecord,
  yyyymmdd,
} from "./utils.js";
import { KisDerivativeWebSocketClient } from "./websocket-client.js";

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_PAGES = 10;

function addDays(value: string, days: number): string {
  const date = new Date(Date.UTC(
    Number(value.slice(0, 4)),
    Number(value.slice(4, 6)) - 1,
    Number(value.slice(6, 8)) + days,
  ));
  return `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, "0")}${String(date.getUTCDate()).padStart(2, "0")}`;
}

function hasNextPage(value: string | undefined): boolean {
  return value === "M" || value === "F";
}

function orderCodes(request: {
  orderType: "LIMIT" | "MARKET" | "BEST";
  timeInForce?: "DAY" | "IOC" | "FOK";
  limitPrice?: number;
}): { nmprTypeCode: string; conditionCode: string; orderDivisionCode: string; unitPrice: string } {
  const tif = request.timeInForce ?? "DAY";
  if (request.orderType === "LIMIT") {
    if (request.limitPrice === undefined || !Number.isFinite(request.limitPrice) || request.limitPrice <= 0) {
      throw new BrokerRejectedError("A positive limit price is required", "KIS_DERIVATIVE_LIMIT_PRICE_REQUIRED");
    }
  } else if (request.limitPrice !== undefined && request.limitPrice !== 0) {
    throw new BrokerRejectedError("Market and best-price orders must not carry a limit price", "KIS_DERIVATIVE_PRICE_FORBIDDEN");
  }
  const base = request.orderType === "LIMIT" ? "01" : request.orderType === "MARKET" ? "02" : "04";
  const orderDivisionCode = tif === "DAY"
    ? base
    : request.orderType === "LIMIT"
      ? tif === "IOC" ? "10" : "11"
      : request.orderType === "MARKET"
        ? tif === "IOC" ? "12" : "13"
        : tif === "IOC" ? "14" : "15";
  return {
    nmprTypeCode: base,
    conditionCode: tif === "IOC" ? "3" : tif === "FOK" ? "4" : "0",
    orderDivisionCode,
    unitPrice: request.orderType === "LIMIT" ? String(request.limitPrice) : "0",
  };
}

function parseSubmission(
  body: JsonRecord,
  session: DerivativeSession,
  details: Pick<PlaceDerivativeOrderRequest, "direction" | "positionEffect"> | undefined,
): DerivativeOrderSubmission {
  const outputValue = body.output;
  const output = Array.isArray(outputValue) ? asRecord(outputValue[0]) : asRecord(outputValue);
  const brokerOrderId = pickString(output, "odno", "oder_no", "ord_no");
  if (brokerOrderId === "") {
    throw new BrokerTransportError(
      "KIS accepted a derivative mutation but omitted the broker order number; reconcile before retrying",
      "KIS_DERIVATIVE_ORDER_ID_MALFORMED",
      { responseKeys: Object.keys(output) },
    );
  }
  const result: DerivativeOrderSubmission = {
    brokerOrderId,
    acceptedAt: new Date().toISOString(),
    session,
    raw: output,
  };
  if (details !== undefined) {
    result.direction = details.direction;
    result.positionEffect = details.positionEffect;
    result.side = sideFromDirectionEffect(details.direction, details.positionEffect);
  }
  return result;
}

function summaryNumber(summary: JsonRecord, keys: string[]): number | undefined {
  return pickNumber(summary, ...keys);
}

export class KoreaInvestmentDerivativeAdapter {
  readonly scope: AccountScope;
  readonly environment: "live" | "paper";
  readonly accountProductCode = "03" as const;
  readonly #cano: string;
  readonly #rest: KisRestClient;
  readonly #webSocket: KisDerivativeWebSocketClient;
  readonly #listeners = new Set<(event: KisDerivativeEvent) => void>();
  readonly #orderTails = new Map<string, Promise<unknown>>();
  #connected = false;

  constructor(options: KisDerivativeAdapterOptions) {
    if (options.credentials.appKey.trim() === "" || options.credentials.appSecret.trim() === "") {
      throw new BrokerRejectedError("KIS appKey and appSecret are required", "KIS_DERIVATIVE_CREDENTIALS_MISSING");
    }
    const account = parseDerivativeAccount(
      options.credentials.accountId,
      options.credentials.accountProductCode,
    );
    this.environment = options.environment;
    this.#cano = account.cano;
    this.scope = {
      brokerId: "koreainvestment",
      environment: options.environment,
      accountId: account.scopedAccountId,
    };
    const officialLimit = derivativeRequestsPerSecond(options.environment);
    const limiter = options.requestLimiter ?? new KisRequestLimiter(
      officialLimit,
      Math.min(options.queryRequestsPerSecond ?? officialLimit, officialLimit),
      Math.min(options.orderRequestsPerSecond ?? officialLimit, officialLimit),
    );
    this.#rest = new KisRestClient({
      baseUrl: KIS_ENDPOINTS[options.environment].rest,
      credentials: options.credentials,
      scope: this.scope,
      tokenStore: options.tokenStore,
      fetchImplementation: options.fetchImplementation ?? globalThis.fetch,
      timeoutMs: options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS,
      limiter,
      useHashkey: options.useHashkey ?? false,
    });
    const htsId = options.htsId?.trim() || options.credentials.htsId?.trim() || undefined;
    this.#webSocket = new KisDerivativeWebSocketClient({
      environment: options.environment,
      htsId,
      unsubscribeTrType: options.websocketUnsubscribeTrType ?? "2",
      approvalKey: () => this.#rest.auth.approvalKey(),
      onEvent: (event) => {
        if (event.type === "connection") this.#connected = event.connected;
        this.#emit(event);
      },
    });
  }

  async connect(): Promise<void> {
    await this.#rest.auth.accessToken();
    await this.#webSocket.start();
    this.#connected = true;
  }

  async disconnect(): Promise<void> {
    this.#connected = false;
    await this.#webSocket.stop();
  }

  get connected(): boolean {
    return this.#connected;
  }

  onEvent(listener: (event: KisDerivativeEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async fetchAccountSnapshot(session: DerivativeSession): Promise<DerivativeAccountSnapshot> {
    this.#assertSupportedSession(session);
    const [balance, openOrders] = await Promise.all([
      this.#fetchBalance(session),
      this.fetchOpenOrders(session),
    ]);
    const positions = balance.rows.map(parsePosition).filter((position) => position.quantity > 0);
    const summary = balance.summary;
    const depositCash = summaryNumber(summary, ["dnca_cash", "tot_dncl_amt", "dnca_tot_amt", "cash_amt", "deposit_amt"]);
    const orderableCash = summaryNumber(summary, ["ord_psbl_cash", "ord_psbl_cash_amt", "fno_ord_psbl_amt"]);
    const initialMargin = summaryNumber(summary, ["mgna_tota", "init_mgna_amt", "tot_mgna_amt", "mgna_amt", "tot_mgna"]);
    const maintenanceMargin = summaryNumber(summary, ["mmga_tot_amt", "mntn_mgna_amt", "maint_mgna_amt", "maint_margin"]);
    const unavailableFields: DerivativeAccountSnapshot["unavailableFields"] = [];
    if (depositCash === undefined) unavailableFields.push("depositCash");
    if (orderableCash === undefined) unavailableFields.push("orderableCash");
    if (initialMargin === undefined) unavailableFields.push("initialMargin");
    if (maintenanceMargin === undefined) unavailableFields.push("maintenanceMargin");
    return {
      session,
      accountId: this.scope.accountId,
      accountProductCode: "03",
      currency: "KRW",
      ...(depositCash === undefined ? {} : { depositCash }),
      ...(orderableCash === undefined ? {} : { orderableCash }),
      ...(initialMargin === undefined ? {} : { initialMargin }),
      ...(maintenanceMargin === undefined ? {} : { maintenanceMargin }),
      positions,
      openOrders,
      observedAt: new Date().toISOString(),
      rawSummary: summary,
      unavailableFields,
    };
  }

  async fetchOpenOrders(session: DerivativeSession, date = yyyymmdd()): Promise<DerivativeOrder[]> {
    const rows = await this.#fetchOrderRows(session, date, "02");
    return rows.map((row) => parseOrder(row, session)).filter((order) => order.remainingQuantity > 0);
  }

  async fetchExecutions(
    session: DerivativeSession,
    fromDate = yyyymmdd(),
    toDate = yyyymmdd(),
  ): Promise<DerivativeExecution[]> {
    const rows = await this.#fetchOrderRows(session, fromDate, "01", toDate);
    const executions: DerivativeExecution[] = [];
    for (const row of rows) {
      const order = parseOrder(row, session);
      const quantity = pickNumber(row, "ccld_qty", "tot_ccld_qty", "cntg_qty") ?? 0;
      const price = pickNumber(row, "avg_idx", "avg_idx4", "ccld_unpr", "avg_prvs", "ccld_avg_unpr", "cntg_unpr") ?? 0;
      if (quantity <= 0 || price <= 0) continue;
      const time = pickString(row, "ccld_tmd", "stck_cntg_hour");
      const executionSequence = pickString(row, "ccld_no", "cntg_no") || `${time}:${quantity}:${price}`;
      const date = pickString(row, "ccld_dt", "ord_dt");
      const executedAt = /^\d{8}$/.test(date) && /^\d{6}$/.test(time)
        ? `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T${time.slice(0, 2)}:${time.slice(2, 4)}:${time.slice(4, 6)}+09:00`
        : undefined;
      executions.push({
        brokerOrderId: order.brokerOrderId,
        executionId: `${order.brokerOrderId}:${executionSequence}`,
        symbol: order.symbol,
        side: order.side,
        quantity,
        price,
        ...(executedAt === undefined ? {} : { executedAt }),
        session,
        raw: row,
      });
    }
    return executions;
  }

  async fetchQuote(
    symbol: string,
    instrumentKind: DerivativeInstrumentKind,
    session: DerivativeSession = "DAY",
  ): Promise<DerivativeQuote> {
    this.#assertSupportedSession(session);
    const normalized = requireDerivativeSymbol(symbol);
    const response = await this.#rest.request({
      path: KIS_DERIVATIVE_PATHS.currentPrice,
      method: "GET",
      trId: KIS_DERIVATIVE_TR_IDS.currentPrice,
      kind: "query",
      query: {
        FID_COND_MRKT_DIV_CODE: instrumentMarketCode(instrumentKind),
        FID_INPUT_ISCD: normalized,
      },
    });
    const output = asRecord(response.body.output1);
    const price = pickNumber(output, "futs_prpr", "optn_prpr");
    if (price === undefined || price <= 0) {
      throw new BrokerTransportError("KIS derivative price response omitted current price", "KIS_DERIVATIVE_QUOTE_MALFORMED", { symbol: normalized, keys: Object.keys(output) });
    }
    return {
      symbol: normalized,
      instrumentKind,
      session,
      price,
      receivedAt: new Date().toISOString(),
    };
  }

  /**
   * Lists Mini-KOSPI200 futures from KIS's official [0503] board. Mini futures
   * are used for automatic hedging because their KRW 50,000 multiplier gives a
   * materially smaller and safer rebalance step than the standard contract.
   */
  async fetchMiniKospi200Contracts(): Promise<IndexFutureContractQuote[]> {
    const response = await this.#rest.request({
      path: KIS_DERIVATIVE_PATHS.futuresBoard,
      method: "GET",
      trId: KIS_DERIVATIVE_TR_IDS.futuresBoard,
      kind: "query",
      query: {
        FID_COND_MRKT_DIV_CODE: "F",
        FID_COND_SCR_DIV_CODE: "20503",
        FID_COND_MRKT_CLS_CODE: "MKI",
      },
    });
    return asRecords(response.body.output)
      .map((row): IndexFutureContractQuote | null => {
        const symbol = pickString(row, "futs_shrn_iscd");
        const name = pickString(row, "hts_kor_isnm");
        if (symbol === "" || name === "") return null;
        const currentPrice = pickNumber(row, "futs_prpr");
        const bidPrice = pickNumber(row, "futs_bidp");
        const askPrice = pickNumber(row, "futs_askp");
        const cumulativeVolume = pickNumber(row, "acml_vol");
        const remainingDays = pickNumber(row, "hts_rmnn_dynu");
        return {
          symbol,
          name,
          ...(currentPrice === undefined ? {} : { currentPrice }),
          ...(bidPrice === undefined ? {} : { bidPrice }),
          ...(askPrice === undefined ? {} : { askPrice }),
          ...(cumulativeVolume === undefined ? {} : { cumulativeVolume }),
          ...(remainingDays === undefined ? {} : { remainingDays }),
          raw: row,
        };
      })
      .filter((row): row is IndexFutureContractQuote => row !== null)
      .sort((left, right) => (left.remainingDays ?? Number.MAX_SAFE_INTEGER) - (right.remainingDays ?? Number.MAX_SAFE_INTEGER));
  }

  async fetchDailyBars(
    symbol: string,
    fromDate: string,
    toDate: string,
  ): Promise<DerivativeDailyBar[]> {
    const normalized = requireDerivativeSymbol(symbol);
    if (!/^\d{8}$/.test(fromDate) || !/^\d{8}$/.test(toDate)) {
      throw new BrokerRejectedError("Daily-chart dates must use YYYYMMDD", "KIS_DERIVATIVE_DATE_INVALID");
    }
    const response = await this.#rest.request({
      path: KIS_DERIVATIVE_PATHS.dailyChart,
      method: "GET",
      trId: KIS_DERIVATIVE_TR_IDS.dailyChart,
      kind: "query",
      query: {
        FID_COND_MRKT_DIV_CODE: "F",
        FID_INPUT_ISCD: normalized,
        FID_INPUT_DATE_1: fromDate,
        FID_INPUT_DATE_2: toDate,
        FID_PERIOD_DIV_CODE: "D",
      },
    });
    return asRecords(response.body.output2)
      .map((row): DerivativeDailyBar | null => {
        const tradingDate = pickString(row, "stck_bsop_date", "futs_bsop_date", "bsop_date");
        const open = pickNumber(row, "futs_oprc", "optn_oprc", "stck_oprc");
        const high = pickNumber(row, "futs_hgpr", "optn_hgpr", "stck_hgpr");
        const low = pickNumber(row, "futs_lwpr", "optn_lwpr", "stck_lwpr");
        const close = pickNumber(row, "futs_prpr", "optn_prpr", "stck_clpr");
        const volume = pickNumber(row, "acml_vol") ?? 0;
        if (!/^\d{8}$/.test(tradingDate) || open === undefined || high === undefined || low === undefined || close === undefined) return null;
        return { tradingDate, open, high, low, close, volume, raw: row };
      })
      .filter((row): row is DerivativeDailyBar => row !== null)
      .sort((left, right) => left.tradingDate.localeCompare(right.tradingDate));
  }

  async fetchOrderCapacity(input: {
    symbol: string;
    session: DerivativeSession;
    side: "BUY" | "SELL";
    orderType: "LIMIT" | "MARKET";
    limitPrice?: number;
  }): Promise<DerivativeOrderCapacity> {
    const symbol = requireDerivativeSymbol(input.symbol);
    this.#assertSupportedSession(input.session);
    const night = input.session === "NIGHT";
    const response = await this.#rest.request({
      path: night
        ? KIS_DERIVATIVE_PATHS.nightOrderableQuantity
        : KIS_DERIVATIVE_PATHS.orderableQuantity,
      method: "GET",
      trId: night
        ? KIS_DERIVATIVE_TR_IDS.nightOrderableQuantity
        : KIS_DERIVATIVE_TR_IDS.orderableQuantity[this.environment],
      kind: "account",
      query: {
        CANO: this.#cano,
        ACNT_PRDT_CD: "03",
        PDNO: symbol,
        ...(night ? { PRDT_TYPE_CD: "301" } : {}),
        SLL_BUY_DVSN_CD: input.side === "BUY" ? "02" : "01",
        UNIT_PRICE: input.orderType === "LIMIT" ? String(input.limitPrice ?? 0) : "0",
        ORD_DVSN_CD: input.orderType === "LIMIT" ? "01" : "02",
      },
    });
    const output = asRecord(response.body.output);
    const orderableQuantity = pickNumber(output, "ord_psbl_qty", "ord_psbl_qty1", "max_ord_psbl_qty");
    const orderableAmount = pickNumber(output, "ord_psbl_amt", "ord_psbl_cash", "fno_ord_psbl_amt");
    const unavailableFields: DerivativeOrderCapacity["unavailableFields"] = [];
    if (orderableQuantity === undefined) unavailableFields.push("orderableQuantity");
    if (orderableAmount === undefined) unavailableFields.push("orderableAmount");
    return {
      symbol,
      side: input.side,
      ...(orderableQuantity === undefined ? {} : { orderableQuantity }),
      ...(orderableAmount === undefined ? {} : { orderableAmount }),
      raw: output,
      unavailableFields,
    };
  }

  replaceQuoteSubscriptions(subscriptions: DerivativeQuoteSubscription[]): Promise<void> {
    return this.#webSocket.replaceQuoteSubscriptions(subscriptions);
  }

  placeOrder(request: PlaceDerivativeOrderRequest): Promise<DerivativeOrderSubmission> {
    const symbol = requireDerivativeSymbol(request.symbol);
    return this.#serializeOrder(symbol, async () => {
      this.#assertSupportedSession(request.session);
      const quantity = requirePositiveInteger(request.quantity, "quantity");
      const side = sideFromDirectionEffect(request.direction, request.positionEffect);
      await this.#validatePositionEffect(symbol, request.session, request.direction, request.positionEffect, quantity);
      const codes = orderCodes(request);
      const response = await this.#rest.request({
        path: KIS_DERIVATIVE_PATHS.order,
        method: "POST",
        trId: this.#orderTrId(request.session),
        kind: "order",
        mutation: true,
        body: {
          ORD_PRCS_DVSN_CD: "02",
          CANO: this.#cano,
          ACNT_PRDT_CD: "03",
          SLL_BUY_DVSN_CD: side === "BUY" ? "02" : "01",
          SHTN_PDNO: symbol,
          ORD_QTY: String(quantity),
          UNIT_PRICE: codes.unitPrice,
          NMPR_TYPE_CD: codes.nmprTypeCode,
          KRX_NMPR_CNDT_CD: codes.conditionCode,
          ORD_DVSN_CD: codes.orderDivisionCode,
          CTAC_TLNO: request.contactPhone?.replaceAll(/[^0-9]/g, "") ?? "",
          FUOP_ITEM_DVSN_CD: "",
        },
      });
      return parseSubmission(response.body, request.session, request);
    });
  }

  amendOrder(request: AmendDerivativeOrderRequest): Promise<DerivativeOrderSubmission> {
    const brokerOrderId = request.brokerOrderId.trim();
    if (brokerOrderId === "") return Promise.reject(new BrokerRejectedError("brokerOrderId is required", "KIS_DERIVATIVE_ORDER_ID_REQUIRED"));
    return this.#serializeOrder(brokerOrderId, async () => {
      this.#assertSupportedSession(request.session);
      const codes = orderCodes(request);
      const quantity = request.amendAllRemaining === true ? 0 : requirePositiveInteger(request.quantity, "quantity");
      const response = await this.#rest.request({
        path: KIS_DERIVATIVE_PATHS.amendCancel,
        method: "POST",
        trId: this.#amendCancelTrId(request.session),
        kind: "order",
        mutation: true,
        body: {
          ORD_PRCS_DVSN_CD: "02",
          CANO: this.#cano,
          ACNT_PRDT_CD: "03",
          RVSE_CNCL_DVSN_CD: "01",
          ORGN_ODNO: brokerOrderId,
          ORD_QTY: String(quantity),
          UNIT_PRICE: codes.unitPrice,
          NMPR_TYPE_CD: codes.nmprTypeCode,
          KRX_NMPR_CNDT_CD: codes.conditionCode,
          RMN_QTY_YN: request.amendAllRemaining === true ? "Y" : "N",
          ORD_DVSN_CD: codes.orderDivisionCode,
          FUOP_ITEM_DVSN_CD: "",
        },
      });
      return parseSubmission(response.body, request.session, undefined);
    });
  }

  cancelOrder(request: CancelDerivativeOrderRequest): Promise<DerivativeOrderSubmission> {
    const brokerOrderId = request.brokerOrderId.trim();
    if (brokerOrderId === "") return Promise.reject(new BrokerRejectedError("brokerOrderId is required", "KIS_DERIVATIVE_ORDER_ID_REQUIRED"));
    return this.#serializeOrder(brokerOrderId, async () => {
      this.#assertSupportedSession(request.session);
      const allRemaining = request.cancelAllRemaining ?? request.quantity === undefined;
      const quantity = allRemaining ? 0 : requirePositiveInteger(request.quantity ?? 0, "quantity");
      const response = await this.#rest.request({
        path: KIS_DERIVATIVE_PATHS.amendCancel,
        method: "POST",
        trId: this.#amendCancelTrId(request.session),
        kind: "order",
        mutation: true,
        body: {
          ORD_PRCS_DVSN_CD: "02",
          CANO: this.#cano,
          ACNT_PRDT_CD: "03",
          RVSE_CNCL_DVSN_CD: "02",
          ORGN_ODNO: brokerOrderId,
          ORD_QTY: String(quantity),
          UNIT_PRICE: "0",
          NMPR_TYPE_CD: "02",
          KRX_NMPR_CNDT_CD: "0",
          RMN_QTY_YN: allRemaining ? "Y" : "N",
          ORD_DVSN_CD: "01",
          FUOP_ITEM_DVSN_CD: "",
        },
      });
      return parseSubmission(response.body, request.session, undefined);
    });
  }

  async #validatePositionEffect(
    symbol: string,
    session: DerivativeSession,
    direction: "LONG" | "SHORT",
    effect: "OPEN" | "CLOSE",
    quantity: number,
  ): Promise<void> {
    const [balance, openOrders] = await Promise.all([
      this.#fetchBalance(session),
      this.fetchOpenOrders(session),
    ]);
    const pendingOrder = openOrders.find((order) =>
      order.symbol === symbol && order.remainingQuantity > 0,
    );
    if (pendingOrder !== undefined) {
      throw new BrokerRejectedError(
        `Derivative order ${pendingOrder.brokerOrderId} still has ${pendingOrder.remainingQuantity} contracts open for ${symbol}; amend or cancel it before submitting another order`,
        "KIS_DERIVATIVE_PENDING_ORDER_EXISTS",
      );
    }
    const positions = balance.rows.map(parsePosition);
    const longQuantity = positions.filter((position) => position.symbol === symbol && position.direction === "LONG").reduce((sum, position) => sum + position.quantity, 0);
    const shortQuantity = positions.filter((position) => position.symbol === symbol && position.direction === "SHORT").reduce((sum, position) => sum + position.quantity, 0);
    if (effect === "CLOSE") {
      const matching = positions.filter((position) =>
        position.symbol === symbol && position.direction === direction && position.quantity > 0,
      );
      let available = 0;
      for (const position of matching) {
        const closeable = pickNumber(position.raw, "lqd_psbl_qty", "lqd_psbl_qty1", "lqd_psbl_qty_1");
        if (closeable === undefined || closeable < 0) {
          throw new BrokerTransportError(
            "KIS derivative balance omitted liquidation-available quantity; close order was not sent",
            "KIS_DERIVATIVE_CLOSEABLE_QUANTITY_MALFORMED",
            { symbol, keys: Object.keys(position.raw) },
          );
        }
        available += closeable;
      }
      if (available < quantity) {
        throw new BrokerRejectedError(
          `Close ${direction.toLowerCase()} requested ${quantity}, but only ${available} contracts are available to liquidate`,
          "KIS_DERIVATIVE_CLOSE_POSITION_INSUFFICIENT",
        );
      }
      return;
    }
    const opposite = direction === "LONG" ? shortQuantity : longQuantity;
    if (opposite > 0) {
      throw new BrokerRejectedError(
        `Opening ${direction.toLowerCase()} would first offset an existing opposite position; submit an explicit close order instead`,
        "KIS_DERIVATIVE_OPEN_WOULD_CLOSE",
      );
    }
  }

  async #fetchBalance(session: DerivativeSession): Promise<{ rows: JsonRecord[]; summary: JsonRecord }> {
    this.#assertSupportedSession(session);
    const rows: JsonRecord[] = [];
    let summary: JsonRecord = {};
    let fk = "";
    let nk = "";
    let continuation = "";
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const response = await this.#rest.request({
        path: session === "DAY" ? KIS_DERIVATIVE_PATHS.dayBalance : KIS_DERIVATIVE_PATHS.nightBalance,
        method: "GET",
        trId: this.#balanceTrId(session),
        kind: "account",
        trContinuation: continuation,
        query: {
          CANO: this.#cano,
          ACNT_PRDT_CD: "03",
          MGNA_DVSN: "01",
          EXCC_STAT_CD: "1",
          ...(session === "NIGHT" ? { ACNT_PWD: "" } : {}),
          CTX_AREA_FK200: fk,
          CTX_AREA_NK200: nk,
        },
      });
      rows.push(...asRecords(response.body.output1));
      const output2 = Array.isArray(response.body.output2)
        ? asRecord(response.body.output2[0])
        : asRecord(response.body.output2);
      if (Object.keys(output2).length > 0) summary = output2;
      if (!hasNextPage(response.trContinuation)) return { rows, summary };
      fk = stringValue(response.body.ctx_area_fk200);
      nk = stringValue(response.body.ctx_area_nk200);
      continuation = "N";
    }
    throw new BrokerTransportError("KIS derivative balance exceeded the pagination safety limit", "KIS_DERIVATIVE_PAGINATION_LIMIT");
  }

  async #fetchOrderRows(
    session: DerivativeSession,
    fromDate: string,
    completionCode: "01" | "02",
    toDate = fromDate,
  ): Promise<JsonRecord[]> {
    this.#assertSupportedSession(session);
    if (!/^\d{8}$/.test(fromDate) || !/^\d{8}$/.test(toDate)) {
      throw new BrokerRejectedError("Order-history dates must use YYYYMMDD", "KIS_DERIVATIVE_DATE_INVALID");
    }
    const rows: JsonRecord[] = [];
    let fk = "";
    let nk = "";
    let continuation = "";
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const response = await this.#rest.request({
        path: session === "DAY" ? KIS_DERIVATIVE_PATHS.dayOrders : KIS_DERIVATIVE_PATHS.nightOrders,
        method: "GET",
        trId: this.#ordersTrId(session),
        kind: "account",
        trContinuation: continuation,
        query: {
          CANO: this.#cano,
          ACNT_PRDT_CD: "03",
          STRT_ORD_DT: fromDate,
          END_ORD_DT: session === "NIGHT" ? addDays(toDate, 1) : toDate,
          SLL_BUY_DVSN_CD: "00",
          CCLD_NCCS_DVSN: completionCode,
          SORT_SQN: "DS",
          STRT_ODNO: "",
          PDNO: "",
          MKET_ID_CD: "",
          ...(session === "NIGHT" ? { FUOP_DVSN_CD: "", SCRN_DVSN: "02" } : {}),
          CTX_AREA_FK200: fk,
          CTX_AREA_NK200: nk,
        },
      });
      rows.push(...asRecords(response.body.output1));
      if (!hasNextPage(response.trContinuation)) return rows;
      fk = stringValue(response.body.ctx_area_fk200);
      nk = stringValue(response.body.ctx_area_nk200);
      continuation = "N";
    }
    throw new BrokerTransportError("KIS derivative order history exceeded the pagination safety limit", "KIS_DERIVATIVE_PAGINATION_LIMIT");
  }

  #assertSupportedSession(session: DerivativeSession): void {
    if (this.environment === "paper" && session === "NIGHT") {
      throw new BrokerRejectedError(
        "KIS official Open API examples do not provide paper-night derivative order or account TR IDs",
        "KIS_DERIVATIVE_PAPER_NIGHT_UNSUPPORTED",
      );
    }
  }

  #orderTrId(session: DerivativeSession): string {
    if (this.environment === "live") return session === "DAY" ? KIS_DERIVATIVE_TR_IDS.live.dayOrder : KIS_DERIVATIVE_TR_IDS.live.nightOrder;
    return KIS_DERIVATIVE_TR_IDS.paper.dayOrder;
  }

  #amendCancelTrId(session: DerivativeSession): string {
    if (this.environment === "live") return session === "DAY" ? KIS_DERIVATIVE_TR_IDS.live.dayAmendCancel : KIS_DERIVATIVE_TR_IDS.live.nightAmendCancel;
    return KIS_DERIVATIVE_TR_IDS.paper.dayAmendCancel;
  }

  #balanceTrId(session: DerivativeSession): string {
    if (this.environment === "live") return session === "DAY" ? KIS_DERIVATIVE_TR_IDS.live.dayBalance : KIS_DERIVATIVE_TR_IDS.live.nightBalance;
    return KIS_DERIVATIVE_TR_IDS.paper.dayBalance;
  }

  #ordersTrId(session: DerivativeSession): string {
    if (this.environment === "live") return session === "DAY" ? KIS_DERIVATIVE_TR_IDS.live.dayOrders : KIS_DERIVATIVE_TR_IDS.live.nightOrders;
    return KIS_DERIVATIVE_TR_IDS.paper.dayOrders;
  }

  #serializeOrder<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#orderTails.get(key) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(operation);
    const tail = run.then(() => undefined, () => undefined).finally(() => {
      if (this.#orderTails.get(key) === tail) this.#orderTails.delete(key);
    });
    this.#orderTails.set(key, tail);
    return run;
  }

  #emit(event: KisDerivativeEvent): void {
    for (const listener of this.#listeners) listener(event);
  }
}
