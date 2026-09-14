import {
  BrokerRejectedError,
  BrokerTransportError,
  type AccountScope,
  type BrokerEvent,
  type BrokerMarketStatus,
  type BrokerOrder,
  type Exchange,
} from "@kstock/shared";
import WebSocket, { type RawData } from "ws";

import { KiwoomTokenManager } from "./auth.js";
import {
  KIWOOM_AUTH_RETRY_RETURN_CODES,
  KiwoomProtocolError,
} from "./errors.js";
import {
  asRecord,
  assertSymbol,
  brokerDateTimeToIso,
  brokerNumber,
  brokerPrice,
  domainTradingDate,
  exchangeFromKiwoomQuoteSymbol,
  kiwoomQuoteSymbol,
  kstNowParts,
  isSameKiwoomAccount,
  normalizeAccountId,
  normalizeSymbol,
  parseOrderSide,
  parseOrderStatus,
  parseOrderType,
  percentToBps,
  redactText,
  recordsAt,
  requiredBrokerNumber,
  requiredBrokerPrice,
  requiredString,
  stringAt,
  type UnknownRecord,
} from "./normalization.js";

const QUOTE_TYPE = "0B";
const ORDER_TYPE = "00";
const BALANCE_TYPE = "04";
const MARKET_STATUS_TYPE = "0s";
const ACCOUNT_GROUP = "1";
const QUOTE_GROUPS = ["2", "3"] as const;
const QUOTE_GROUP_SIZE = 100;
const MAX_QUOTE_SUBSCRIPTIONS = 200;
const LOGIN_ACK_TIMEOUT_MS = 20_000;
const CONTROL_ACK_TIMEOUT_MS = 10_000;

function optionalSafeIntegerPrice(value: unknown): number | undefined {
  const price = brokerPrice(value);
  return price !== undefined && Number.isSafeInteger(price) ? price : undefined;
}

function requiredSafeIntegerPrice(
  record: UnknownRecord,
  key: string,
  context: string,
): number {
  const price = requiredBrokerPrice(record, key, context);
  if (!Number.isSafeInteger(price)) {
    throw new KiwoomProtocolError(
      `Kiwoom ${context} must be a safe integer KRW price.`,
      "MALFORMED_RESPONSE",
    );
  }
  return price;
}

/**
 * Kiwoom 0s publishes KRX, NXT and derivatives operation codes on the same
 * stream. This engine trades the KRX regular session, so NXT/derivatives
 * transitions must not override the KRX clock. In particular, NXT code `R`
 * arrives around 09:00 and used to fall through to CLOSED after KRX code `3`.
 *
 * Official KRX-related 0s codes:
 * 0 pre-open, 3 regular open, 2 closing auction notice, 4/8 regular close,
 * 9 all markets close, a-d after-hours phases.
 */
export function parseKiwoomKrxMarketStatusCode(
  code: string,
): BrokerMarketStatus["state"] | null {
  switch (code) {
    case "0":
      return "PREOPEN";
    case "3":
    case "2":
      return "OPEN";
    case "4":
    case "8":
    case "a":
    case "b":
    case "c":
      return "AFTER_HOURS";
    case "9":
    case "d":
      return "CLOSED";
    default:
      return null;
  }
}

export interface KiwoomWebSocketStatus {
  connected: boolean;
  accountSubscribed: boolean;
  quoteSubscribed: boolean;
  lastError?: string;
}

export interface KiwoomWebSocketOptions {
  url: string;
  scope: AccountScope;
  quoteExchange?: Exchange;
  tokenManager: KiwoomTokenManager;
  onEvent: (event: BrokerEvent) => void;
  onStatus: (status: KiwoomWebSocketStatus) => void;
  webSocketFactory?: (url: string) => WebSocket;
}

interface LoginWaiter {
  resolve: () => void;
  reject: (error: Error) => void;
}

interface ControlWaiter extends LoginWaiter {
  transaction: "REG" | "REMOVE";
  timer: NodeJS.Timeout;
}

/** One Kiwoom WebSocket session carrying both market and account real-time types. */
export class KiwoomWebSocketClient {
  private socket: WebSocket | undefined;
  private desiredQuoteSymbols: string[] = [];
  private readonly registeredQuoteGroups = new Map<string, string[]>();
  private accountSubscribed = false;
  private loggedIn = false;
  private explicitlyClosed = true;
  private reconnectAttempt = 0;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private connectPromise: Promise<void> | undefined;
  private loginWaiter: LoginWaiter | undefined;
  private controlWaiter: ControlWaiter | undefined;
  private generation = 0;
  private subscriptionChain = Promise.resolve();
  private verifiedAccountId: string | undefined;
  private readonly quoteExchange: Exchange;

  constructor(private readonly options: KiwoomWebSocketOptions) {
    this.quoteExchange = options.quoteExchange ?? "KRX";
  }

  setVerifiedAccountId(accountId: string): void {
    if (!isSameKiwoomAccount(this.options.scope.accountId, accountId)) {
      throw new KiwoomProtocolError(
        "The verified Kiwoom account does not match the configured account.",
        "WS_ACCOUNT_SCOPE_MISMATCH",
      );
    }
    this.verifiedAccountId = normalizeAccountId(accountId);
  }

  async connect(): Promise<void> {
    this.explicitlyClosed = false;
    if (this.loggedIn && this.socket?.readyState === WebSocket.OPEN) return;
    if (this.connectPromise === undefined) {
      this.connectPromise = this.openWithAuthRecovery().finally(() => {
        this.connectPromise = undefined;
      });
    }
    return this.connectPromise;
  }

  async disconnect(): Promise<void> {
    this.explicitlyClosed = true;
    this.clearReconnectTimer();
    const socket = this.socket;
    this.socket = undefined;
    this.loggedIn = false;
    this.loginWaiter?.reject(
      new BrokerTransportError("Kiwoom WebSocket was closed.", "WS_CLOSED"),
    );
    this.loginWaiter = undefined;
    this.rejectControlWaiter(
      new BrokerTransportError("Kiwoom WebSocket was closed.", "WS_CLOSED"),
    );

    if (socket !== undefined && socket.readyState === WebSocket.OPEN) {
      try {
        await this.removeRegisteredQuoteGroups(socket);
        if (this.accountSubscribed) {
          await this.sendControlPacket(socket, {
            trnm: "REMOVE",
            grp_no: ACCOUNT_GROUP,
            data: [
              {
                item: [],
                type: [ORDER_TYPE, BALANCE_TYPE, MARKET_STATUS_TYPE],
              },
            ],
          });
          this.accountSubscribed = false;
        }
      } catch {
        // Best effort only during shutdown. Closing the socket is authoritative.
      }
      await closeSocket(socket);
    } else if (socket !== undefined && socket.readyState !== WebSocket.CLOSED) {
      socket.terminate();
    }

    this.generation += 1;
    this.registeredQuoteGroups.clear();
    this.accountSubscribed = false;
    this.emitStatus();
  }

  async replaceQuoteSubscriptions(symbols: string[]): Promise<void> {
    const normalized = [...new Set(symbols.map(assertSymbol))].sort();
    if (normalized.length > MAX_QUOTE_SUBSCRIPTIONS) {
      throw new KiwoomProtocolError(
        `Kiwoom permits at most ${MAX_QUOTE_SUBSCRIPTIONS} real-time symbols per access token/session.`,
        "WS_SUBSCRIPTION_LIMIT",
      );
    }
    this.desiredQuoteSymbols = normalized;
    this.subscriptionChain = this.subscriptionChain.catch(() => undefined).then(async () => {
      if (!this.loggedIn || this.socket?.readyState !== WebSocket.OPEN) return;
      await this.synchronizeQuoteGroups(this.socket);
    });
    return this.subscriptionChain;
  }

  private async openWithAuthRecovery(): Promise<void> {
    try {
      await this.openAndLogin();
    } catch (error) {
      if (
        !this.explicitlyClosed &&
        error instanceof BrokerRejectedError &&
        isAuthenticationExpiryCode(error.code)
      ) {
        await this.options.tokenManager.invalidate();
        await this.openAndLogin();
        return;
      }
      throw error;
    }
  }

  private async openAndLogin(): Promise<void> {
    const generation = ++this.generation;
    const token = await this.options.tokenManager.getAccessToken();
    const socket = this.options.webSocketFactory?.(this.options.url) ?? new WebSocket(this.options.url);
    this.socket = socket;
    this.loggedIn = false;
    this.accountSubscribed = false;
    this.registeredQuoteGroups.clear();

    const login = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.loginWaiter = undefined;
        reject(
          new BrokerTransportError(
            "Kiwoom WebSocket login acknowledgement timed out.",
            "WS_LOGIN_TIMEOUT",
          ),
        );
      }, LOGIN_ACK_TIMEOUT_MS);
      this.loginWaiter = {
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      };
    });

    socket.on("open", () => {
      if (generation !== this.generation) return;
      this.sendPacket(socket, { trnm: "LOGIN", token });
    });
    socket.on("message", (data) => {
      if (generation !== this.generation) return;
      this.handleMessage(socket, data);
    });
    socket.on("error", (error) => {
      if (generation !== this.generation) return;
      const safe = redactText(error.message, this.options.tokenManager.sensitiveValues);
      this.loginWaiter?.reject(
        new BrokerTransportError("Kiwoom WebSocket connection failed.", "WS_ERROR", {
          message: safe,
        }),
      );
      this.loginWaiter = undefined;
      this.emitStatus("Kiwoom WebSocket connection failed.");
    });
    socket.on("close", () => {
      if (generation !== this.generation) return;
      this.loggedIn = false;
      this.accountSubscribed = false;
      this.registeredQuoteGroups.clear();
      this.loginWaiter?.reject(
        new BrokerTransportError("Kiwoom WebSocket closed before login.", "WS_CLOSED"),
      );
      this.loginWaiter = undefined;
      this.rejectControlWaiter(
        new BrokerTransportError(
          "Kiwoom WebSocket disconnected before control acknowledgement.",
          "WS_CLOSED",
        ),
      );
      this.emitStatus("Kiwoom WebSocket disconnected.");
      if (!this.explicitlyClosed) this.scheduleReconnect();
    });

    try {
      await login;
      if (generation !== this.generation) {
        throw new BrokerTransportError("Kiwoom WebSocket connection was superseded.", "WS_SUPERSEDED");
      }
      this.reconnectAttempt = 0;
      this.subscriptionChain = this.subscriptionChain.catch(() => undefined).then(async () => {
        await this.registerAccountTypes(socket);
        await this.synchronizeQuoteGroups(socket);
      });
      await this.subscriptionChain;
      this.clearReconnectTimer();
      this.emitStatus();
    } catch (error) {
      if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
      if (!this.explicitlyClosed) this.scheduleReconnect();
      throw error;
    }
  }

  private handleMessage(socket: WebSocket, raw: RawData): void {
    const text = raw.toString();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      this.emitProtocolError("Kiwoom WebSocket sent malformed JSON.", "WS_MALFORMED_JSON");
      return;
    }
    const record = asRecord(parsed);
    if (record === undefined) {
      this.emitProtocolError("Kiwoom WebSocket sent a non-object message.", "WS_MALFORMED_MESSAGE");
      return;
    }
    const transaction = stringAt(record, "trnm");
    if (transaction === "PING") {
      // The official protocol requires returning the same PING packet.
      if (socket.readyState === WebSocket.OPEN) socket.send(text);
      return;
    }
    if (transaction === "LOGIN") {
      this.handleLogin(record);
      return;
    }
    if (transaction === "REAL") {
      this.handleReal(record);
      return;
    }
    if (transaction === "REG" || transaction === "REMOVE") {
      const code = brokerNumber(record.return_code);
      const waiter = this.controlWaiter;
      if (waiter === undefined || waiter.transaction !== transaction) return;
      clearTimeout(waiter.timer);
      this.controlWaiter = undefined;
      if (code === 0) {
        waiter.resolve();
        return;
      }
      const error = new BrokerRejectedError(
        redactText(
          stringAt(record, "return_msg") || "Kiwoom rejected a WebSocket subscription request.",
          this.options.tokenManager.sensitiveValues,
        ),
        code === undefined
          ? `WS_${transaction}_MALFORMED_ACK`
          : `WS_${transaction}_REJECTED_${code}`,
      );
      waiter.reject(error);
      this.emitProtocolError(error.message, error.code ?? `WS_${transaction}_REJECTED`);
    }
  }

  private handleLogin(record: UnknownRecord): void {
    const code = brokerNumber(record.return_code);
    if (code === 0) {
      this.loggedIn = true;
      this.loginWaiter?.resolve();
      this.loginWaiter = undefined;
      return;
    }
    const message = redactText(
      stringAt(record, "return_msg") || "Kiwoom rejected WebSocket login.",
      this.options.tokenManager.sensitiveValues,
    );
    this.loginWaiter?.reject(
      new BrokerRejectedError(message, code === undefined ? "WS_LOGIN_REJECTED" : String(code)),
    );
    this.loginWaiter = undefined;
  }

  private handleReal(record: UnknownRecord): void {
    for (const packet of recordsAt(record, "data")) {
      const realtimeType = stringAt(packet, "type");
      const values = asRecord(packet.values);
      if (realtimeType === undefined || values === undefined) continue;
      try {
        if (realtimeType === QUOTE_TYPE) this.emitQuote(packet, values);
        if (realtimeType === ORDER_TYPE) this.emitOrderAndExecution(values);
        if (realtimeType === BALANCE_TYPE) this.emitPosition(values);
        if (realtimeType === MARKET_STATUS_TYPE) this.emitMarketStatus(values);
      } catch (error) {
        this.emitProtocolError(
          error instanceof Error ? error.message : "Failed to normalize a Kiwoom real-time event.",
          "WS_EVENT_NORMALIZATION_ERROR",
        );
      }
    }
  }

  private emitQuote(packet: UnknownRecord, values: UnknownRecord): void {
    const receivedAt = new Date();
    const clock = kstNowParts(receivedAt);
    const rawSymbol = requiredString(packet, "item", "real-time symbol");
    const symbol = assertSymbol(rawSymbol);
    const rawTradingTime = stringAt(values, "20")?.replaceAll(":", "");
    const brokerTimeVerified = isValidTradingTime(rawTradingTime);
    const tradingTime = brokerTimeVerified ? rawTradingTime : clock.time;
    const price = requiredSafeIntegerPrice(values, "10", "real-time price");
    const open = optionalSafeIntegerPrice(values["16"]);
    const high = optionalSafeIntegerPrice(values["17"]);
    const low = optionalSafeIntegerPrice(values["18"]);
    const cumulativeVolume = Math.abs(
      requiredBrokerNumber(values, "13", "real-time cumulative volume"),
    );
    if (!Number.isSafeInteger(cumulativeVolume)) {
      throw new KiwoomProtocolError(
        "Kiwoom real-time cumulative volume must be a safe integer.",
        "MALFORMED_RESPONSE",
      );
    }
    const quote = {
      symbol,
      price,
      ...(open === undefined ? {} : { open }),
      ...(high === undefined ? {} : { high }),
      ...(low === undefined ? {} : { low }),
      cumulativeVolume,
      tradingDate: domainTradingDate(clock.date),
      tradingTime,
      receivedAt: receivedAt.toISOString(),
      source: "kiwoom" as const,
      exchange: exchangeFromKiwoomQuoteSymbol(rawSymbol, this.quoteExchange),
      // Kiwoom's equity WS supplies the broker trade time but not a separate
      // business-date field. Korean equity sessions do not cross midnight, so
      // pairing a valid broker time with the KST receive date is unambiguous.
      ...(brokerTimeVerified ? { brokerTimestampVerified: true } : { stale: true }),
    };
    this.options.onEvent({ type: "quote", quote });
  }

  private emitOrderAndExecution(values: UnknownRecord): void {
    if (!this.isVerifiedAccountEvent(values)) return;
    const receivedAt = new Date();
    const clock = kstNowParts(receivedAt);
    const brokerOrderId = requiredString(values, "9203", "order number");
    const symbol = assertSymbol(requiredString(values, "9001", "order symbol"));
    const description = stringAt(values, "905");
    const orderedQuantity = Math.abs(requiredBrokerNumber(values, "900", "order quantity"));
    const remainingQuantity = Math.abs(requiredBrokerNumber(values, "902", "remaining quantity"));
    const filledQuantity = Math.max(0, orderedQuantity - remainingQuantity);
    const limitPrice = brokerPrice(values["901"]);
    const order: BrokerOrder = {
      brokerOrderId,
      ...(stringAt(values, "904") ? { originalBrokerOrderId: stringAt(values, "904") } : {}),
      symbol,
      side: parseOrderSide(description),
      orderType: parseOrderType(description),
      orderedQuantity,
      filledQuantity,
      remainingQuantity,
      ...(limitPrice === undefined || limitPrice === 0 ? {} : { limitPrice }),
      status: parseOrderStatus(stringAt(values, "913"), remainingQuantity, filledQuantity, description),
      orderedAt: brokerDateTimeToIso(clock.date, stringAt(values, "908"), receivedAt),
    };
    this.options.onEvent({ type: "order", order });

    const executionNumber = stringAt(values, "909");
    const executionPrice = brokerPrice(values["910"]);
    const executionQuantity = brokerNumber(values["911"]);
    if (
      executionNumber !== undefined &&
      executionNumber !== "" &&
      executionPrice !== undefined &&
      executionQuantity !== undefined &&
      executionQuantity !== 0
    ) {
      this.options.onEvent({
        type: "execution",
        execution: {
          executionId: `${clock.date}:${executionNumber}`,
          brokerOrderId,
          symbol,
          side: order.side,
          quantity: Math.abs(executionQuantity),
          price: executionPrice,
          executedAt: brokerDateTimeToIso(clock.date, stringAt(values, "908"), receivedAt),
        },
      });
    }
  }

  private emitPosition(values: UnknownRecord): void {
    if (!this.isVerifiedAccountEvent(values)) return;
    const symbol = assertSymbol(requiredString(values, "9001", "balance symbol"));
    const quantity = Math.abs(requiredBrokerNumber(values, "930", "holding quantity"));
    const availableQuantity = Math.abs(
      requiredBrokerNumber(values, "933", "available holding quantity"),
    );
    const averagePrice = requiredBrokerPrice(values, "931", "average purchase price");
    const currentPrice = requiredBrokerPrice(values, "10", "balance current price");
    const derivedPnl = (currentPrice - averagePrice) * quantity;
    const reportedPnl = brokerNumber(values["950"]);
    this.options.onEvent({
      type: "position",
      position: {
        symbol,
        ...(stringAt(values, "302") ? { name: stringAt(values, "302") } : {}),
        quantity,
        availableQuantity,
        averagePrice,
        currentPrice,
        marketValue: currentPrice * quantity,
        unrealizedPnl: reportedPnl ?? derivedPnl,
        unrealizedPnlBps: percentToBps(values["8019"]),
      },
    });
  }

  private emitMarketStatus(values: UnknownRecord): void {
    const code = requiredString(values, "215", "market operation code");
    const state = parseKiwoomKrxMarketStatusCode(code);
    if (state === null) return;
    this.options.onEvent({
      type: "market-status",
      status: {
        state,
        code,
        observedAt: new Date().toISOString(),
      },
    });
  }

  private async registerAccountTypes(socket: WebSocket): Promise<void> {
    // Kiwoom's account real-time types are account-scoped rather than symbol-scoped.
    // The empty item is the documented registration sentinel; verify on both live
    // and paper credentials because paper availability may differ by account.
    await this.sendControlPacket(socket, {
      trnm: "REG",
      grp_no: ACCOUNT_GROUP,
      refresh: "1",
      data: [
        {
          item: [],
          type: [ORDER_TYPE, BALANCE_TYPE, MARKET_STATUS_TYPE],
        },
      ],
    });
    this.accountSubscribed = true;
  }

  private isVerifiedAccountEvent(values: UnknownRecord): boolean {
    const eventAccountId = stringAt(values, "9201");
    if (eventAccountId === undefined || eventAccountId === "") {
      this.emitProtocolError(
        "Kiwoom account real-time data omitted the account number.",
        "WS_ACCOUNT_MISSING",
      );
      return false;
    }
    if (this.verifiedAccountId === undefined) {
      this.emitProtocolError(
        "Kiwoom account real-time data arrived before account verification.",
        "WS_ACCOUNT_UNVERIFIED",
      );
      return false;
    }
    return isSameKiwoomAccount(this.verifiedAccountId, eventAccountId);
  }

  private async synchronizeQuoteGroups(socket: WebSocket): Promise<void> {
    await this.removeRegisteredQuoteGroups(socket);
    const chunks = chunk(this.desiredQuoteSymbols, QUOTE_GROUP_SIZE);
    for (let index = 0; index < chunks.length; index += 1) {
      const symbols = chunks[index]?.map((symbol) =>
        kiwoomQuoteSymbol(symbol, this.quoteExchange),
      );
      const group = QUOTE_GROUPS[index];
      if (symbols === undefined || group === undefined || symbols.length === 0) continue;
      await this.sendControlPacket(socket, {
        trnm: "REG",
        grp_no: group,
        refresh: "1",
        data: [{ item: symbols, type: [QUOTE_TYPE] }],
      });
      this.registeredQuoteGroups.set(group, symbols);
    }
    this.emitStatus();
  }

  private async removeRegisteredQuoteGroups(socket: WebSocket): Promise<void> {
    for (const [group, symbols] of this.registeredQuoteGroups) {
      await this.sendControlPacket(socket, {
        trnm: "REMOVE",
        grp_no: group,
        data: [{ item: symbols, type: [QUOTE_TYPE] }],
      });
    }
    this.registeredQuoteGroups.clear();
  }

  private sendPacket(socket: WebSocket, packet: UnknownRecord): void {
    if (socket.readyState !== WebSocket.OPEN) {
      throw new BrokerTransportError("Kiwoom WebSocket is not open.", "WS_NOT_OPEN");
    }
    socket.send(JSON.stringify(packet));
  }

  private async sendControlPacket(socket: WebSocket, packet: UnknownRecord): Promise<void> {
    const transaction = stringAt(packet, "trnm");
    if (transaction !== "REG" && transaction !== "REMOVE") {
      throw new KiwoomProtocolError(
        "Invalid Kiwoom WebSocket control packet.",
        "WS_CONTROL_PACKET",
      );
    }
    if (this.controlWaiter !== undefined) {
      throw new KiwoomProtocolError(
        "A Kiwoom WebSocket control acknowledgement is already pending.",
        "WS_CONTROL_CONCURRENCY",
      );
    }
    const acknowledgement = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.controlWaiter = undefined;
        reject(
          new BrokerTransportError(
            `Kiwoom ${transaction} acknowledgement timed out.`,
            "WS_CONTROL_TIMEOUT",
          ),
        );
      }, CONTROL_ACK_TIMEOUT_MS);
      this.controlWaiter = { transaction, resolve, reject, timer };
    });
    try {
      this.sendPacket(socket, packet);
      await acknowledgement;
    } catch (error) {
      this.rejectControlWaiter(
        error instanceof Error
          ? error
          : new BrokerTransportError("Kiwoom control request failed.", "WS_CONTROL_ERROR"),
      );
      throw error;
    }
  }

  private rejectControlWaiter(error: Error): void {
    const waiter = this.controlWaiter;
    if (waiter === undefined) return;
    clearTimeout(waiter.timer);
    this.controlWaiter = undefined;
    waiter.reject(error);
  }

  private scheduleReconnect(): void {
    if (this.explicitlyClosed || this.reconnectTimer !== undefined) return;
    const attempt = this.reconnectAttempt++;
    const ceiling = Math.min(30_000, 1_000 * 2 ** Math.min(attempt, 5));
    const delay = Math.max(250, Math.round(ceiling * (0.75 + Math.random() * 0.5)));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (this.explicitlyClosed) return;
      void this.connect().catch(() => {
        this.scheduleReconnect();
      });
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== undefined) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
  }

  private emitProtocolError(message: string, code: string): void {
    const safeMessage = redactText(message, this.options.tokenManager.sensitiveValues);
    this.options.onEvent({
      type: "error",
      error: { message: safeMessage, code, at: new Date().toISOString() },
    });
    this.emitStatus(safeMessage);
  }

  private emitStatus(lastError?: string): void {
    const connected = this.loggedIn && this.socket?.readyState === WebSocket.OPEN;
    this.options.onStatus({
      connected,
      accountSubscribed: connected && this.accountSubscribed,
      quoteSubscribed: connected &&
        (this.desiredQuoteSymbols.length === 0 || this.registeredQuoteGroups.size > 0),
      ...(lastError === undefined ? {} : { lastError }),
    });
  }
}

function isValidTradingTime(value: string | undefined): value is string {
  if (value === undefined || !/^\d{6}$/.test(value)) return false;
  const hours = Number(value.slice(0, 2));
  const minutes = Number(value.slice(2, 4));
  const seconds = Number(value.slice(4, 6));
  return hours <= 23 && minutes <= 59 && seconds <= 59;
}

function chunk<T>(values: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

function isAuthenticationExpiryCode(code: string | undefined): boolean {
  if (code === undefined) return false;
  const match = /(\d+)$/.exec(code);
  return match?.[1] !== undefined && KIWOOM_AUTH_RETRY_RETURN_CODES.has(Number(match[1]));
}

async function closeSocket(socket: WebSocket): Promise<void> {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      socket.terminate();
      resolve();
    }, 2_000);
    timer.unref?.();
    socket.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
    socket.close(1000, "client shutdown");
  });
}
