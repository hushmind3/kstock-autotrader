import {
  BrokerIndeterminateError,
  BrokerRejectedError,
  BrokerTransportError,
  type AccountSnapshot,
  type AmendOrderRequest,
  type BrokerAdapter,
  type BrokerAdapterOptions,
  type BrokerCapabilities,
  type BrokerEvent,
  type BrokerExecution,
  type BrokerHealth,
  type BrokerOrder,
  type CancelOrderRequest,
  type DailyBar,
  type Exchange,
  type Instrument,
  type OrderSubmissionResult,
  type PlaceOrderRequest,
  type Quote,
} from "@kstock/shared";
import type WebSocket from "ws";

import { KiwoomTokenManager } from "./auth.js";
import { KiwoomProtocolError } from "./errors.js";
import { KiwoomHttpClient, type KiwoomContinuation } from "./http-client.js";
import {
  ensureUniqueBy,
  parseDailyBar,
  parseHistoricalExecution,
  parseHistoricalOrders,
  parseInstrumentRecords,
  parseOpenOrder,
  parsePosition,
  parseQuote,
  rejectUnsupportedExecutionRange,
} from "./parsers.js";
import {
  assertSymbol,
  brokerNumber,
  enumerateKstDates,
  isYyyyMmDd,
  isKiwoomAccountId,
  isSameKiwoomAccount,
  kiwoomQuoteSymbol,
  kstNowParts,
  normalizeAccountId,
  recordsAt,
  redactText,
  requiredBrokerNumber,
  requiredString,
  stringAt,
  type UnknownRecord,
} from "./normalization.js";
import { KiwoomRateLimiter } from "./rate-limiter.js";
import {
  KiwoomWebSocketClient,
  type KiwoomWebSocketStatus,
} from "./websocket.js";

export const KIWOOM_ENDPOINTS = {
  live: {
    rest: "https://api.kiwoom.com",
    websocket: "wss://api.kiwoom.com:10000/api/dostk/websocket",
  },
  paper: {
    rest: "https://mockapi.kiwoom.com",
    websocket: "wss://mockapi.kiwoom.com:10000/api/dostk/websocket",
  },
} as const;

const MAX_LIVE_REQUESTS_PER_SECOND = 5;
const DEFAULT_LIVE_QUERY_REQUESTS_PER_SECOND = 4;
const MAX_REALTIME_SYMBOLS = 200;
const DEFAULT_QUOTE_BATCH_SIZE = 1;
const MAX_PAGES = 1_000;

/**
 * kt00009 reports an empty order-history result as a rejected response instead
 * of a successful response containing an empty array.  Keep this exception
 * narrowly scoped to the documented inner response code so authentication,
 * permission and malformed-request failures are never hidden as "no orders".
 */
function isEmptyHistoricalOrderResponse(error: unknown): boolean {
  return error instanceof BrokerRejectedError &&
    /(?:^|\()501724\s*:\s*관련자료가없습니다(?:\)|$)/.test(error.message);
}

export interface KiwoomBrokerAdapterOptions extends BrokerAdapterOptions {
  /**
   * ka10095 accepts pipe-delimited symbols, but Kiwoom does not publish a
   * maximum count. The fail-safe default is one; increase only after validating
   * the intended account/environment.
   */
  quoteBatchSize?: number;
  requestTimeoutMs?: number;
  fetchImplementation?: typeof fetch;
  webSocketFactory?: (url: string) => WebSocket;
}

export class KiwoomBrokerAdapter implements BrokerAdapter {
  readonly scope;
  readonly capabilities: BrokerCapabilities;

  private readonly listeners = new Set<(event: BrokerEvent) => void>();
  private readonly tokenManager: KiwoomTokenManager;
  private readonly http: KiwoomHttpClient;
  private readonly websocket: KiwoomWebSocketClient;
  private readonly quoteBatchSize: number;
  private readonly quoteExchange: Exchange;
  private readonly submissionByClientOrderId = new Map<
    string,
    Promise<OrderSubmissionResult>
  >();
  private health: BrokerHealth;

  constructor(private readonly options: KiwoomBrokerAdapterOptions) {
    validateCredentials(options);
    const endpoint = KIWOOM_ENDPOINTS[options.environment];
    this.quoteExchange = options.quoteExchange ?? "KRX";
    validateQuoteExchange(this.quoteExchange, options.environment);
    this.scope = {
      brokerId: "kiwoom" as const,
      environment: options.environment,
      accountId: options.credentials.accountId,
    };
    const paper = options.environment === "paper";
    const queryRate = paper
      ? 1
      : clampRate(
          options.queryRequestsPerSecond ?? DEFAULT_LIVE_QUERY_REQUESTS_PER_SECOND,
          MAX_LIVE_REQUESTS_PER_SECOND,
        );
    const orderRate = paper
      ? 1
      : clampRate(options.orderRequestsPerSecond, MAX_LIVE_REQUESTS_PER_SECOND);
    this.quoteBatchSize = validateQuoteBatchSize(
      options.quoteBatchSize ?? DEFAULT_QUOTE_BATCH_SIZE,
    );
    this.capabilities = {
      supportsLive: true,
      supportsPaper: true,
      supportsAmend: true,
      supportsCancel: true,
      maxQuoteSubscriptions: MAX_REALTIME_SYMBOLS,
      quoteBatchSize: this.quoteBatchSize,
      queryRequestsPerSecond: queryRate,
      orderRequestsPerSecond: orderRate,
      clientOrderIdSupported: false,
    };
    this.health = disconnectedHealth();

    this.tokenManager = new KiwoomTokenManager({
      baseUrl: endpoint.rest,
      scope: this.scope,
      credentials: options.credentials,
      tokenStore: options.tokenStore,
      ...(options.requestTimeoutMs === undefined
        ? {}
        : { requestTimeoutMs: options.requestTimeoutMs }),
      ...(options.fetchImplementation === undefined
        ? {}
        : { fetchImplementation: options.fetchImplementation }),
    });
    const rateLimiter = new KiwoomRateLimiter({
      paper,
      queryRequestsPerSecond: queryRate,
      orderRequestsPerSecond: orderRate,
    });
    this.http = new KiwoomHttpClient({
      baseUrl: endpoint.rest,
      tokenManager: this.tokenManager,
      rateLimiter,
      ...(options.requestTimeoutMs === undefined
        ? {}
        : { requestTimeoutMs: options.requestTimeoutMs }),
      ...(options.fetchImplementation === undefined
        ? {}
        : { fetchImplementation: options.fetchImplementation }),
    });
    this.websocket = new KiwoomWebSocketClient({
      url: endpoint.websocket,
      scope: this.scope,
      quoteExchange: this.quoteExchange,
      tokenManager: this.tokenManager,
      onEvent: (event) => this.handleWebSocketEvent(event),
      onStatus: (status) => this.handleWebSocketStatus(status),
      ...(options.webSocketFactory === undefined
        ? {}
        : { webSocketFactory: options.webSocketFactory }),
    });
  }

  async connect(): Promise<void> {
    this.setHealth({
      state: "AUTHENTICATING",
      restConnected: false,
      marketWebSocketConnected: false,
      accountWebSocketConnected: false,
    });
    try {
      await this.tokenManager.getAccessToken();
      const verifiedAccountId = await this.verifyConfiguredAccount();
      this.websocket.setVerifiedAccountId(verifiedAccountId);
      this.setHealth({
        state: "SYNCING",
        restConnected: true,
        marketWebSocketConnected: false,
        accountWebSocketConnected: false,
      });
      await this.websocket.connect();
    } catch (error) {
      const message = this.safeErrorMessage(error);
      this.setHealth({
        state: "ERROR",
        restConnected: false,
        marketWebSocketConnected: false,
        accountWebSocketConnected: false,
        lastError: message,
      });
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    await this.websocket.disconnect();
    this.setHealth({
      state: "DISCONNECTED",
      restConnected: false,
      marketWebSocketConnected: false,
      accountWebSocketConnected: false,
    });
  }

  getHealth(): BrokerHealth {
    return { ...this.health, checkedAt: new Date().toISOString() };
  }

  onEvent(listener: (event: BrokerEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async fetchInstruments(): Promise<Instrument[]> {
    const records = await this.collectRecords(
      "ka10099",
      "/api/dostk/stkinfo",
      { mrkt_tp: "0" },
      "list",
    );
    const parsed = parseInstrumentRecords(records);
    if (parsed.issues.length > 0) {
      const counts = new Map<string, number>();
      for (const issue of parsed.issues) {
        counts.set(issue.code, (counts.get(issue.code) ?? 0) + 1);
      }
      const summary = [...counts]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([code, count]) => `${code}: ${count}`)
        .join(", ");
      this.emit({
        type: "error",
        error: {
          code: "KIWOOM_INSTRUMENT_RECORDS_SKIPPED",
          message: `Kiwoom KOSPI universe skipped ${parsed.issues.length} malformed record(s) (${summary}).`,
          at: new Date().toISOString(),
        },
      });
    }
    if (records.length > 0 && parsed.instruments.length === 0) {
      throw new KiwoomProtocolError(
        "Kiwoom returned no usable KOSPI instrument records.",
        "MALFORMED_INSTRUMENT_UNIVERSE",
      );
    }
    return ensureUniqueBy(parsed.instruments, (instrument) => instrument.symbol);
  }

  async fetchDailyBars(symbol: string, requiredCount: number): Promise<DailyBar[]> {
    const normalizedSymbol = assertSymbol(symbol);
    if (!Number.isSafeInteger(requiredCount) || requiredCount <= 0) {
      throw new KiwoomProtocolError(
        "requiredCount must be a positive integer.",
        "INVALID_BAR_COUNT",
      );
    }
    const baseDate = kstNowParts().date;
    const records = await this.collectRecords(
      "ka10081",
      "/api/dostk/chart",
      { stk_cd: normalizedSymbol, base_dt: baseDate, upd_stkpc_tp: "1" },
      "stk_dt_pole_chart_qry",
      requiredCount,
    );
    const bars = ensureUniqueBy(
      records.map((record) => parseDailyBar(record, normalizedSymbol)),
      (bar) => bar.tradingDate,
    ).sort((left, right) => left.tradingDate.localeCompare(right.tradingDate));
    return bars.slice(-requiredCount);
  }

  async fetchQuote(symbol: string): Promise<Quote> {
    const quotes = await this.fetchQuotes([symbol]);
    const quote = quotes[0];
    if (quote === undefined) {
      throw new KiwoomProtocolError(
        "Kiwoom returned no quote for the requested symbol.",
        "QUOTE_NOT_FOUND",
      );
    }
    return quote;
  }

  async fetchQuotes(symbols: string[]): Promise<Quote[]> {
    const normalized = [...new Set(symbols.map(assertSymbol))];
    if (normalized.length === 0) return [];
    const result: Quote[] = [];
    for (const symbolsChunk of chunk(normalized, this.quoteBatchSize)) {
      const response = await this.http.post({
        apiId: "ka10095",
        path: "/api/dostk/stkinfo",
        kind: "query",
        body: {
          stk_cd: symbolsChunk
            .map((symbol) => kiwoomQuoteSymbol(symbol, this.quoteExchange))
            .join("|"),
        },
      });
      result.push(
        ...recordsAt(response.body, "atn_stk_infr").map((record) =>
          parseQuote(record, new Date(), this.quoteExchange),
        ),
      );
    }
    const bySymbol = new Map(result.map((quote) => [quote.symbol, quote]));
    return normalized.flatMap((symbol) => {
      const quote = bySymbol.get(symbol);
      return quote === undefined ? [] : [quote];
    });
  }

  async replaceQuoteSubscriptions(symbols: string[]): Promise<void> {
    return this.websocket.replaceQuoteSubscriptions(symbols);
  }

  async placeOrder(request: PlaceOrderRequest): Promise<OrderSubmissionResult> {
    validatePlaceOrder(request, this.options.environment);
    const symbol = assertSymbol(request.symbol);
    return this.submitOnce(request.clientOrderId, async () => {
      const apiId = request.side === "buy" ? "kt10000" : "kt10001";
      return this.submitOrder(apiId, {
        dmst_stex_tp: request.exchange,
        stk_cd: symbol,
        ord_qty: String(request.quantity),
        trde_tp: request.orderType === "market" ? "3" : "0",
        ord_uv: request.orderType === "market" ? "" : String(request.limitPrice),
        cond_uv: "",
      });
    });
  }

  async amendOrder(request: AmendOrderRequest): Promise<OrderSubmissionResult> {
    validateAmendOrder(request, this.options.environment);
    const symbol = assertSymbol(request.symbol);
    return this.submitOnce(request.clientOrderId, async () => {
      const result = await this.submitOrder("kt10002", {
        dmst_stex_tp: request.exchange,
        orig_ord_no: request.brokerOrderId,
        stk_cd: symbol,
        mdfy_qty: String(request.remainingQuantity),
        mdfy_uv: String(request.newLimitPrice),
        mdfy_cond_uv: "",
      });
      return {
        ...result,
        originalBrokerOrderId: request.brokerOrderId,
      };
    });
  }

  async cancelOrder(request: CancelOrderRequest): Promise<OrderSubmissionResult> {
    validateCancelOrder(request, this.options.environment);
    const symbol = assertSymbol(request.symbol);
    return this.submitOnce(request.clientOrderId, async () => {
      const result = await this.submitOrder("kt10003", {
        dmst_stex_tp: request.exchange,
        orig_ord_no: request.brokerOrderId,
        stk_cd: symbol,
        cncl_qty: String(request.remainingQuantity),
      });
      return {
        ...result,
        originalBrokerOrderId: request.brokerOrderId,
      };
    });
  }

  async fetchAccountSnapshot(): Promise<AccountSnapshot> {
    const today = kstNowParts().date;
    const [cashResponse, balance, realizedResponse, openOrders] = await Promise.all([
      this.http.post({
        apiId: "kt00001",
        path: "/api/dostk/acnt",
        kind: "query",
        body: { qry_tp: "2" },
      }),
      this.fetchBalance(),
      this.http.post({
        apiId: "ka10074",
        path: "/api/dostk/acnt",
        kind: "query",
        body: { strt_dt: today, end_dt: today },
      }),
      this.fetchOpenOrders(),
    ]);
    const cash = requiredBrokerNumber(cashResponse.body, "entr", "cash balance");
    const availableCash = requiredBrokerNumber(
      cashResponse.body,
      "ord_alow_amt",
      "orderable cash",
    );
    const totalEvaluation =
      brokerNumber(balance.summary.prsm_dpst_aset_amt) ??
      requiredBrokerNumber(balance.summary, "tot_evlt_amt", "total evaluation");
    return {
      scope: this.scope,
      cash,
      availableCash,
      totalEvaluation,
      realizedPnlToday: requiredBrokerNumber(
        realizedResponse.body,
        "rlzt_pl",
        "today realized PnL",
      ),
      unrealizedPnl: requiredBrokerNumber(
        balance.summary,
        "tot_evlt_pl",
        "unrealized PnL",
      ),
      positions: balance.positions,
      openOrders,
      fetchedAt: new Date().toISOString(),
    };
  }

  async fetchOpenOrders(): Promise<BrokerOrder[]> {
    const records = await this.collectRecords(
      "ka10075",
      "/api/dostk/acnt",
      { all_stk_tp: "0", trde_tp: "0", stex_tp: "0", stk_cd: "" },
      "oso",
    );
    return ensureUniqueBy(records.map((record) => parseOpenOrder(record)), (order) => order.brokerOrderId);
  }

  async fetchExecutions(fromDate: string): Promise<BrokerExecution[]> {
    const normalizedFrom = normalizeDateInput(fromDate);
    const today = kstNowParts().date;
    const dates = enumerateKstDates(normalizedFrom, today);
    rejectUnsupportedExecutionRange(dates.length);
    const executions: BrokerExecution[] = [];
    for (const date of dates) {
      // ka10076 does not include a trading-date field and can replay the last
      // business day's fills on weekends/holidays. Stamping those rows with
      // today's date duplicates an already reconciled order. kt00009 is the
      // official date-scoped ledger endpoint, so use it for today as well as
      // historical dates and keep the broker's durable execution number.
      let historical: UnknownRecord[];
      try {
        historical = await this.collectRecords(
          "kt00009",
          "/api/dostk/acnt",
          {
            stk_bond_tp: "1",
            mrkt_tp: "1",
            sell_tp: "0",
            qry_tp: "1",
            dmst_stex_tp: this.quoteExchange,
            ord_dt: date,
            stk_cd: "",
            fr_ord_no: "",
          },
          "acnt_ord_cntr_prst_array",
        );
      } catch (error) {
        if (!isEmptyHistoricalOrderResponse(error)) throw error;
        historical = [];
      }
      executions.push(
        ...historical.flatMap((record) => {
          const parsed = parseHistoricalExecution(record, date);
          return parsed === undefined ? [] : [parsed];
        }),
      );
    }
    return ensureUniqueBy(executions, (execution) => execution.executionId).sort((left, right) =>
      left.executedAt.localeCompare(right.executedAt),
    );
  }

  async fetchOrderHistory(fromDate: string): Promise<BrokerOrder[]> {
    const normalizedFrom = normalizeDateInput(fromDate);
    const today = kstNowParts().date;
    const dates = enumerateKstDates(normalizedFrom, today);
    rejectUnsupportedExecutionRange(dates.length);
    const orders: BrokerOrder[] = [];
    for (const date of dates) {
      let records: UnknownRecord[];
      try {
        records = await this.collectRecords(
          "kt00009",
          "/api/dostk/acnt",
          {
            stk_bond_tp: "1",
            mrkt_tp: "1",
            sell_tp: "0",
            // 0 is the official all-orders mode; 1 would omit cancellations.
            qry_tp: "0",
              dmst_stex_tp: this.quoteExchange,
            ord_dt: date,
            stk_cd: "",
            fr_ord_no: "",
          },
          "acnt_ord_cntr_prst_array",
        );
      } catch (error) {
        if (!isEmptyHistoricalOrderResponse(error)) throw error;
        records = [];
      }
      orders.push(...parseHistoricalOrders(records, date));
    }
    return ensureUniqueBy(
      orders,
      (order) => `${order.orderedAt.slice(0, 10)}:${order.brokerOrderId}`,
    );
  }

  private async verifyConfiguredAccount(): Promise<string> {
    const response = await this.http.post({
      apiId: "ka00001",
      path: "/api/dostk/acnt",
      kind: "query",
      body: {},
    });
    const accountList = requiredString(response.body, "acctNo", "account list");
    const configured = normalizeAccountId(this.options.credentials.accountId);
    const matches = [...new Set(accountList
      .split(/[;,|\s]+/)
      .map(normalizeAccountId)
      .filter((candidate) =>
        isKiwoomAccountId(candidate) &&
        isSameKiwoomAccount(configured, candidate),
      ))];
    if (matches.length === 0) {
      throw new BrokerRejectedError(
        "The configured Kiwoom account is not available to this API key.",
        "ACCOUNT_SCOPE_MISMATCH",
      );
    }
    if (configured.length === 8 && matches.length > 1) {
      throw new BrokerRejectedError(
        "The configured Kiwoom account root matches multiple accounts; enter the full 10-digit account number.",
        "ACCOUNT_SCOPE_AMBIGUOUS",
      );
    }
    // Preserve an explicitly configured full account. For an 8-digit root,
    // bind the WebSocket parser to the single full account returned by Kiwoom.
    return configured.length === 10 ? configured : (matches[0] ?? configured);
  }

  private async fetchBalance(): Promise<{
    summary: UnknownRecord;
    positions: ReturnType<typeof parsePosition>[];
  }> {
    const records: UnknownRecord[] = [];
    let continuation: KiwoomContinuation | undefined;
    let firstSummary: UnknownRecord | undefined;
    const seen = new Set<string>();
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const response = await this.http.post({
        apiId: "kt00018",
        path: "/api/dostk/acnt",
        kind: "query",
        body: { qry_tp: "1", dmst_stex_tp: "KRX" },
        ...(continuation === undefined ? {} : { continuation }),
      });
      firstSummary ??= response.body;
      records.push(...recordsAt(response.body, "acnt_evlt_remn_indv_tot"));
      if (response.continuation === undefined) break;
      const key = `${response.continuation.contYn}:${response.continuation.nextKey}`;
      if (seen.has(key)) {
        throw new KiwoomProtocolError(
          "Kiwoom repeated a balance continuation key.",
          "CONTINUATION_LOOP",
        );
      }
      seen.add(key);
      continuation = response.continuation;
    }
    if (firstSummary === undefined) {
      throw new KiwoomProtocolError("Kiwoom returned no balance response.", "MALFORMED_RESPONSE");
    }
    return {
      summary: firstSummary,
      positions: ensureUniqueBy(records.map(parsePosition), (position) => position.symbol),
    };
  }

  private async collectRecords(
    apiId: string,
    path: string,
    body: UnknownRecord,
    recordKey: string,
    stopAfter?: number,
  ): Promise<UnknownRecord[]> {
    const result: UnknownRecord[] = [];
    let continuation: KiwoomContinuation | undefined;
    const seen = new Set<string>();
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const response = await this.http.post({
        apiId,
        path,
        kind: "query",
        body,
        ...(continuation === undefined ? {} : { continuation }),
      });
      result.push(...recordsAt(response.body, recordKey));
      if (stopAfter !== undefined && result.length >= stopAfter) break;
      if (response.continuation === undefined) break;
      const key = `${response.continuation.contYn}:${response.continuation.nextKey}`;
      if (seen.has(key)) {
        throw new KiwoomProtocolError(
          `Kiwoom repeated a continuation key for ${apiId}.`,
          "CONTINUATION_LOOP",
        );
      }
      seen.add(key);
      continuation = response.continuation;
    }
    return result;
  }

  private async submitOrder(
    apiId: "kt10000" | "kt10001" | "kt10002" | "kt10003",
    body: UnknownRecord,
  ): Promise<OrderSubmissionResult> {
    try {
      const response = await this.http.post({
        apiId,
        path: "/api/dostk/ordr",
        kind: "order",
        body,
      });
      return {
        outcome: "ACCEPTED",
        brokerOrderId: requiredString(response.body, "ord_no", "broker order number"),
      };
    } catch (error) {
      if (error instanceof BrokerRejectedError) {
        return {
          outcome: "REJECTED",
          message: this.safeErrorMessage(error),
          ...(error.code === undefined ? {} : { code: error.code }),
        };
      }
      if (error instanceof BrokerIndeterminateError || error instanceof BrokerTransportError) {
        return {
          outcome: "INDETERMINATE",
          message:
            "Order acknowledgement is unknown. Reconcile open orders and executions before any retry.",
          ...(error.code === undefined ? {} : { code: error.code }),
        };
      }
      if (error instanceof KiwoomProtocolError) {
        return {
          outcome: "INDETERMINATE",
          message:
            "Order response could not be normalized. Reconcile open orders and executions before any retry.",
          ...(error.code === undefined ? {} : { code: error.code }),
        };
      }
      throw error;
    }
  }

  private submitOnce(
    clientOrderId: string,
    submit: () => Promise<OrderSubmissionResult>,
  ): Promise<OrderSubmissionResult> {
    if (clientOrderId.trim() === "") {
      throw new KiwoomProtocolError("clientOrderId is required.", "INVALID_CLIENT_ORDER_ID");
    }
    const existing = this.submissionByClientOrderId.get(clientOrderId);
    if (existing !== undefined) return existing;
    const pending = submit();
    this.submissionByClientOrderId.set(clientOrderId, pending);
    return pending;
  }

  private handleWebSocketEvent(event: BrokerEvent): void {
    if (event.type === "quote") {
      this.health = { ...this.health, lastQuoteAt: event.quote.receivedAt };
    } else if (
      event.type === "order" ||
      event.type === "execution" ||
      event.type === "position"
    ) {
      this.health = { ...this.health, lastAccountEventAt: new Date().toISOString() };
    }
    this.emit(event);
  }

  private handleWebSocketStatus(status: KiwoomWebSocketStatus): void {
    const state = status.connected && status.accountSubscribed ? "CONNECTED" : "DEGRADED";
    this.setHealth({
      state,
      restConnected: this.health.restConnected,
      marketWebSocketConnected: status.connected && status.quoteSubscribed,
      accountWebSocketConnected: status.connected && status.accountSubscribed,
      ...(status.lastError === undefined ? {} : { lastError: status.lastError }),
    });
  }

  private setHealth(
    update: Pick<
      BrokerHealth,
      | "state"
      | "restConnected"
      | "marketWebSocketConnected"
      | "accountWebSocketConnected"
    > &
      Partial<Pick<BrokerHealth, "lastError">>,
  ): void {
    this.health = {
      ...this.health,
      ...update,
      // A recovered connection must not keep showing a stale transport error
      // from the previous WebSocket generation.
      lastError: update.lastError,
      checkedAt: new Date().toISOString(),
    };
    this.emit({ type: "health", health: this.getHealth() });
  }

  private emit(event: BrokerEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  private safeErrorMessage(error: unknown): string {
    const message = error instanceof Error ? error.message : "Unknown Kiwoom adapter error.";
    return redactText(message, this.tokenManager.sensitiveValues);
  }
}

function disconnectedHealth(): BrokerHealth {
  return {
    state: "DISCONNECTED",
    restConnected: false,
    marketWebSocketConnected: false,
    accountWebSocketConnected: false,
    checkedAt: new Date().toISOString(),
  };
}

function clampRate(value: number | undefined, maximum: number): number {
  const candidate = value ?? maximum;
  if (!Number.isFinite(candidate) || candidate <= 0) {
    throw new RangeError("Kiwoom request rates must be greater than zero.");
  }
  return Math.min(candidate, maximum);
}

function validateQuoteBatchSize(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_REALTIME_SYMBOLS) {
    throw new RangeError("quoteBatchSize must be an integer between 1 and 200.");
  }
  return value;
}

function validateCredentials(options: BrokerAdapterOptions): void {
  if (
    options.credentials.appKey.trim() === "" ||
    options.credentials.appSecret.trim() === "" ||
    !isKiwoomAccountId(options.credentials.accountId)
  ) {
    throw new KiwoomProtocolError(
      "Kiwoom credentials are incomplete.",
      "INVALID_CREDENTIALS",
    );
  }
}

function validateQuoteExchange(
  exchange: Exchange,
  environment: "live" | "paper",
): void {
  if (!(["KRX", "NXT", "SOR"] as const).includes(exchange)) {
    throw new KiwoomProtocolError(
      "Unsupported Kiwoom quote exchange.",
      "INVALID_EXCHANGE",
    );
  }
  if (environment === "paper" && exchange !== "KRX") {
    throw new BrokerRejectedError(
      "Kiwoom paper trading supports KRX market data only.",
      "PAPER_KRX_ONLY",
    );
  }
}

function validatePlaceOrder(
  request: PlaceOrderRequest,
  environment: "live" | "paper",
): void {
  validateOrderCommon(request.quantity, request.exchange, environment);
  if (
    request.orderType === "limit" &&
    (!Number.isSafeInteger(request.limitPrice) || (request.limitPrice ?? 0) <= 0)
  ) {
    throw new KiwoomProtocolError(
      "A Kiwoom limit order requires a positive integer price.",
      "INVALID_ORDER_PRICE",
    );
  }
}

function validateAmendOrder(
  request: AmendOrderRequest,
  environment: "live" | "paper",
): void {
  validateOrderCommon(request.remainingQuantity, request.exchange, environment);
  if (!Number.isSafeInteger(request.newLimitPrice) || request.newLimitPrice <= 0) {
    throw new KiwoomProtocolError(
      "A Kiwoom amendment requires a positive integer price.",
      "INVALID_ORDER_PRICE",
    );
  }
  if (request.brokerOrderId.trim() === "") {
    throw new KiwoomProtocolError("brokerOrderId is required.", "INVALID_ORDER_ID");
  }
}

function validateCancelOrder(
  request: CancelOrderRequest,
  environment: "live" | "paper",
): void {
  validateOrderCommon(request.remainingQuantity, request.exchange, environment);
  if (request.brokerOrderId.trim() === "") {
    throw new KiwoomProtocolError("brokerOrderId is required.", "INVALID_ORDER_ID");
  }
}

function validateOrderCommon(
  quantity: number,
  exchange: Exchange,
  environment: "live" | "paper",
): void {
  if (!Number.isSafeInteger(quantity) || quantity <= 0) {
    throw new KiwoomProtocolError(
      "Kiwoom order quantity must be a positive integer.",
      "INVALID_ORDER_QUANTITY",
    );
  }
  if (!(["KRX", "NXT", "SOR"] as const).includes(exchange)) {
    throw new KiwoomProtocolError("Unsupported Kiwoom exchange.", "INVALID_EXCHANGE");
  }
  if (environment === "paper" && exchange !== "KRX") {
    throw new BrokerRejectedError(
      "Kiwoom paper trading supports KRX orders only.",
      "PAPER_KRX_ONLY",
    );
  }
}

function normalizeDateInput(value: string): string {
  const normalized = /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? value.replaceAll("-", "")
    : value;
  if (!isYyyyMmDd(normalized)) {
    throw new KiwoomProtocolError(
      "fromDate must use YYYYMMDD or YYYY-MM-DD.",
      "INVALID_DATE_RANGE",
    );
  }
  return normalized;
}

function chunk<T>(values: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}
