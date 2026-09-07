import { createDecipheriv } from "node:crypto";
import { BrokerRejectedError } from "@kstock/shared";
import { KIS_ENDPOINTS } from "@kstock/broker-kis";
import WebSocket, { type RawData } from "ws";
import { KIS_DERIVATIVE_TR_IDS } from "./constants.js";
import type {
  DerivativeExecution,
  DerivativeInstrumentKind,
  DerivativeOrder,
  DerivativeQuote,
  DerivativeQuoteSubscription,
  DerivativeSession,
  KisDerivativeEvent,
} from "./types.js";
import { numericValue, stringValue, yyyymmdd } from "./utils.js";

interface EncryptionMaterial {
  key: string;
  iv: string;
}

interface SubscriptionWaiter {
  trId: string;
  trKey: string;
  resolve: () => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

const SUBSCRIPTION_PACING_MS = 100;
const SUBSCRIPTION_ACK_TIMEOUT_MS = 10_000;
const CONNECTION_READY_TIMEOUT_MS = 45_000;

export interface KisDerivativeWebSocketOptions {
  environment: "live" | "paper";
  htsId?: string;
  approvalKey: () => Promise<string>;
  unsubscribeTrType: "0" | "2";
  onEvent: (event: KisDerivativeEvent) => void;
}

const FUTURE_TRADE_COLUMNS = [
  "symbol", "time", "change", "changeSign", "changeRate", "price", "open", "high", "low",
  "lastQuantity", "cumulativeVolume", "cumulativeAmount", "theoreticalPrice", "basis", "disparity",
  "nearSettlement", "farSettlement", "spread", "openInterest", "openInterestChange", "openTime",
  "openSign", "openVsIndex", "highTime", "highSign", "highVsIndex", "lowTime", "lowSign",
  "lowVsIndex", "buyRatio", "strength", "estimated", "previousOpenInterestChange", "theoreticalBasis",
  "ask1", "bid1", "askRemaining1", "bidRemaining1", "sellCount", "buyCount", "netCount",
  "sellSum", "buySum", "totalAskRemaining", "totalBidRemaining", "volumeRatio", "disclosedBlock",
  "dynamicUpper", "dynamicLower", "dynamicLimit",
] as const;

const OPTION_TRADE_COLUMNS = [
  "symbol", "time", "price", "changeSign", "change", "changeRate", "open", "high", "low",
  "lastQuantity", "cumulativeVolume", "cumulativeAmount", "theoreticalPrice", "openInterest",
  "openInterestChange", "openTime", "openSign", "openVsIndex", "highTime", "highSign", "highVsIndex",
  "lowTime", "lowSign", "lowVsIndex", "buyRatio", "premiumValue", "intrinsicValue", "timeValue",
  "delta", "gamma", "vega", "theta", "rho", "impliedVolatility", "estimated",
  "previousOpenInterestChange", "theoreticalBasis", "historicalVolatility", "strength", "disparity",
  "basis", "ask1", "bid1", "askRemaining1", "bidRemaining1", "sellCount", "buyCount", "netCount",
  "sellSum", "buySum", "totalAskRemaining", "totalBidRemaining", "volumeRatio", "largeVolume",
  "dynamicUpper", "dynamicLower", "dynamicLimit",
] as const;

const DAY_NOTICE_COLUMNS = [
  "customerId", "accountNumber", "orderNumber", "originalOrderNumber", "side", "correctionType",
  "orderKind", "symbol", "fillQuantity", "fillPrice", "time", "refused", "filled", "accepted",
  "branchNumber", "orderQuantity", "accountName", "instrumentName", "orderCondition", "orderGroup",
  "orderGroupSequence", "orderPrice",
] as const;

const NIGHT_NOTICE_COLUMNS = DAY_NOTICE_COLUMNS.slice(0, 19);

function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data as unknown as ArrayBuffer);
}

function decrypt(payload: string, material: EncryptionMaterial): string {
  const key = Buffer.from(material.key, "utf8");
  const iv = Buffer.from(material.iv, "utf8");
  if (key.length !== 32 || iv.length !== 16) throw new Error("KIS websocket returned invalid AES material");
  const decipher = createDecipheriv("aes-256-cbc", key, iv);
  return Buffer.concat([
    decipher.update(Buffer.from(payload, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

function subscribeMessage(approvalKey: string, trType: string, trId: string, trKey: string): string {
  return JSON.stringify({
    header: {
      "content-type": "utf-8",
      approval_key: approvalKey,
      tr_type: trType,
      custtype: "P",
    },
    body: { input: { tr_id: trId, tr_key: trKey } },
  });
}

function trIdFor(subscription: DerivativeQuoteSubscription): string {
  if (subscription.session === "NIGHT") {
    if (subscription.instrumentKind === "INDEX_FUTURE") return KIS_DERIVATIVE_TR_IDS.realtime.night.INDEX_FUTURE;
    if (subscription.instrumentKind === "INDEX_OPTION") return KIS_DERIVATIVE_TR_IDS.realtime.night.INDEX_OPTION;
    throw new BrokerRejectedError(
      "KIS official websocket examples do not document this product for the KRX night session",
      "KIS_DERIVATIVE_NIGHT_PRODUCT_UNSUPPORTED",
    );
  }
  return KIS_DERIVATIVE_TR_IDS.realtime.day[subscription.instrumentKind];
}

function kindForTrId(trId: string): DerivativeInstrumentKind | undefined {
  for (const [kind, value] of Object.entries(KIS_DERIVATIVE_TR_IDS.realtime.day)) {
    if (value === trId) return kind as DerivativeInstrumentKind;
  }
  if (trId === KIS_DERIVATIVE_TR_IDS.realtime.night.INDEX_FUTURE) return "INDEX_FUTURE";
  if (trId === KIS_DERIVATIVE_TR_IDS.realtime.night.INDEX_OPTION) return "INDEX_OPTION";
  return undefined;
}

function tradeLayout(trId: string): { width: number; priceIndex: number } {
  if (trId === KIS_DERIVATIVE_TR_IDS.realtime.day.INDEX_FUTURE ||
      trId === KIS_DERIVATIVE_TR_IDS.realtime.day.COMMODITY_FUTURE) {
    return { width: 50, priceIndex: 5 };
  }
  if (trId === KIS_DERIVATIVE_TR_IDS.realtime.night.INDEX_FUTURE ||
      trId === KIS_DERIVATIVE_TR_IDS.realtime.day.STOCK_FUTURE) {
    return { width: 49, priceIndex: trId === KIS_DERIVATIVE_TR_IDS.realtime.day.STOCK_FUTURE ? 2 : 5 };
  }
  if (trId === KIS_DERIVATIVE_TR_IDS.realtime.day.INDEX_OPTION) return { width: 58, priceIndex: 2 };
  if (trId === KIS_DERIVATIVE_TR_IDS.realtime.night.INDEX_OPTION) return { width: 56, priceIndex: 2 };
  if (trId === KIS_DERIVATIVE_TR_IDS.realtime.day.STOCK_OPTION) return { width: 53, priceIndex: 2 };
  throw new Error(`Unsupported KIS derivative quote TR ${trId}`);
}

function sessionForTrId(trId: string): DerivativeSession {
  return trId === KIS_DERIVATIVE_TR_IDS.realtime.night.INDEX_FUTURE ||
    trId === KIS_DERIVATIVE_TR_IDS.realtime.night.INDEX_OPTION ||
    trId === KIS_DERIVATIVE_TR_IDS.realtime.notice.nightFuture ||
    trId === KIS_DERIVATIVE_TR_IDS.realtime.notice.nightOption
    ? "NIGHT"
    : "DAY";
}

function noticeTrIds(environment: "live" | "paper"): readonly string[] {
  const notices = KIS_DERIVATIVE_TR_IDS.realtime.notice;
  return environment === "paper"
    ? [notices.paperDay]
    : [notices.day, notices.nightFuture, notices.nightOption];
}

function side(value: string): "BUY" | "SELL" {
  const normalized = value.trim().toUpperCase();
  if (["02", "2", "BUY", "매수"].includes(normalized)) return "BUY";
  if (["01", "1", "SELL", "매도"].includes(normalized)) return "SELL";
  throw new Error("KIS derivative notice returned an unknown side");
}

function isNoticeTrId(trId: string): boolean {
  const notices = KIS_DERIVATIVE_TR_IDS.realtime.notice;
  return trId === notices.day || trId === notices.paperDay ||
    trId === notices.nightFuture || trId === notices.nightOption;
}

function noticeColumns(trId: string): readonly string[] {
  if (!isNoticeTrId(trId)) throw new Error(`Unsupported KIS derivative notice TR ${trId}`);
  return sessionForTrId(trId) === "DAY" ? DAY_NOTICE_COLUMNS : NIGHT_NOTICE_COLUMNS;
}

export function parseDerivativeTradeFields(
  trId: string,
  fields: string[],
  receivedAt = new Date().toISOString(),
): DerivativeQuote {
  const instrumentKind = kindForTrId(trId);
  if (instrumentKind === undefined) throw new Error(`Unsupported KIS derivative quote TR ${trId}`);
  const layout = tradeLayout(trId);
  if (fields.length < layout.width) throw new Error(`KIS derivative quote ${trId} is truncated`);
  const symbol = stringValue(fields[0]).toUpperCase();
  const price = numericValue(fields[layout.priceIndex]);
  if (!/^[0-9A-Z]{6,12}$/.test(symbol) || price === undefined || price <= 0) {
    throw new Error(`KIS derivative quote ${trId} omitted symbol or price`);
  }
  const quote: DerivativeQuote = {
    symbol,
    instrumentKind,
    session: sessionForTrId(trId),
    price,
    tradingTime: stringValue(fields[1]),
    receivedAt,
  };
  const open = numericValue(fields[6]);
  const high = numericValue(fields[7]);
  const low = numericValue(fields[8]);
  const volume = numericValue(fields[10]);
  if (open !== undefined) quote.open = open;
  if (high !== undefined) quote.high = high;
  if (low !== undefined) quote.low = low;
  if (volume !== undefined) quote.cumulativeVolume = volume;
  return quote;
}

export function parseDerivativeNoticeFields(
  trId: string,
  fields: string[],
  receivedAt = new Date().toISOString(),
): { order: DerivativeOrder; execution?: DerivativeExecution } {
  const session = sessionForTrId(trId);
  const columns = noticeColumns(trId);
  if (fields.length < columns.length) throw new Error(`KIS derivative notice ${trId} is truncated`);
  const values = Object.fromEntries(columns.map((key, index) => [key, fields[index] ?? ""]));
  const brokerOrderId = stringValue(values.orderNumber);
  const symbol = stringValue(values.symbol).toUpperCase();
  const orderKind = stringValue(values.orderKind).toUpperCase();
  if (orderKind !== "0" && orderKind !== "L") {
    throw new Error(`KIS derivative notice ${trId} returned an unknown order-kind discriminator`);
  }
  // KIS reuses CNTG_QTY/CNTG_UNPR contextually.  In a fill notice
  // (ODER_KIND2=0) they are execution values.  In an L notice they are the
  // accepted/revised/cancelled order values, while ODER_QTY carries the
  // already-filled quantity.  Treating every positive CNTG_QTY as a fill
  // creates phantom executions for ordinary limit-order acknowledgements.
  const isFill = orderKind === "0";
  const primaryQuantity = numericValue(values.fillQuantity);
  const secondaryQuantity = numericValue(values.orderQuantity);
  const requestedQuantity = isFill ? secondaryQuantity : primaryQuantity;
  const fillQuantity = isFill ? primaryQuantity : secondaryQuantity ?? 0;
  const fillPrice = numericValue(values.fillPrice);
  if (brokerOrderId === "" || !/^[0-9A-Z]{6,12}$/.test(symbol) ||
      requestedQuantity === undefined || requestedQuantity < 0 ||
      fillQuantity === undefined || fillQuantity < 0) {
    throw new Error(`KIS derivative notice ${trId} omitted required order fields`);
  }
  if (isFill && (requestedQuantity <= 0 || fillQuantity <= 0 || fillPrice === undefined || fillPrice <= 0)) {
    throw new Error(`KIS derivative fill notice ${trId} omitted execution quantity or price`);
  }
  const rejected = ["1", "Y"].includes(stringValue(values.refused).toUpperCase());
  const canceled = ["2", "02"].includes(stringValue(values.correctionType).toUpperCase());
  const remainingQuantity = canceled && !rejected ? 0 : Math.max(0, requestedQuantity - fillQuantity);
  const order: DerivativeOrder = {
    brokerOrderId,
    symbol,
    side: side(stringValue(values.side)),
    requestedQuantity,
    filledQuantity: fillQuantity,
    remainingQuantity,
    status: rejected
      ? "REJECTED"
      : canceled
        ? "CANCELED"
        : isFill && fillQuantity >= requestedQuantity
          ? "FILLED"
          : isFill
            ? "PARTIALLY_FILLED"
            : "OPEN",
    session,
    raw: values,
  };
  const original = stringValue(values.originalOrderNumber);
  if (original !== "") order.originalBrokerOrderId = original;
  const orderPrice = numericValue(values.orderPrice) ?? (isFill ? undefined : fillPrice);
  if (orderPrice !== undefined) order.orderPrice = orderPrice;
  if (isFill && fillPrice !== undefined) order.averageFillPrice = fillPrice;
  const time = stringValue(values.time);
  if (/^\d{6}$/.test(time)) {
    const date = yyyymmdd(new Date(receivedAt));
    order.orderedAt = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T${time.slice(0, 2)}:${time.slice(2, 4)}:${time.slice(4, 6)}+09:00`;
  }
  if (!isFill) return { order };
  return {
    order,
    execution: {
      brokerOrderId,
      executionId: `${brokerOrderId}:${time}:${fillQuantity}:${fillPrice}`,
      symbol,
      side: order.side,
      quantity: fillQuantity,
      price: fillPrice as number,
      executedAt: order.orderedAt,
      session,
      raw: values,
    },
  };
}

export class KisDerivativeWebSocketClient {
  readonly #options: KisDerivativeWebSocketOptions;
  readonly #desired = new Map<string, DerivativeQuoteSubscription>();
  readonly #activeQuotes = new Map<string, DerivativeQuoteSubscription>();
  readonly #encryption = new Map<string, EncryptionMaterial>();
  readonly #activeAccountNotices = new Set<string>();
  readonly #subscriptionWaiters = new Map<string, SubscriptionWaiter>();
  #socket?: WebSocket;
  #approvalKey = "";
  #running = false;
  #connecting?: Promise<void>;
  #operationTail: Promise<void> = Promise.resolve();
  #reconnectTimer?: ReturnType<typeof setTimeout>;
  #reconnectAttempt = 0;

  constructor(options: KisDerivativeWebSocketOptions) {
    this.#options = options;
  }

  async start(): Promise<void> {
    this.#running = true;
    await this.#connect();
  }

  async stop(): Promise<void> {
    this.#running = false;
    if (this.#reconnectTimer !== undefined) clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = undefined;
    this.#encryption.clear();
    this.#activeAccountNotices.clear();
    this.#activeQuotes.clear();
    this.#rejectSubscriptionWaiters(new Error("KIS derivative websocket stopped before subscription acknowledgement"));
    const socket = this.#socket;
    this.#socket = undefined;
    if (socket !== undefined && socket.readyState < WebSocket.CLOSING) socket.close(1000, "client disconnect");
    this.#emit({ type: "connection", connected: false, accountNoticesConnected: false, at: new Date().toISOString() });
  }

  async replaceQuoteSubscriptions(subscriptions: DerivativeQuoteSubscription[]): Promise<void> {
    if (this.#options.environment === "paper" && subscriptions.length > 0) {
      throw new BrokerRejectedError(
        "KIS official examples mark domestic derivative realtime quotes as live-only",
        "KIS_DERIVATIVE_PAPER_REALTIME_UNSUPPORTED",
      );
    }
    const next = new Map<string, DerivativeQuoteSubscription>();
    for (const item of subscriptions) {
      const normalized = { ...item, symbol: item.symbol.trim().toUpperCase() };
      const trId = trIdFor(normalized);
      next.set(`${trId}:${normalized.symbol}`, normalized);
    }
    this.#desired.clear();
    for (const [key, item] of next) this.#desired.set(key, item);
    const socket = this.#socket;
    if (socket === undefined || socket.readyState !== WebSocket.OPEN) return;
    await this.#queueOperation(async () => {
      try {
        for (const [key, current] of this.#activeQuotes) {
          if (next.has(key)) continue;
          await this.#send(this.#options.unsubscribeTrType, trIdFor(current), current.symbol);
          this.#activeQuotes.delete(key);
        }
        for (const [key, current] of next) {
          if (!this.#desired.has(key) || this.#activeQuotes.has(key)) continue;
          await this.#send("1", trIdFor(current), current.symbol);
          this.#activeQuotes.set(key, current);
        }
      } catch (error) {
        if (this.#socket === socket && socket.readyState < WebSocket.CLOSING) {
          socket.close(1011, "subscription update failed");
        }
        throw error;
      }
    });
  }

  async #connect(): Promise<void> {
    if (!this.#running || this.#socket?.readyState === WebSocket.OPEN) return;
    if (this.#connecting !== undefined) return this.#connecting;
    this.#connecting = this.#open();
    try {
      await this.#connecting;
    } finally {
      this.#connecting = undefined;
    }
  }

  async #open(): Promise<void> {
    this.#approvalKey = await this.#options.approvalKey();
    if (!this.#running) return;
    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(KIS_ENDPOINTS[this.#options.environment].webSocket);
      this.#socket = socket;
      let opened = false;
      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        socket.terminate();
        reject(new Error("KIS derivative websocket did not become subscription-ready before timeout"));
      }, CONNECTION_READY_TIMEOUT_MS);
      socket.once("open", () => {
        if (!this.#running || this.#socket !== socket) {
          socket.close(1000, "client stopped");
          return;
        }
        opened = true;
        this.#activeAccountNotices.clear();
        this.#activeQuotes.clear();
        this.#encryption.clear();
        this.#rejectSubscriptionWaiters(new Error("KIS derivative websocket disconnected before subscription acknowledgement"));
        this.#queueOperation(() => this.#restore())
          .then(() => {
            this.#reconnectAttempt = 0;
            this.#emit({
              type: "connection",
              connected: true,
              accountNoticesConnected: this.#accountNoticesConnected(),
              at: new Date().toISOString(),
            });
            if (!settled) {
              settled = true;
              clearTimeout(timeout);
              resolve();
            }
          })
          .catch((error: unknown) => {
            if (!settled) {
              settled = true;
              clearTimeout(timeout);
              reject(error);
            }
            if (this.#socket === socket && socket.readyState < WebSocket.CLOSING) {
              socket.close(1011, "subscription restore failed");
            }
          });
      });
      socket.on("message", (data) => {
        try {
          this.#handle(toBuffer(data));
        } catch (error) {
          this.#emit({ type: "error", message: error instanceof Error ? error.message : "KIS derivative websocket frame failed", code: "KIS_DERIVATIVE_WS_FRAME", at: new Date().toISOString() });
        }
      });
      socket.on("error", (error) => this.#emit({ type: "error", message: error.message, code: "KIS_DERIVATIVE_WS_TRANSPORT", at: new Date().toISOString() }));
      socket.once("close", () => {
        if (this.#socket !== socket) return;
        this.#socket = undefined;
        this.#encryption.clear();
        this.#activeAccountNotices.clear();
        this.#activeQuotes.clear();
        this.#rejectSubscriptionWaiters(new Error("KIS derivative websocket closed before subscription acknowledgement"));
        this.#emit({ type: "connection", connected: false, accountNoticesConnected: false, at: new Date().toISOString() });
        if (!opened && !settled) {
          settled = true;
          clearTimeout(timeout);
          reject(new Error("KIS derivative websocket closed before opening"));
        }
        this.#scheduleReconnect();
      });
    });
  }

  async #restore(): Promise<void> {
    if (this.#options.htsId !== undefined) {
      for (const trId of noticeTrIds(this.#options.environment)) {
        await this.#send("1", trId, this.#options.htsId);
        this.#activeAccountNotices.add(trId);
      }
    }
    for (const [key, item] of this.#desired) {
      await this.#send("1", trIdFor(item), item.symbol);
      this.#activeQuotes.set(key, item);
    }
  }

  async #send(trType: string, trId: string, trKey: string): Promise<void> {
    const socket = this.#socket;
    if (socket === undefined || socket.readyState !== WebSocket.OPEN) throw new Error("KIS derivative websocket is disconnected");
    const waiterKey = this.#subscriptionKey(trId, trKey);
    if (this.#subscriptionWaiters.has(waiterKey)) {
      throw new Error(`KIS derivative websocket subscription is already pending for ${trId}`);
    }
    const acknowledgement = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#subscriptionWaiters.delete(waiterKey);
        reject(new Error(`KIS derivative websocket subscription acknowledgement timed out for ${trId}`));
      }, SUBSCRIPTION_ACK_TIMEOUT_MS);
      this.#subscriptionWaiters.set(waiterKey, { trId, trKey, resolve, reject, timer });
    });
    try {
      await new Promise<void>((resolve, reject) => socket.send(
        subscribeMessage(this.#approvalKey, trType, trId, trKey),
        (error) => error == null ? resolve() : reject(error),
      ));
      await acknowledgement;
    } catch (error) {
      const waiter = this.#subscriptionWaiters.get(waiterKey);
      if (waiter !== undefined) {
        clearTimeout(waiter.timer);
        this.#subscriptionWaiters.delete(waiterKey);
      }
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, SUBSCRIPTION_PACING_MS));
  }

  #handle(buffer: Buffer): void {
    const text = buffer.toString("utf8");
    if (!(text.startsWith("0|") || text.startsWith("1|"))) {
      const message = JSON.parse(text) as { header?: { tr_id?: string; tr_key?: string }; body?: { output?: { key?: string; iv?: string }; rt_cd?: string; msg1?: string; msg_cd?: string } };
      const trId = stringValue(message.header?.tr_id);
      if (trId === "PINGPONG") {
        this.#socket?.pong(buffer);
        return;
      }
      const key = stringValue(message.body?.output?.key);
      const iv = stringValue(message.body?.output?.iv);
      if (trId !== "" && key !== "" && iv !== "") this.#encryption.set(trId, { key, iv });
      if (message.body?.rt_cd !== undefined && message.body.rt_cd !== "0") {
        const error = new Error(stringValue(message.body.msg1) || "KIS derivative websocket subscription rejected");
        this.#settleSubscriptionWaiter(trId, stringValue(message.header?.tr_key), error);
        this.#emit({ type: "error", message: error.message, code: stringValue(message.body.msg_cd), at: new Date().toISOString() });
      } else if (message.body?.rt_cd === "0") {
        this.#settleSubscriptionWaiter(trId, stringValue(message.header?.tr_key));
      }
      return;
    }
    const parts = text.split("|");
    const encrypted = parts[0] === "1";
    const trId = parts[1] ?? "";
    const count = Math.max(1, Number.parseInt(parts[2] ?? "1", 10) || 1);
    let payload = parts.slice(3).join("|");
    if (encrypted) {
      const material = this.#encryption.get(trId);
      if (material === undefined) throw new Error(`Missing KIS derivative websocket AES material for ${trId}`);
      payload = decrypt(payload, material);
    }
    const kind = kindForTrId(trId);
    if (kind !== undefined) {
      const layout = tradeLayout(trId);
      this.#forRecords(payload, count, layout.width, (fields) => this.#emit({ type: "quote", quote: parseDerivativeTradeFields(trId, fields) }));
      return;
    }
    if (isNoticeTrId(trId)) {
      const columns = noticeColumns(trId);
      this.#forRecords(payload, count, columns.length, (fields) => {
        const parsed = parseDerivativeNoticeFields(trId, fields);
        this.#emit({ type: "order", order: parsed.order });
        if (parsed.execution !== undefined) this.#emit({ type: "execution", execution: parsed.execution });
      });
    }
  }

  #forRecords(payload: string, count: number, width: number, callback: (fields: string[]) => void): void {
    const values = payload.trim().split("^");
    const available = Math.floor(values.length / width);
    for (let index = 0; index < Math.min(count, available); index += 1) callback(values.slice(index * width, (index + 1) * width));
  }

  #scheduleReconnect(): void {
    if (!this.#running || this.#reconnectTimer !== undefined) return;
    const wait = Math.min(30_000, 1_000 * 2 ** this.#reconnectAttempt) + Math.floor(Math.random() * 500);
    this.#reconnectAttempt += 1;
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = undefined;
      this.#connect().catch((error: unknown) => {
        this.#emit({ type: "error", message: error instanceof Error ? error.message : "KIS derivative websocket reconnect failed", code: "KIS_DERIVATIVE_WS_RECONNECT", at: new Date().toISOString() });
        this.#scheduleReconnect();
      });
    }, wait);
  }

  #queueOperation(operation: () => Promise<void>): Promise<void> {
    const run = this.#operationTail.then(operation);
    this.#operationTail = run.catch(() => undefined);
    return run;
  }

  #subscriptionKey(trId: string, trKey: string): string {
    return `${trId}:${trKey}`;
  }

  #settleSubscriptionWaiter(trId: string, trKey: string, error?: Error): void {
    let key = this.#subscriptionKey(trId, trKey);
    let waiter = this.#subscriptionWaiters.get(key);
    if (waiter === undefined) {
      const candidates = [...this.#subscriptionWaiters.entries()].filter(
        ([, candidate]) => candidate.trId === trId,
      );
      if (candidates.length === 1) [key, waiter] = candidates[0] as [string, SubscriptionWaiter];
    }
    if (waiter === undefined) return;
    clearTimeout(waiter.timer);
    this.#subscriptionWaiters.delete(key);
    if (error === undefined) waiter.resolve();
    else waiter.reject(error);
  }

  #rejectSubscriptionWaiters(error: Error): void {
    for (const [key, waiter] of this.#subscriptionWaiters) {
      clearTimeout(waiter.timer);
      this.#subscriptionWaiters.delete(key);
      waiter.reject(error);
    }
  }

  #accountNoticesConnected(): boolean {
    return this.#options.htsId !== undefined
      && this.#activeAccountNotices.size >= noticeTrIds(this.#options.environment).length;
  }

  #emit(event: KisDerivativeEvent): void {
    this.#options.onEvent(event);
  }
}
