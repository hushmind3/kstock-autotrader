import { createDecipheriv, randomUUID } from "node:crypto";
import type {
  BrokerExecution,
  BrokerOrder,
  Exchange,
  Quote,
} from "@kstock/shared";
import WebSocket, { type RawData } from "ws";
import {
  KIS_TR_IDS,
  KIS_REALTIME_TRADE_TR_ID,
  KIS_WS_SAFE_QUOTE_SUBSCRIPTION_SLOTS,
  KIS_WS_TOTAL_SUBSCRIPTION_SLOTS,
  type KisWebSocketUnsubscribeTrType,
} from "./constants.js";
import type { JsonRecord } from "./types.js";
import {
  asRecord,
  currentKisDateTime,
  domainTradingDate,
  delay,
  encodeBrokerOrderId,
  isoFromKis,
  numberValue,
  orderTypeFromKis,
  requireSymbol,
  sideFromKis,
  stringValue,
} from "./utils.js";

const QUOTE_FIELD_COUNT = 46;
const ACCOUNT_NOTICE_FIELD_COUNT = 26;
const SUBSCRIPTION_PACING_MS = 100;
const SUBSCRIPTION_ACK_TIMEOUT_MS = 10_000;
const CONNECTION_READY_TIMEOUT_MS = 45_000;

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

export interface KisWebSocketClientOptions {
  url: string;
  environment: "live" | "paper";
  quoteExchange?: Exchange;
  cano: string;
  htsId: string | undefined;
  unsubscribeTrType: KisWebSocketUnsubscribeTrType;
  approvalKey: () => Promise<string>;
  onQuote: (quote: Quote) => void;
  onOrder: (order: BrokerOrder) => void;
  onExecution: (execution: BrokerExecution) => void;
  onConnection: (connected: boolean, accountNoticesConnected: boolean) => void;
  onError: (message: string, code?: string) => void;
}

function rawDataToBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data as unknown as ArrayBuffer);
}

function decodeAesCbcBase64(
  ciphertext: string,
  material: EncryptionMaterial,
): string {
  const key = Buffer.from(material.key, "utf8");
  const iv = Buffer.from(material.iv, "utf8");
  if (key.length !== 32 || iv.length !== 16) {
    throw new Error("KIS websocket supplied invalid AES-256-CBC material");
  }
  const decipher = createDecipheriv("aes-256-cbc", key, iv);
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertext, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

function subscriptionMessage(
  approvalKey: string,
  trType: string,
  trId: string,
  trKey: string,
): string {
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

export function kisRefusalState(
  value: unknown,
): "approved" | "refused" | "unknown" {
  const normalized = stringValue(value).toUpperCase();
  if (normalized === "1" || normalized === "Y") return "refused";
  if (normalized === "0" || normalized === "N") return "approved";
  return "unknown";
}

/** The `ws` runtime follows Node callbacks and may report success as null. */
export function kisWebSocketSendSucceeded(error: Error | null | undefined): boolean {
  return error == null;
}

export class KisWebSocketClient {
  readonly #options: KisWebSocketClientOptions;
  readonly #quoteLimit: number;
  readonly #quoteExchange: Exchange;
  readonly #quoteTrId: (typeof KIS_REALTIME_TRADE_TR_ID)[Exchange];
  readonly #desiredQuotes = new Set<string>();
  readonly #activeQuotes = new Set<string>();
  readonly #encryptionByTr = new Map<string, EncryptionMaterial>();
  readonly #filledByOrder = new Map<string, number>();
  readonly #subscriptionWaiters = new Map<string, SubscriptionWaiter>();
  readonly #executionSessionId = randomUUID();
  #socket?: WebSocket;
  #approvalKey = "";
  #running = false;
  #connecting?: Promise<void>;
  #operationTail: Promise<void> = Promise.resolve();
  #reconnectTimer?: ReturnType<typeof setTimeout>;
  #reconnectAttempt = 0;
  #accountSubscriptionActive = false;
  #fillTrackingDate = "";
  #executionSequence = 0;

  constructor(options: KisWebSocketClientOptions) {
    this.#options = options;
    this.#quoteExchange = options.quoteExchange ?? "KRX";
    this.#quoteTrId = KIS_REALTIME_TRADE_TR_ID[this.#quoteExchange];
    this.#quoteLimit = Math.min(
      KIS_WS_SAFE_QUOTE_SUBSCRIPTION_SLOTS,
      KIS_WS_TOTAL_SUBSCRIPTION_SLOTS -
        (options.htsId === undefined ? 0 : 1),
    );
  }

  get quoteLimit(): number {
    return this.#quoteLimit;
  }

  get quoteSubscriptionCount(): number {
    return this.#desiredQuotes.size;
  }

  async start(): Promise<void> {
    this.#running = true;
    await this.#ensureConnected();
  }

  async stop(): Promise<void> {
    this.#running = false;
    if (this.#reconnectTimer !== undefined) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = undefined;
    }
    const socket = this.#socket;
    this.#socket = undefined;
    this.#activeQuotes.clear();
    this.#accountSubscriptionActive = false;
    this.#encryptionByTr.clear();
    this.#rejectSubscriptionWaiters(new Error("KIS websocket stopped before subscription acknowledgement"));
    if (socket !== undefined && socket.readyState < WebSocket.CLOSING) {
      socket.close(1000, "client disconnect");
    }
    this.#options.onConnection(false, false);
  }

  async replaceQuoteSubscriptions(symbols: string[]): Promise<void> {
    const normalized = [...new Set(symbols.map(requireSymbol))].sort();
    if (normalized.length > this.#quoteLimit) {
      throw new RangeError(
        `KIS websocket permits ${this.#quoteLimit} quote subscriptions with the current account-notice configuration`,
      );
    }
    const next = new Set(normalized);
    const removals = [...this.#desiredQuotes].filter((symbol) => !next.has(symbol));
    const additions = normalized.filter((symbol) => !this.#desiredQuotes.has(symbol));
    this.#desiredQuotes.clear();
    for (const symbol of normalized) this.#desiredQuotes.add(symbol);

    if (!this.#isOpen()) return;
    await this.#queueOperation(async () => {
      for (const symbol of removals) {
        if (!this.#activeQuotes.has(symbol)) continue;
        await this.#sendSubscription(
          this.#options.unsubscribeTrType,
          this.#quoteTrId,
          symbol,
        );
        this.#activeQuotes.delete(symbol);
      }
      for (const symbol of additions) {
        if (!this.#desiredQuotes.has(symbol) || this.#activeQuotes.has(symbol)) continue;
        await this.#sendSubscription("1", this.#quoteTrId, symbol);
        this.#activeQuotes.add(symbol);
      }
    });
  }

  #queueOperation(operation: () => Promise<void>): Promise<void> {
    const run = this.#operationTail.then(operation);
    this.#operationTail = run.catch(() => undefined);
    return run;
  }

  #isOpen(): boolean {
    return this.#socket?.readyState === WebSocket.OPEN;
  }

  async #ensureConnected(): Promise<void> {
    if (!this.#running || this.#isOpen()) return;
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
    await new Promise<void>((resolve, reject) => {
      if (!this.#running) {
        resolve();
        return;
      }
      const socket = new WebSocket(this.#options.url);
      this.#socket = socket;
      let opened = false;
      let settled = false;
      const readyTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error("KIS websocket did not become subscription-ready before timeout"));
        socket.terminate();
      }, CONNECTION_READY_TIMEOUT_MS);

      socket.on("message", (data) => {
        this.#handleMessage(rawDataToBuffer(data)).catch((error: unknown) => {
          this.#options.onError(
            error instanceof Error ? error.message : "KIS websocket message failed",
            "KIS_WS_MESSAGE",
          );
        });
      });
      socket.once("open", () => {
        opened = true;
        this.#activeQuotes.clear();
        this.#accountSubscriptionActive = false;
        this.#encryptionByTr.clear();
        this.#rejectSubscriptionWaiters(new Error("KIS websocket disconnected before subscription acknowledgement"));
        this.#queueOperation(() => this.#restoreSubscriptions())
          .then(() => {
            // A TCP/WebSocket handshake alone is not a successful recovery.
            // Reset the exponential backoff only after KIS acknowledges every
            // required subscription; otherwise a rejected subscription would
            // reconnect and write an error roughly once per second forever.
            this.#reconnectAttempt = 0;
            this.#options.onConnection(true, this.#accountSubscriptionActive);
            settled = true;
            clearTimeout(readyTimer);
            resolve();
          })
          .catch((error: unknown) => {
            if (!settled) {
              settled = true;
              clearTimeout(readyTimer);
              reject(error);
            }
            socket.close(1011, "subscription restore failed");
          });
      });
      socket.on("error", (error) => {
        this.#options.onError(error.message, "KIS_WS_TRANSPORT");
      });
      socket.once("close", (code) => {
        if (this.#socket === socket) this.#socket = undefined;
        this.#activeQuotes.clear();
        this.#accountSubscriptionActive = false;
        this.#encryptionByTr.clear();
        this.#options.onConnection(false, false);
        if (!opened && !settled) {
          settled = true;
          clearTimeout(readyTimer);
          reject(new Error(`KIS websocket closed before opening (${code})`));
        }
        this.#scheduleReconnect();
      });
    });
  }

  #scheduleReconnect(): void {
    if (!this.#running || this.#reconnectTimer !== undefined) return;
    const base = Math.min(30_000, 1_000 * 2 ** this.#reconnectAttempt);
    this.#reconnectAttempt += 1;
    const wait = base + Math.floor(Math.random() * Math.min(1_000, base / 4));
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = undefined;
      this.#ensureConnected().catch((error: unknown) => {
        this.#options.onError(
          error instanceof Error ? error.message : "KIS websocket reconnect failed",
          "KIS_WS_RECONNECT",
        );
        this.#scheduleReconnect();
      });
    }, wait);
  }

  async #restoreSubscriptions(): Promise<void> {
    if (this.#options.htsId !== undefined) {
      await this.#sendSubscription(
        "1",
        KIS_TR_IDS[this.#options.environment].accountNotice,
        this.#options.htsId,
      );
      this.#accountSubscriptionActive = true;
    }
    for (const symbol of this.#desiredQuotes) {
      await this.#sendSubscription("1", this.#quoteTrId, symbol);
      this.#activeQuotes.add(symbol);
    }
  }

  async #sendSubscription(trType: string, trId: string, trKey: string): Promise<void> {
    const socket = this.#socket;
    if (socket === undefined || socket.readyState !== WebSocket.OPEN) {
      throw new Error("KIS websocket is not connected");
    }
    const key = this.#subscriptionKey(trId, trKey);
    if (this.#subscriptionWaiters.has(key)) {
      throw new Error(`KIS websocket subscription is already pending for ${trId}:${trKey}`);
    }
    const acknowledgement = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#subscriptionWaiters.delete(key);
        reject(new Error(`KIS websocket subscription acknowledgement timed out for ${trId}`));
      }, SUBSCRIPTION_ACK_TIMEOUT_MS);
      this.#subscriptionWaiters.set(key, { trId, trKey, resolve, reject, timer });
    });
    try {
      await new Promise<void>((resolve, reject) => {
        socket.send(
          subscriptionMessage(this.#approvalKey, trType, trId, trKey),
          (error) => (kisWebSocketSendSucceeded(error) ? resolve() : reject(error)),
        );
      });
      await acknowledgement;
    } catch (error) {
      const waiter = this.#subscriptionWaiters.get(key);
      if (waiter !== undefined) {
        clearTimeout(waiter.timer);
        this.#subscriptionWaiters.delete(key);
      }
      throw error;
    }
    await delay(SUBSCRIPTION_PACING_MS);
  }

  async #handleMessage(buffer: Buffer): Promise<void> {
    const text = buffer.toString("utf8");
    if (text.startsWith("0|") || text.startsWith("1|")) {
      this.#handleDataFrame(text);
      return;
    }
    let message: JsonRecord;
    try {
      message = asRecord(JSON.parse(text));
    } catch {
      throw new Error("KIS websocket returned an unknown frame");
    }
    const header = asRecord(message.header);
    const trId = stringValue(header.tr_id);
    if (trId === "PINGPONG") {
      const socket = this.#socket;
      if (socket !== undefined && socket.readyState === WebSocket.OPEN) {
        socket.pong(buffer);
      }
      return;
    }

    const body = asRecord(message.body);
    const output = asRecord(body.output);
    const key = stringValue(output.key);
    const iv = stringValue(output.iv);
    if (trId !== "" && key !== "" && iv !== "") {
      this.#encryptionByTr.set(trId, { key, iv });
    }
    const rtCode = stringValue(body.rt_cd);
    if (rtCode !== "" && rtCode !== "0") {
      const error = new Error(stringValue(body.msg1) || "KIS websocket subscription was rejected");
      this.#settleSubscriptionWaiter(trId, stringValue(header.tr_key), error);
      this.#options.onError(error.message, stringValue(body.msg_cd) || "KIS_WS_REJECTED");
      return;
    }
    if (rtCode === "0") this.#settleSubscriptionWaiter(trId, stringValue(header.tr_key));
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
      if (candidates.length === 1) {
        [key, waiter] = candidates[0] as [string, SubscriptionWaiter];
      }
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

  #handleDataFrame(frame: string): void {
    const parts = frame.split("|");
    if (parts.length < 4) throw new Error("Malformed KIS websocket data frame");
    const encrypted = parts[0] === "1";
    const trId = parts[1] ?? "";
    const count = Math.max(1, Number.parseInt(parts[2] ?? "1", 10) || 1);
    let payload = parts.slice(3).join("|");
    if (encrypted) {
      const material = this.#encryptionByTr.get(trId);
      if (material === undefined) {
        throw new Error(`Missing KIS websocket decryption material for ${trId}`);
      }
      payload = decodeAesCbcBase64(payload, material);
    }

    if (trId === this.#quoteTrId) {
      this.#forEachRecord(payload, count, QUOTE_FIELD_COUNT, (fields) =>
        this.#handleQuote(fields),
      );
      return;
    }
    if (trId === KIS_TR_IDS[this.#options.environment].accountNotice) {
      this.#forEachRecord(payload, count, ACCOUNT_NOTICE_FIELD_COUNT, (fields) =>
        this.#handleAccountNotice(fields),
      );
    }
  }

  #forEachRecord(
    payload: string,
    declaredCount: number,
    fieldCount: number,
    callback: (fields: string[]) => void,
  ): void {
    const values = payload.trim().split("^");
    const availableCount = Math.floor(values.length / fieldCount);
    const count = Math.min(declaredCount, availableCount);
    for (let index = 0; index < count; index += 1) {
      callback(values.slice(index * fieldCount, (index + 1) * fieldCount));
    }
  }

  #handleQuote(fields: string[]): void {
    const symbol = stringValue(fields[0]).toUpperCase();
    const price = numberValue(fields[2]);
    if (!/^[0-9A-Z]{6}$/.test(symbol) || price <= 0) return;
    const receivedAt = new Date();
    const now = currentKisDateTime(receivedAt);
    const hasBrokerDate = /^\d{8}$/.test(fields[33] ?? "");
    const hasBrokerTime = /^\d{6}$/.test(fields[1] ?? "");
    const tradingDate = hasBrokerDate
      ? (fields[33] as string)
      : now.date;
    const tradingTime = hasBrokerTime
      ? (fields[1] as string)
      : now.time;
    this.#options.onQuote({
      symbol,
      price,
      open: numberValue(fields[7]),
      high: numberValue(fields[8]),
      low: numberValue(fields[9]),
      cumulativeVolume: numberValue(fields[13]),
      tradingDate: domainTradingDate(tradingDate),
      tradingTime,
      receivedAt: receivedAt.toISOString(),
      source: "koreainvestment",
      exchange: this.#quoteExchange,
      ...(hasBrokerDate && hasBrokerTime
        ? { brokerTimestampVerified: true }
        : { stale: true }),
    });
  }

  #handleAccountNotice(fields: string[]): void {
    const account = stringValue(fields[1]).replaceAll("-", "");
    if (account !== "" && !account.startsWith(this.#options.cano)) return;

    const branch = stringValue(fields[15]);
    const orderNumber = stringValue(fields[2]);
    if (orderNumber === "") return;
    const brokerOrderId = encodeBrokerOrderId(branch, orderNumber);
    const originalOrderNumber = stringValue(fields[3]);
    const originalBrokerOrderId =
      originalOrderNumber === "" || /^0+$/.test(originalOrderNumber)
        ? undefined
        : encodeBrokerOrderId(branch, originalOrderNumber);
    const symbol = stringValue(fields[8]).toUpperCase();
    if (!/^[0-9A-Z]{6}$/.test(symbol)) return;
    const side = sideFromKis(fields[4]);
    const orderQuantity = numberValue(fields[16]);
    const orderPrice = numberValue(fields[25]);
    const fillQuantity = numberValue(fields[9]);
    const fillPrice = numberValue(fields[10]);
    const eventTime = /^\d{6}$/.test(fields[11] ?? "")
      ? (fields[11] as string)
      : currentKisDateTime().time;
    const eventDate = currentKisDateTime().date;
    if (this.#fillTrackingDate !== eventDate) {
      this.#filledByOrder.clear();
      this.#fillTrackingDate = eventDate;
    }
    const fillMapKey = `${eventDate}:${brokerOrderId}`;
    const occurredAt = isoFromKis(eventDate, eventTime);
    const fillIndicator = stringValue(fields[13]);
    const refusalCode = stringValue(fields[12]).toUpperCase();
    const refusalState = kisRefusalState(refusalCode);
    const refused = refusalState === "refused";
    const approvalKnown = refusalState !== "unknown";
    const raw: JsonRecord = {
      orderNumber,
      originalOrderNumber,
      symbol,
      fillIndicator,
      refusalCode,
      refused,
      receiptClass: stringValue(fields[5]),
      orderKind: stringValue(fields[6]),
      acceptIndicator: stringValue(fields[14]),
      exchangeCode: stringValue(fields[19]),
    };

    if (fillIndicator === "2" && fillQuantity > 0 && fillPrice > 0) {
      const cumulative = (this.#filledByOrder.get(fillMapKey) ?? 0) + fillQuantity;
      this.#filledByOrder.set(fillMapKey, cumulative);
      const execution: BrokerExecution = {
        executionId: `${brokerOrderId}:${eventDate}:${eventTime}:${this.#executionSessionId}:${++this.#executionSequence}`,
        brokerOrderId,
        symbol,
        side,
        quantity: fillQuantity,
        price: fillPrice,
        executedAt: occurredAt,
        raw,
      };
      this.#options.onExecution(execution);
      const order: BrokerOrder = {
        brokerOrderId,
        symbol,
        side,
        orderType: orderTypeFromKis(fields[6], orderPrice),
        orderedQuantity: orderQuantity,
        filledQuantity: cumulative,
        remainingQuantity: Math.max(0, orderQuantity - cumulative),
        status:
          orderQuantity > 0 && cumulative >= orderQuantity
            ? "FILLED"
            : "PARTIALLY_FILLED",
        orderedAt: occurredAt,
        raw,
      };
      if (originalBrokerOrderId !== undefined) {
        order.originalBrokerOrderId = originalBrokerOrderId;
      }
      if (order.orderType === "limit") order.limitPrice = orderPrice;
      this.#options.onOrder(order);
      return;
    }

    const order: BrokerOrder = {
      brokerOrderId,
      symbol,
      side,
      orderType: orderTypeFromKis(fields[6], orderPrice),
      orderedQuantity: orderQuantity,
      filledQuantity: this.#filledByOrder.get(fillMapKey) ?? 0,
      remainingQuantity: Math.max(
        0,
        orderQuantity - (this.#filledByOrder.get(fillMapKey) ?? 0),
      ),
      status: refused
        ? "REJECTED"
        : !approvalKnown
          ? "UNKNOWN"
          : originalBrokerOrderId === undefined
            ? "ACKED"
            : "UNKNOWN",
      orderedAt: occurredAt,
      raw,
    };
    if (originalBrokerOrderId !== undefined) {
      order.originalBrokerOrderId = originalBrokerOrderId;
    }
    if (order.orderType === "limit") order.limitPrice = orderPrice;
    this.#options.onOrder(order);
  }
}
