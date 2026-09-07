import {
  BrokerIndeterminateError,
  BrokerRejectedError,
  type AccountSnapshot,
  type AmendOrderRequest,
  type BrokerAdapter,
  type BrokerCapabilities,
  type BrokerEvent,
  type BrokerExecution,
  type BrokerHealth,
  type BrokerOrder,
  type BrokerPosition,
  type CancelOrderRequest,
  type DailyBar,
  type Exchange,
  type Instrument,
  type MarketCalendarDay,
  type OrderSubmissionResult,
  type PlaceOrderRequest,
  type Quote,
} from "@kstock/shared";
import {
  DEFAULT_KIS_WS_UNSUBSCRIBE_TR_TYPE,
  KIS_ENDPOINTS,
  KIS_KOSPI_MASTER_URL,
  KIS_MULTI_QUOTE_BATCH_SIZE,
  KIS_PATHS,
  KIS_QUOTE_MARKET_CODE,
  KIS_TR_IDS,
  defaultRequestsPerSecond,
} from "./constants.js";
import { fetchKospiMaster } from "./master.js";
import { KisRequestLimiter } from "./rate-limiter.js";
import { KisRestClient, type KisRestRequest } from "./rest-client.js";
import type {
  JsonRecord,
  KisAdapterDiagnostics,
  KisAmendableOrder,
  KisBrokerAdapterOptions,
} from "./types.js";
import {
  asRecord,
  asRecords,
  currentKisDateTime,
  dateDaysAgo,
  decodeBrokerOrderId,
  domainTradingDate,
  encodeBrokerOrderId,
  isYyyymmdd,
  isoFromKis,
  numberValue,
  orderTypeFromKis,
  parseAccountId,
  requirePositiveInteger,
  requireSymbol,
  sideFromKis,
  stringValue,
  yyyymmdd,
} from "./utils.js";
import { KisWebSocketClient } from "./websocket-client.js";

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const MAX_PAGES = 100;

function records(value: unknown): JsonRecord[] {
  if (Array.isArray(value)) return asRecords(value);
  const record = asRecord(value);
  return Object.keys(record).length === 0 ? [] : [record];
}

function outputRecord(body: JsonRecord): JsonRecord {
  return asRecord(body.output);
}

function pickString(record: JsonRecord, ...keys: string[]): string {
  for (const key of keys) {
    const value = stringValue(record[key]);
    if (value !== "") return value;
  }
  return "";
}

function hasNextPage(continuation: string | undefined): boolean {
  return continuation === "M" || continuation === "F";
}

function ymdAddDays(value: string, days: number): string {
  const timestamp = Date.UTC(
    Number(value.slice(0, 4)),
    Number(value.slice(4, 6)) - 1,
    Number(value.slice(6, 8)) + days,
  );
  const date = new Date(timestamp);
  return `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, "0")}${String(date.getUTCDate()).padStart(2, "0")}`;
}

function safeOrderRaw(row: JsonRecord): JsonRecord {
  return {
    orderNumber: pickString(row, "odno", "ODNO"),
    originalOrderNumber: pickString(row, "orgn_odno", "ORGN_ODNO"),
    symbol: pickString(row, "pdno", "PDNO"),
    orderDivisionCode: pickString(row, "ord_dvsn_cd", "ORD_DVSN_CD"),
    sideCode: pickString(row, "sll_buy_dvsn_cd", "SLL_BUY_DVSN_CD"),
    exchangeCode: pickString(row, "excg_id_dvsn_cd", "EXCG_ID_DVSN_CD"),
    canceled: pickString(row, "cncl_yn", "CNCL_YN"),
    rejectedQuantity: numberValue(row.rjct_qty ?? row.RJCT_QTY),
  };
}

export class KoreaInvestmentBrokerAdapter implements BrokerAdapter {
  readonly scope;
  readonly capabilities: BrokerCapabilities;
  readonly #environment: "live" | "paper";
  readonly #cano: string;
  readonly #productCode: string;
  readonly #quoteExchange: Exchange;
  readonly #fetch: typeof fetch;
  readonly #requestTimeoutMs: number;
  readonly #masterUrl: string;
  readonly #useHashkey: boolean;
  readonly #accountNoticeConfigured: boolean;
  readonly #rest: KisRestClient;
  readonly #webSocket: KisWebSocketClient;
  readonly #listeners = new Set<(event: BrokerEvent) => void>();
  #health: BrokerHealth;

  constructor(options: KisBrokerAdapterOptions) {
    if (options.credentials.appKey.trim() === "" || options.credentials.appSecret.trim() === "") {
      throw new BrokerRejectedError(
        "KIS appKey and appSecret are required",
        "KIS_CREDENTIALS_MISSING",
      );
    }
    const account = parseAccountId(
      options.credentials.accountId,
      options.credentials.accountProductCode,
    );
    this.#environment = options.environment;
    this.#quoteExchange = options.quoteExchange ?? "KRX";
    if (this.#environment === "paper" && this.#quoteExchange !== "KRX") {
      throw new BrokerRejectedError(
        "KIS paper trading supports KRX market data only",
        "PAPER_KRX_ONLY",
      );
    }
    this.#cano = account.cano;
    this.#productCode = account.productCode;
    this.#fetch = options.fetchImplementation ?? globalThis.fetch;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.#masterUrl = options.masterUrl ?? KIS_KOSPI_MASTER_URL;
    this.#useHashkey = options.useHashkey ?? false;
    const htsId = options.htsId?.trim() || undefined;
    this.#accountNoticeConfigured = htsId !== undefined;

    this.scope = {
      brokerId: "koreainvestment" as const,
      environment: options.environment,
      accountId: options.credentials.accountId,
    };
    const officialLimit = defaultRequestsPerSecond(options.environment);
    const queryLimit = Math.min(
      options.queryRequestsPerSecond ?? officialLimit,
      officialLimit,
    );
    const orderLimit = Math.min(
      options.orderRequestsPerSecond ?? officialLimit,
      officialLimit,
    );
    const limiter = options.requestLimiter
      ?? new KisRequestLimiter(officialLimit, queryLimit, orderLimit);
    this.#rest = new KisRestClient({
      baseUrl: KIS_ENDPOINTS[options.environment].rest,
      credentials: options.credentials,
      scope: this.scope,
      tokenStore: options.tokenStore,
      fetchImplementation: this.#fetch,
      timeoutMs: this.#requestTimeoutMs,
      limiter,
      useHashkey: this.#useHashkey,
    });
    const unsubscribeTrType =
      options.webSocketUnsubscribeTrType ?? DEFAULT_KIS_WS_UNSUBSCRIBE_TR_TYPE;
    this.#webSocket = new KisWebSocketClient({
      url: KIS_ENDPOINTS[options.environment].webSocket,
      environment: options.environment,
      quoteExchange: this.#quoteExchange,
      cano: this.#cano,
      htsId,
      unsubscribeTrType,
      approvalKey: () => this.#rest.auth.approvalKey(),
      onQuote: (quote) => {
        this.#setHealth({ lastQuoteAt: quote.receivedAt });
        this.#emit({ type: "quote", quote });
      },
      onOrder: (order) => {
        const at = new Date().toISOString();
        this.#setHealth({ lastAccountEventAt: at });
        this.#emit({ type: "order", order });
      },
      onExecution: (execution) => {
        const at = new Date().toISOString();
        this.#setHealth({ lastAccountEventAt: at });
        this.#emit({ type: "execution", execution });
      },
      onConnection: (connected, accountConnected) => {
        this.#setHealth({
          marketWebSocketConnected: connected,
          accountWebSocketConnected: accountConnected,
          state: connected
            ? htsId === undefined || accountConnected
              ? htsId === undefined
                ? "DEGRADED"
                : "CONNECTED"
              : "DEGRADED"
            : this.#health.restConnected
              ? "DEGRADED"
              : "DISCONNECTED",
        });
      },
      onError: (message, code) => this.#reportError(message, code),
    });
    this.capabilities = {
      supportsLive: true,
      supportsPaper: true,
      supportsAmend: true,
      supportsCancel: true,
      maxQuoteSubscriptions: this.#webSocket.quoteLimit,
      quoteBatchSize: KIS_MULTI_QUOTE_BATCH_SIZE,
      queryRequestsPerSecond: queryLimit,
      orderRequestsPerSecond: orderLimit,
      clientOrderIdSupported: false,
    };
    this.#health = {
      state: "DISCONNECTED",
      restConnected: false,
      marketWebSocketConnected: false,
      accountWebSocketConnected: false,
      checkedAt: new Date().toISOString(),
    };
  }

  async connect(): Promise<void> {
    this.#setHealth({ state: "AUTHENTICATING" });
    try {
      await this.#rest.auth.accessToken();
      this.#setHealth({ state: "SYNCING", restConnected: true });
      await this.#webSocket.start();
    } catch (error) {
      const message = error instanceof Error ? error.message : "KIS connection failed";
      this.#setHealth({ state: "ERROR", restConnected: false, lastError: message });
      this.#emit({
        type: "error",
        error: {
          message,
          at: new Date().toISOString(),
        },
      });
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    await this.#webSocket.stop();
    this.#setHealth({
      state: "DISCONNECTED",
      restConnected: false,
      marketWebSocketConnected: false,
      accountWebSocketConnected: false,
    });
  }

  getHealth(): BrokerHealth {
    return { ...this.#health, checkedAt: new Date().toISOString() };
  }

  onEvent(listener: (event: BrokerEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  getDiagnostics(): KisAdapterDiagnostics {
    return {
      environment: this.#environment,
      quoteExchange: this.#quoteExchange,
      restBaseUrl: KIS_ENDPOINTS[this.#environment].rest,
      webSocketUrl: KIS_ENDPOINTS[this.#environment].webSocket,
      quoteSubscriptionCount: this.#webSocket.quoteSubscriptionCount,
      quoteSubscriptionLimit: this.#webSocket.quoteLimit,
      accountNoticeConfigured: this.#accountNoticeConfigured,
      useHashkey: this.#useHashkey,
      websocketUnsubscribeTrType:
        DEFAULT_KIS_WS_UNSUBSCRIBE_TR_TYPE,
    };
  }

  fetchInstruments(): Promise<Instrument[]> {
    return fetchKospiMaster(this.#fetch, this.#masterUrl, this.#requestTimeoutMs * 2);
  }

  async fetchMarketCalendar(fromDate: string, requestedDays: number): Promise<MarketCalendarDay[]> {
    if (!isYyyymmdd(fromDate) || !Number.isSafeInteger(requestedDays) || requestedDays <= 0) {
      throw new BrokerRejectedError("Invalid market-calendar range", "INVALID_CALENDAR_RANGE");
    }
    const days: MarketCalendarDay[] = [];
    let fk = "";
    let nk = "";
    const seen = new Set<string>();
    for (let page = 0; page < MAX_PAGES && days.length < requestedDays; page += 1) {
      const result = await this.#rest.request({
        path: KIS_PATHS.holiday,
        method: "GET",
        trId: KIS_TR_IDS.holiday,
        kind: "query",
        trContinuation: page === 0 ? "" : "N",
        query: { BASS_DT: fromDate, CTX_AREA_FK: fk, CTX_AREA_NK: nk },
      });
      for (const row of records(result.body.output)) {
        const date = pickString(row, "bass_dt", "BASS_DT");
        if (!isYyyymmdd(date)) continue;
        days.push({
          tradingDate: `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`,
          isOpen: pickString(row, "opnd_yn", "OPND_YN") === "Y",
        });
        if (days.length >= requestedDays) break;
      }
      if (!hasNextPage(result.trContinuation)) break;
      fk = stringValue(result.body.ctx_area_fk);
      nk = stringValue(result.body.ctx_area_nk);
      const cursor = `${fk}|${nk}`;
      if (seen.has(cursor) || cursor === "|") {
        throw new Error("KIS market-calendar pagination cursor did not advance");
      }
      seen.add(cursor);
    }
    if (days.length === 0) throw new Error("KIS market-calendar response was empty");
    return days;
  }

  async fetchDailyBars(symbolValue: string, requiredCount: number): Promise<DailyBar[]> {
    const symbol = requireSymbol(symbolValue);
    requirePositiveInteger(requiredCount, "requiredCount");
    const today = yyyymmdd(new Date());
    const byDate = new Map<string, DailyBar>();
    let end = today;
    const maximumPages = Math.ceil(requiredCount / 100) + 2;
    for (let page = 0; page < maximumPages && byDate.size < requiredCount; page += 1) {
      const start = ymdAddDays(
        end,
        -Math.max(180, (requiredCount - byDate.size) * 3),
      );
      const result = await this.#rest.request({
        path: KIS_PATHS.dailyBars,
        method: "GET",
        trId: KIS_TR_IDS.dailyBars,
        kind: "query",
        query: {
          FID_COND_MRKT_DIV_CODE: "J",
          FID_INPUT_ISCD: symbol,
          FID_INPUT_DATE_1: start,
          FID_INPUT_DATE_2: end,
          FID_PERIOD_DIV_CODE: "D",
          FID_ORG_ADJ_PRC: "0",
        },
      });
      const pageBars = records(result.body.output2)
        .map((row): DailyBar | undefined => {
          const tradingDate = stringValue(row.stck_bsop_date);
          const close = numberValue(row.stck_clpr);
          if (!/^\d{8}$/.test(tradingDate) || close <= 0) return undefined;
          return {
            symbol,
            tradingDate: domainTradingDate(tradingDate),
            open: numberValue(row.stck_oprc),
            high: numberValue(row.stck_hgpr),
            low: numberValue(row.stck_lwpr),
            close,
            volume: numberValue(row.acml_vol),
            adjusted: true,
          };
        })
        .filter((bar): bar is DailyBar => bar !== undefined);
      if (pageBars.length === 0) break;
      for (const bar of pageBars) byDate.set(bar.tradingDate, bar);
      const earliest = pageBars
        .map((bar) => bar.tradingDate.replaceAll("-", ""))
        .sort()[0];
      if (!earliest || earliest > end) break;
      const previousEnd = ymdAddDays(earliest, -1);
      if (previousEnd >= end) break;
      end = previousEnd;
    }
    return [...byDate.values()]
      .sort((left, right) => left.tradingDate.localeCompare(right.tradingDate))
      .slice(-requiredCount);
  }

  async fetchQuote(symbolValue: string): Promise<Quote> {
    const symbol = requireSymbol(symbolValue);
    const result = await this.#rest.request({
      path: KIS_PATHS.currentPrice,
      method: "GET",
      trId: KIS_TR_IDS.quote,
      kind: "query",
      query: {
        FID_COND_MRKT_DIV_CODE: KIS_QUOTE_MARKET_CODE[this.#quoteExchange],
        FID_INPUT_ISCD: symbol,
      },
    });
    return this.#quoteFromCurrentPrice(symbol, outputRecord(result.body));
  }

  async fetchQuotes(symbolValues: string[]): Promise<Quote[]> {
    const symbols = [...new Set(symbolValues.map(requireSymbol))];
    const bySymbol = new Map<string, Quote>();
    for (let offset = 0; offset < symbols.length; offset += KIS_MULTI_QUOTE_BATCH_SIZE) {
      const chunk = symbols.slice(offset, offset + KIS_MULTI_QUOTE_BATCH_SIZE);
      const query: Record<string, string> = {};
      chunk.forEach((symbol, index) => {
        const suffix = index + 1;
        query[`FID_COND_MRKT_DIV_CODE_${suffix}`] =
          KIS_QUOTE_MARKET_CODE[this.#quoteExchange];
        query[`FID_INPUT_ISCD_${suffix}`] = symbol;
      });
      const result = await this.#rest.request({
        path: KIS_PATHS.multiPrice,
        method: "GET",
        trId: KIS_TR_IDS.multiPrice,
        kind: "query",
        query,
      });
      for (const row of records(result.body.output)) {
        const symbol = pickString(row, "inter_shrn_iscd", "stck_shrn_iscd").toUpperCase();
        if (!chunk.includes(symbol)) continue;
        const price = numberValue(row.inter2_prpr ?? row.stck_prpr);
        if (price <= 0) continue;
        const now = currentKisDateTime();
        const quote: Quote = {
          symbol,
          price,
          cumulativeVolume: numberValue(row.acml_vol),
          tradingDate: domainTradingDate(now.date),
          tradingTime: now.time,
          receivedAt: new Date().toISOString(),
          source: "koreainvestment",
          exchange: this.#quoteExchange,
        };
        const open = numberValue(row.inter2_oprc);
        const high = numberValue(row.inter2_hgpr);
        const low = numberValue(row.inter2_lwpr);
        if (open > 0) quote.open = open;
        if (high > 0) quote.high = high;
        if (low > 0) quote.low = low;
        bySymbol.set(symbol, quote);
      }
    }
    return symbols.flatMap((symbol) => {
      const quote = bySymbol.get(symbol);
      return quote === undefined ? [] : [quote];
    });
  }

  replaceQuoteSubscriptions(symbols: string[]): Promise<void> {
    return this.#webSocket.replaceQuoteSubscriptions(symbols);
  }

  async placeOrder(request: PlaceOrderRequest): Promise<OrderSubmissionResult> {
    const symbol = requireSymbol(request.symbol);
    validateKisExchange(request.exchange, this.#environment);
    requirePositiveInteger(request.quantity, "quantity");
    if (request.orderType === "limit") {
      requirePositiveInteger(request.limitPrice ?? 0, "limitPrice");
    }
    const body: JsonRecord = {
      CANO: this.#cano,
      ACNT_PRDT_CD: this.#productCode,
      PDNO: symbol,
      ORD_DVSN: request.orderType === "market" ? "01" : "00",
      ORD_QTY: String(request.quantity),
      ORD_UNPR: request.orderType === "market" ? "0" : String(request.limitPrice),
      EXCG_ID_DVSN_CD: request.exchange,
      SLL_TYPE: request.side === "sell" ? "01" : "",
      CNDT_PRIC: "",
    };
    return this.#submitOrder({
      path: KIS_PATHS.cashOrder,
      method: "POST",
      trId:
        request.side === "buy"
          ? KIS_TR_IDS[this.#environment].cashBuy
          : KIS_TR_IDS[this.#environment].cashSell,
      kind: "order",
      body,
      mutation: true,
      hashkey: this.#useHashkey,
    });
  }

  async amendOrder(request: AmendOrderRequest): Promise<OrderSubmissionResult> {
    requireSymbol(request.symbol);
    validateKisExchange(request.exchange, this.#environment);
    requirePositiveInteger(request.remainingQuantity, "remainingQuantity");
    requirePositiveInteger(request.newLimitPrice, "newLimitPrice");
    const amendable = await this.#requireAmendable(
      request.brokerOrderId,
      request.remainingQuantity,
    );
    const body: JsonRecord = {
      CANO: this.#cano,
      ACNT_PRDT_CD: this.#productCode,
      KRX_FWDG_ORD_ORGNO: amendable.branchOrderNumber,
      ORGN_ODNO: decodeBrokerOrderId(amendable.brokerOrderId).orderNumber,
      ORD_DVSN: "00",
      RVSE_CNCL_DVSN_CD: "01",
      ORD_QTY: String(request.remainingQuantity),
      ORD_UNPR: String(request.newLimitPrice),
      QTY_ALL_ORD_YN: "N",
      EXCG_ID_DVSN_CD: request.exchange,
    };
    return this.#submitOrder(
      {
        path: KIS_PATHS.amendCancel,
        method: "POST",
        trId: KIS_TR_IDS[this.#environment].amendCancel,
        kind: "order",
        body,
        mutation: true,
        hashkey: this.#useHashkey,
      },
      request.brokerOrderId,
    );
  }

  async cancelOrder(request: CancelOrderRequest): Promise<OrderSubmissionResult> {
    requireSymbol(request.symbol);
    validateKisExchange(request.exchange, this.#environment);
    requirePositiveInteger(request.remainingQuantity, "remainingQuantity");
    const amendable = await this.#requireAmendable(
      request.brokerOrderId,
      request.remainingQuantity,
    );
    const body: JsonRecord = {
      CANO: this.#cano,
      ACNT_PRDT_CD: this.#productCode,
      KRX_FWDG_ORD_ORGNO: amendable.branchOrderNumber,
      ORGN_ODNO: decodeBrokerOrderId(amendable.brokerOrderId).orderNumber,
      ORD_DVSN: "00",
      RVSE_CNCL_DVSN_CD: "02",
      ORD_QTY: String(request.remainingQuantity),
      ORD_UNPR: "0",
      QTY_ALL_ORD_YN: "N",
      EXCG_ID_DVSN_CD: request.exchange,
    };
    return this.#submitOrder(
      {
        path: KIS_PATHS.amendCancel,
        method: "POST",
        trId: KIS_TR_IDS[this.#environment].amendCancel,
        kind: "order",
        body,
        mutation: true,
        hashkey: this.#useHashkey,
      },
      request.brokerOrderId,
    );
  }

  async fetchAccountSnapshot(): Promise<AccountSnapshot> {
    const [balance, openOrders, realizedPnlToday, availableCash] = await Promise.all([
      this.#fetchBalanceRows(),
      this.fetchOpenOrders(),
      this.#fetchRealizedPnlToday(),
      this.#fetchAvailableCash(),
    ]);
    const summary = balance.summaries.at(-1) ?? {};
    const positions = balance.positions
      .map((row): BrokerPosition | undefined => {
        const symbol = pickString(row, "pdno", "PDNO").toUpperCase();
        const quantity = numberValue(row.hldg_qty ?? row.HLDG_QTY);
        if (!/^[0-9A-Z]{6}$/.test(symbol) || quantity <= 0) return undefined;
        const position: BrokerPosition = {
          symbol,
          quantity,
          availableQuantity: numberValue(row.ord_psbl_qty ?? row.ORD_PSBL_QTY),
          averagePrice: numberValue(row.pchs_avg_pric ?? row.PCHS_AVG_PRIC),
          currentPrice: numberValue(row.prpr ?? row.PRPR),
          marketValue: numberValue(row.evlu_amt ?? row.EVLU_AMT),
          unrealizedPnl: numberValue(row.evlu_pfls_amt ?? row.EVLU_PFLS_AMT),
          unrealizedPnlBps:
            numberValue(row.evlu_pfls_rt ?? row.EVLU_PFLS_RT) * 100,
        };
        const name = pickString(row, "prdt_name", "PRDT_NAME");
        if (name !== "") position.name = name;
        return position;
      })
      .filter((position): position is BrokerPosition => position !== undefined);
    const cash = numberValue(summary.dnca_tot_amt ?? summary.DNCA_TOT_AMT);
    return {
      scope: this.scope,
      cash,
      // The engine is cash-only. Some accounts may report buying power above
      // deposits because of margin eligibility, so never expose more than the
      // actual cash balance to automated risk sizing.
      availableCash: Math.max(0, Math.min(cash, availableCash)),
      totalEvaluation: numberValue(summary.tot_evlu_amt ?? summary.TOT_EVLU_AMT),
      realizedPnlToday,
      unrealizedPnl: numberValue(
        summary.evlu_pfls_smtl_amt ?? summary.EVLU_PFLS_SMTL_AMT,
      ),
      positions,
      openOrders,
      fetchedAt: new Date().toISOString(),
    };
  }

  async fetchOpenOrders(): Promise<BrokerOrder[]> {
    const rows = await this.#fetchAmendableRows();
    const date = currentKisDateTime().date;
    return rows.map((row) => {
      const branch = pickString(row, "ord_gno_brno", "ORD_GNO_BRNO");
      const orderNumber = pickString(row, "odno", "ODNO");
      const originalNumber = pickString(row, "orgn_odno", "ORGN_ODNO");
      const orderedQuantity = numberValue(row.ord_qty ?? row.ORD_QTY);
      const filledQuantity = numberValue(row.tot_ccld_qty ?? row.TOT_CCLD_QTY);
      const remainingQuantity = numberValue(row.psbl_qty ?? row.PSBL_QTY);
      const orderPrice = numberValue(row.ord_unpr ?? row.ORD_UNPR);
      const orderType = orderTypeFromKis(
        row.ord_dvsn_cd ?? row.ORD_DVSN_CD,
        orderPrice,
      );
      const order: BrokerOrder = {
        brokerOrderId: encodeBrokerOrderId(branch, orderNumber),
        symbol: pickString(row, "pdno", "PDNO").toUpperCase(),
        side: sideFromKis(row.sll_buy_dvsn_cd ?? row.SLL_BUY_DVSN_CD),
        orderType,
        orderedQuantity,
        filledQuantity,
        remainingQuantity,
        status: filledQuantity > 0 ? "PARTIALLY_FILLED" : "ACKED",
        orderedAt: isoFromKis(
          date,
          pickString(row, "ord_tmd", "ORD_TMD").padStart(6, "0"),
        ),
        raw: safeOrderRaw(row),
      };
      if (orderType === "limit") order.limitPrice = orderPrice;
      if (originalNumber !== "" && !/^0+$/.test(originalNumber)) {
        order.originalBrokerOrderId = encodeBrokerOrderId(branch, originalNumber);
      }
      return order;
    });
  }

  async fetchOrderHistory(fromDate: string): Promise<BrokerOrder[]> {
    if (!isYyyymmdd(fromDate)) {
      throw new BrokerRejectedError(
        "fromDate must use YYYYMMDD",
        "INVALID_DATE",
      );
    }
    const today = currentKisDateTime().date;
    if (fromDate > today) return [];
    const rows = await this.#fetchDailyExecutionRows(
      fromDate,
      today,
      KIS_TR_IDS[this.#environment].dailyExecutions,
    );
    const orders: BrokerOrder[] = [];
    const seen = new Set<string>();
    for (const row of rows) {
      const date = pickString(row, "ord_dt", "ORD_DT");
      const branch = pickString(row, "ord_gno_brno", "ORD_GNO_BRNO");
      const orderNumber = pickString(row, "odno", "ODNO");
      const symbol = pickString(row, "pdno", "PDNO").toUpperCase();
      const orderedQuantity = numberValue(row.ord_qty ?? row.ORD_QTY);
      if (
        !isYyyymmdd(date) ||
        orderNumber === "" ||
        !/^[0-9A-Z]{6}$/.test(symbol) ||
        orderedQuantity <= 0
      ) {
        continue;
      }
      const brokerOrderId = encodeBrokerOrderId(branch, orderNumber);
      const identity = `${date}:${brokerOrderId}`;
      if (seen.has(identity)) continue;
      seen.add(identity);
      const filledQuantity = Math.min(
        orderedQuantity,
        Math.max(0, numberValue(row.tot_ccld_qty ?? row.TOT_CCLD_QTY)),
      );
      const rejectedQuantity = Math.max(
        0,
        numberValue(row.rjct_qty ?? row.RJCT_QTY),
      );
      const canceled = pickString(row, "cncl_yn", "CNCL_YN") === "Y";
      const terminalRemainder = canceled || rejectedQuantity > 0;
      const status: BrokerOrder["status"] =
        filledQuantity >= orderedQuantity
          ? "FILLED"
          : terminalRemainder
            ? filledQuantity > 0
              ? "CANCELED"
              : "REJECTED"
            : filledQuantity > 0
              ? "PARTIALLY_FILLED"
              : "ACKED";
      const orderPrice = numberValue(row.ord_unpr ?? row.ORD_UNPR);
      const orderType = orderTypeFromKis(
        row.ord_dvsn_cd ?? row.ORD_DVSN_CD,
        orderPrice,
      );
      const order: BrokerOrder = {
        brokerOrderId,
        symbol,
        side: sideFromKis(row.sll_buy_dvsn_cd ?? row.SLL_BUY_DVSN_CD),
        orderType,
        orderedQuantity,
        filledQuantity,
        remainingQuantity: terminalRemainder
          ? 0
          : Math.max(0, orderedQuantity - filledQuantity),
        status,
        orderedAt: isoFromKis(
          date,
          pickString(row, "ord_tmd", "ORD_TMD").padStart(6, "0"),
        ),
        raw: safeOrderRaw(row),
      };
      const original = pickString(row, "orgn_odno", "ORGN_ODNO");
      if (original !== "" && !/^0+$/.test(original)) {
        order.originalBrokerOrderId = encodeBrokerOrderId(branch, original);
      }
      if (orderType === "limit" && orderPrice > 0) order.limitPrice = orderPrice;
      orders.push(order);
    }
    return orders.sort((left, right) =>
      left.orderedAt.localeCompare(right.orderedAt),
    );
  }

  async fetchAmendableOrders(): Promise<KisAmendableOrder[]> {
    const rows = await this.#fetchAmendableRows();
    return rows.map((row) => {
      const branchOrderNumber = pickString(row, "ord_gno_brno", "ORD_GNO_BRNO");
      const orderNumber = pickString(row, "odno", "ODNO");
      const originalNumber = pickString(row, "orgn_odno", "ORGN_ODNO");
      const result: KisAmendableOrder = {
        branchOrderNumber,
        brokerOrderId: encodeBrokerOrderId(branchOrderNumber, orderNumber),
        symbol: pickString(row, "pdno", "PDNO").toUpperCase(),
        amendableQuantity: numberValue(row.psbl_qty ?? row.PSBL_QTY),
        raw: safeOrderRaw(row),
      };
      if (originalNumber !== "" && !/^0+$/.test(originalNumber)) {
        result.originalBrokerOrderId = encodeBrokerOrderId(
          branchOrderNumber,
          originalNumber,
        );
      }
      return result;
    });
  }

  async fetchExecutions(fromDate: string): Promise<BrokerExecution[]> {
    if (!isYyyymmdd(fromDate)) {
      throw new BrokerRejectedError(
        "fromDate must use YYYYMMDD",
        "INVALID_DATE",
      );
    }
    const today = currentKisDateTime().date;
    if (fromDate > today) return [];
    const cutoff = yyyymmdd(dateDaysAgo(90));
    const rows: JsonRecord[] = [];
    if (fromDate < cutoff) {
      rows.push(
        ...(await this.#fetchDailyExecutionRows(
          fromDate,
          ymdAddDays(cutoff, -1),
          KIS_TR_IDS[this.#environment].historicalExecutions,
        )),
      );
    }
    rows.push(
      ...(await this.#fetchDailyExecutionRows(
        fromDate < cutoff ? cutoff : fromDate,
        today,
        KIS_TR_IDS[this.#environment].dailyExecutions,
      )),
    );

    const executions: BrokerExecution[] = [];
    const seen = new Set<string>();
    for (const row of rows) {
      const cumulativeQuantity = numberValue(row.tot_ccld_qty ?? row.TOT_CCLD_QTY);
      if (cumulativeQuantity <= 0) continue;
      const branch = pickString(row, "ord_gno_brno", "ORD_GNO_BRNO");
      const orderNumber = pickString(row, "odno", "ODNO");
      const brokerOrderId = encodeBrokerOrderId(branch, orderNumber);
      const date = pickString(row, "ord_dt", "ORD_DT");
      const time = pickString(row, "ord_tmd", "ORD_TMD").padStart(6, "0");
      let price = numberValue(row.avg_prvs ?? row.AVG_PRVS);
      let cumulativeNotional = numberValue(row.tot_ccld_amt ?? row.TOT_CCLD_AMT);
      if (price <= 0) {
        price = cumulativeNotional > 0 ? cumulativeNotional / cumulativeQuantity : 0;
      }
      if (price <= 0 || !/^\d{8}$/.test(date)) continue;
      if (cumulativeNotional <= 0) {
        cumulativeNotional = Math.round(cumulativeQuantity * price);
      }
      // inquire-daily-ccld is an order-level cumulative snapshot. Keeping a
      // stable source identity lets the database derive exactly one positive
      // delta even when this REST row overlaps real-time H0STCNI0 fills.
      const executionId = `kis-cumulative:${brokerOrderId}:${date}`;
      if (seen.has(executionId)) continue;
      seen.add(executionId);
      executions.push({
        executionId,
        brokerOrderId,
        symbol: pickString(row, "pdno", "PDNO").toUpperCase(),
        side: sideFromKis(row.sll_buy_dvsn_cd ?? row.SLL_BUY_DVSN_CD),
        quantity: cumulativeQuantity,
        price: Math.round(price),
        cumulativeQuantity,
        cumulativeNotional: Math.round(cumulativeNotional),
        executedAt: isoFromKis(date, time),
        raw: safeOrderRaw(row),
      });
    }
    return executions.sort((left, right) => left.executedAt.localeCompare(right.executedAt));
  }

  async #submitOrder(
    request: KisRestRequest,
    originalBrokerOrderId?: string,
  ): Promise<OrderSubmissionResult> {
    try {
      const result = await this.#rest.request(request);
      const output = outputRecord(result.body);
      const branch = pickString(
        output,
        "KRX_FWDG_ORD_ORGNO",
        "krx_fwdg_ord_orgno",
        "ORD_GNO_BRNO",
        "ord_gno_brno",
      );
      const orderNumber = pickString(output, "ODNO", "odno");
      if (orderNumber === "") {
        return {
          outcome: "INDETERMINATE",
          message:
            "KIS acknowledged the order but omitted its order number; reconcile before retrying",
          code: "KIS_ORDER_ID_MISSING",
          raw: {
            branchOrderNumber: branch,
            orderTime: pickString(output, "ORD_TMD", "ord_tmd"),
          },
        };
      }
      const submission: OrderSubmissionResult = {
        outcome: "ACCEPTED",
        brokerOrderId: encodeBrokerOrderId(branch, orderNumber),
        message: stringValue(result.body.msg1),
        code: stringValue(result.body.msg_cd),
        raw: {
          orderNumber,
          branchOrderNumber: branch,
          orderTime: pickString(output, "ORD_TMD", "ord_tmd"),
        },
      };
      if (originalBrokerOrderId !== undefined) {
        submission.originalBrokerOrderId = originalBrokerOrderId;
      }
      return submission;
    } catch (error) {
      if (error instanceof BrokerIndeterminateError) {
        const result: OrderSubmissionResult = {
          outcome: "INDETERMINATE",
          message: error.message,
        };
        if (error.code !== undefined) result.code = error.code;
        if (originalBrokerOrderId !== undefined) {
          result.originalBrokerOrderId = originalBrokerOrderId;
        }
        return result;
      }
      if (error instanceof BrokerRejectedError) {
        const result: OrderSubmissionResult = {
          outcome: "REJECTED",
          message: error.message,
        };
        if (error.code !== undefined) result.code = error.code;
        if (originalBrokerOrderId !== undefined) {
          result.originalBrokerOrderId = originalBrokerOrderId;
        }
        return result;
      }
      throw error;
    }
  }

  async #requireAmendable(
    brokerOrderId: string,
    requestedQuantity: number,
  ): Promise<KisAmendableOrder> {
    const decoded = decodeBrokerOrderId(brokerOrderId);
    const orders = await this.fetchAmendableOrders();
    const order = orders.find(
      (candidate) =>
        candidate.brokerOrderId === brokerOrderId ||
        decodeBrokerOrderId(candidate.brokerOrderId).orderNumber === decoded.orderNumber,
    );
    if (order === undefined) {
      throw new BrokerRejectedError(
        "The KIS order is not currently amendable or cancelable",
        "KIS_ORDER_NOT_AMENDABLE",
      );
    }
    if (requestedQuantity > order.amendableQuantity) {
      throw new BrokerRejectedError(
        "Requested quantity exceeds the latest KIS amendable quantity",
        "KIS_AMENDABLE_QUANTITY",
      );
    }
    return order;
  }

  async #fetchAmendableRows(): Promise<JsonRecord[]> {
    const rows: JsonRecord[] = [];
    let fk = "";
    let nk = "";
    const seen = new Set<string>();
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const result = await this.#rest.request({
        path: KIS_PATHS.amendableOrders,
        method: "GET",
        trId: KIS_TR_IDS[this.#environment].amendableOrders,
        kind: "account",
        trContinuation: page === 0 ? "" : "N",
        query: {
          CANO: this.#cano,
          ACNT_PRDT_CD: this.#productCode,
          INQR_DVSN_1: "0",
          INQR_DVSN_2: "0",
          CTX_AREA_FK100: fk,
          CTX_AREA_NK100: nk,
        },
      });
      rows.push(...records(result.body.output));
      if (!hasNextPage(result.trContinuation)) return rows;
      fk = stringValue(result.body.ctx_area_fk100);
      nk = stringValue(result.body.ctx_area_nk100);
      const cursor = `${fk}|${nk}`;
      if (seen.has(cursor) || cursor === "|") {
        throw new Error("KIS amendable-order pagination cursor did not advance");
      }
      seen.add(cursor);
    }
    throw new Error("KIS amendable-order pagination exceeded its safety limit");
  }

  async #fetchBalanceRows(): Promise<{
    positions: JsonRecord[];
    summaries: JsonRecord[];
  }> {
    const positions: JsonRecord[] = [];
    const summaries: JsonRecord[] = [];
    let fk = "";
    let nk = "";
    const seen = new Set<string>();
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const result = await this.#rest.request({
        path: KIS_PATHS.balance,
        method: "GET",
        trId: KIS_TR_IDS[this.#environment].balance,
        kind: "account",
        trContinuation: page === 0 ? "" : "N",
        query: {
          CANO: this.#cano,
          ACNT_PRDT_CD: this.#productCode,
          AFHR_FLPR_YN: "N",
          OFL_YN: "",
          INQR_DVSN: "02",
          UNPR_DVSN: "01",
          FUND_STTL_ICLD_YN: "N",
          FNCG_AMT_AUTO_RDPT_YN: "N",
          PRCS_DVSN: "00",
          CTX_AREA_FK100: fk,
          CTX_AREA_NK100: nk,
        },
      });
      positions.push(...records(result.body.output1));
      summaries.push(...records(result.body.output2));
      if (!hasNextPage(result.trContinuation)) return { positions, summaries };
      fk = stringValue(result.body.ctx_area_fk100);
      nk = stringValue(result.body.ctx_area_nk100);
      const cursor = `${fk}|${nk}`;
      if (seen.has(cursor) || cursor === "|") {
        throw new Error("KIS balance pagination cursor did not advance");
      }
      seen.add(cursor);
    }
    throw new Error("KIS balance pagination exceeded its safety limit");
  }

  async #fetchRealizedPnlToday(): Promise<number> {
    const result = await this.#rest.request({
      path: KIS_PATHS.balanceRealizedPnl,
      method: "GET",
      trId: KIS_TR_IDS[this.#environment].balanceRealizedPnl,
      kind: "account",
      query: {
        CANO: this.#cano,
        ACNT_PRDT_CD: this.#productCode,
        AFHR_FLPR_YN: "N",
        OFL_YN: "",
        INQR_DVSN: "02",
        UNPR_DVSN: "01",
        FUND_STTL_ICLD_YN: "N",
        FNCG_AMT_AUTO_RDPT_YN: "N",
        PRCS_DVSN: "01",
        COST_ICLD_YN: "Y",
        CTX_AREA_FK100: "",
        CTX_AREA_NK100: "",
      },
    });
    const summary = records(result.body.output2).at(-1) ?? asRecord(result.body.output2);
    const raw = summary.rlzt_pfls ?? summary.RLZT_PFLS;
    const normalized = stringValue(raw).replaceAll(",", "");
    const parsed = Number(normalized);
    if (normalized === "" || !Number.isFinite(parsed)) {
      throw new Error("KIS realized-PnL response did not include rlzt_pfls");
    }
    return Math.round(parsed);
  }

  async #fetchAvailableCash(): Promise<number> {
    // KIS documents this endpoint as the authoritative no-credit buying-power
    // source. A liquid KOSPI reference issue is used only because PDNO/price are
    // mandatory query fields; no quote or order is fabricated from this value.
    const reference = await this.fetchQuote("005930");
    const result = await this.#rest.request({
      path: KIS_PATHS.buyingPower,
      method: "GET",
      trId: KIS_TR_IDS[this.#environment].buyingPower,
      kind: "account",
      query: {
        CANO: this.#cano,
        ACNT_PRDT_CD: this.#productCode,
        PDNO: reference.symbol,
        ORD_UNPR: String(reference.price),
        // The official guide requires market order division when applying the
        // issue's margin rate to a full buying-power calculation.
        ORD_DVSN: "01",
        CMA_EVLU_AMT_ICLD_YN: "N",
        OVRS_ICLD_YN: "N",
      },
    });
    const output = outputRecord(result.body);
    const raw = output.nrcvb_buy_amt ?? output.NRCVB_BUY_AMT;
    if (raw === undefined || raw === null || stringValue(raw) === "") {
      throw new Error("KIS buying-power response did not include nrcvb_buy_amt");
    }
    const available = numberValue(raw);
    if (!Number.isFinite(available) || available < 0) {
      throw new Error("KIS buying-power response contained an invalid amount");
    }
    return Math.floor(available);
  }

  async #fetchDailyExecutionRows(
    startDate: string,
    endDate: string,
    trId: string,
  ): Promise<JsonRecord[]> {
    if (startDate > endDate) return [];
    const rows: JsonRecord[] = [];
    let fk = "";
    let nk = "";
    const seen = new Set<string>();
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const result = await this.#rest.request({
        path: KIS_PATHS.dailyExecutions,
        method: "GET",
        trId,
        kind: "account",
        trContinuation: page === 0 ? "" : "N",
        query: {
          CANO: this.#cano,
          ACNT_PRDT_CD: this.#productCode,
          INQR_STRT_DT: startDate,
          INQR_END_DT: endDate,
          SLL_BUY_DVSN_CD: "00",
          PDNO: "",
          CCLD_DVSN: "01",
          INQR_DVSN: "00",
          INQR_DVSN_3: "00",
          ORD_GNO_BRNO: "",
          ODNO: "",
          INQR_DVSN_1: "",
          CTX_AREA_FK100: fk,
          CTX_AREA_NK100: nk,
          EXCG_ID_DVSN_CD: "ALL",
        },
      });
      rows.push(...records(result.body.output1));
      if (!hasNextPage(result.trContinuation)) return rows;
      fk = stringValue(result.body.ctx_area_fk100);
      nk = stringValue(result.body.ctx_area_nk100);
      const cursor = `${fk}|${nk}`;
      if (seen.has(cursor) || cursor === "|") {
        throw new Error("KIS execution pagination cursor did not advance");
      }
      seen.add(cursor);
    }
    throw new Error("KIS execution pagination exceeded its safety limit");
  }

  #quoteFromCurrentPrice(symbol: string, row: JsonRecord): Quote {
    const price = numberValue(row.stck_prpr);
    if (price <= 0) {
      throw new Error("KIS current-price response omitted a valid price");
    }
    const now = currentKisDateTime();
    const quote: Quote = {
      symbol,
      price,
      cumulativeVolume: numberValue(row.acml_vol),
      tradingDate: domainTradingDate(now.date),
      tradingTime: now.time,
      receivedAt: new Date().toISOString(),
      source: "koreainvestment",
      exchange: this.#quoteExchange,
    };
    const open = numberValue(row.stck_oprc);
    const high = numberValue(row.stck_hgpr);
    const low = numberValue(row.stck_lwpr);
    if (open > 0) quote.open = open;
    if (high > 0) quote.high = high;
    if (low > 0) quote.low = low;
    return quote;
  }

  #emit(event: BrokerEvent): void {
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch {
        // A consumer callback must not take down the broker connection.
      }
    }
  }

  #setHealth(patch: Partial<BrokerHealth>): void {
    this.#health = {
      ...this.#health,
      ...patch,
      checkedAt: new Date().toISOString(),
    };
    this.#emit({ type: "health", health: this.getHealth() });
  }

  #reportError(message: string, code?: string): void {
    this.#setHealth({ state: "DEGRADED", lastError: message });
    const error: { message: string; code?: string; at: string } = {
      message,
      at: new Date().toISOString(),
    };
    if (code !== undefined) error.code = code;
    this.#emit({ type: "error", error });
  }
}

export { KoreaInvestmentBrokerAdapter as KisBrokerAdapter };

function validateKisExchange(
  exchange: Exchange,
  environment: "live" | "paper",
): void {
  if (!(["KRX", "NXT", "SOR"] as const).includes(exchange)) {
    throw new BrokerRejectedError("Unsupported KIS exchange", "INVALID_EXCHANGE");
  }
  if (environment === "paper" && exchange !== "KRX") {
    throw new BrokerRejectedError(
      "KIS paper trading supports KRX orders only",
      "PAPER_KRX_ONLY",
    );
  }
}

export function createKoreaInvestmentBrokerAdapter(
  options: KisBrokerAdapterOptions,
): KoreaInvestmentBrokerAdapter {
  return new KoreaInvestmentBrokerAdapter(options);
}
