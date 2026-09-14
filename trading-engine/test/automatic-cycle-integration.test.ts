import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInMemoryTradingRepository, type TradingRepository } from "@kstock/database";
import {
  createDefaultSettings,
  type AccountSnapshot,
  type AppSettings,
  type BrokerAdapter,
  type BrokerEvent,
  type BrokerExecution,
  type BrokerOrder,
  type BrokerPosition,
  type DailyBar,
  type Instrument,
  type PlaceOrderRequest,
  type Quote,
} from "@kstock/shared";
import { TradingEngine, type CredentialStorePort } from "../src/core/trading-engine.js";
import { OrderDispatcher } from "../src/core/order-dispatcher.js";
import { PositionLifecycle } from "../src/core/position-lifecycle.js";
import { positionExitPolicyKey } from "../src/core/exit-policy.js";

const scope = { brokerId: "kiwoom", environment: "live", accountId: "memory-cycle-account" } as const;
const symbol = "005930";
const sessionStart = Date.parse("2026-09-10T01:00:00.000Z");
const instruments: Instrument[] = [symbol, ...Array.from({ length: 20 }, (_, index) => String(900_000 + index))]
  .map((code) => ({ symbol: code, name: `테스트 ${code}`, market: "KOSPI", exchange: "KRX", active: true }));

// This port never reads a file, keychain, environment credential, or real account.
const memoryCredentials: CredentialStorePort = {
  async save() {},
  async get(brokerId) {
    return brokerId === "kiwoom"
      ? { appKey: "memory-test-key", appSecret: "memory-test-secret", accountId: scope.accountId }
      : null;
  },
  async delete() { return false; },
  async status(brokerId) {
    return {
      configured: brokerId === "kiwoom",
      source: brokerId === "kiwoom" ? "encrypted-file" : null,
      maskedAccountId: brokerId === "kiwoom" ? "****test" : null,
    };
  },
  async saveDerivatives() {},
  async getDerivatives() { return null; },
  async deleteDerivatives() { return false; },
  async statusDerivatives() {
    return { configured: false, source: null, maskedAccountId: null, accountProductCode: "03" };
  },
};

function completedBars(code: string): DailyBar[] {
  // The held stock deliberately has insufficient entry-strategy history. Its
  // account exits must still work; other stocks establish a genuine weak gate.
  const count = code === symbol ? 2 : 70;
  const dates: string[] = [];
  let timestamp = Date.parse("2026-09-09T00:00:00.000Z");
  while (dates.length < count) {
    const date = new Date(timestamp);
    if (date.getUTCDay() !== 0 && date.getUTCDay() !== 6) dates.unshift(date.toISOString().slice(0, 10));
    timestamp -= 86_400_000;
  }
  return dates.map((tradingDate, index) => {
    const close = 20_000 - index * 100;
    return { symbol: code, tradingDate, open: close, high: close + 100, low: close - 100, close, volume: 100_000, adjusted: true };
  });
}

class MemoryCycleBroker implements BrokerAdapter {
  readonly scope = scope;
  readonly capabilities = {
    supportsLive: true,
    supportsPaper: true,
    supportsAmend: true,
    supportsCancel: true,
    maxQuoteSubscriptions: 100,
    quoteBatchSize: 100,
    queryRequestsPerSecond: 5,
    orderRequestsPerSecond: 5,
    clientOrderIdSupported: true,
  };
  readonly listeners = new Set<(event: BrokerEvent) => void>();
  readonly openOrders: BrokerOrder[] = [];
  readonly orderHistory: BrokerOrder[] = [];
  readonly executions: BrokerExecution[] = [];
  snapshotGate: Promise<void> | null = null;
  #orderSequence = 0;
  readonly position: BrokerPosition = {
    symbol,
    quantity: 10,
    availableQuantity: 10,
    averagePrice: 10_000,
    currentPrice: 10_000,
    marketValue: 100_000,
    unrealizedPnl: 0,
    unrealizedPnlBps: 0,
  };

  async connect() {}
  async disconnect() {}
  getHealth() {
    return {
      state: "CONNECTED" as const,
      restConnected: true,
      marketWebSocketConnected: true,
      accountWebSocketConnected: true,
      checkedAt: new Date().toISOString(),
    };
  }
  onEvent(listener: (event: BrokerEvent) => void) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  emitOrder(order: BrokerOrder) {
    for (const listener of this.listeners) listener({ type: "order", order });
  }
  emitQuote(price: number, extra: Partial<Quote> = {}) {
    const localTime = new Date(Date.now() + 9 * 3_600_000).toISOString();
    const quote: Quote = {
      symbol,
      price,
      cumulativeVolume: 100_000,
      tradingDate: localTime.slice(0, 10),
      tradingTime: localTime.slice(11, 19).replaceAll(":", ""),
      receivedAt: new Date().toISOString(),
      source: "kiwoom",
      exchange: "KRX",
      brokerTimestampVerified: true,
      ...extra,
    };
    for (const listener of this.listeners) listener({ type: "quote", quote });
  }
  async fetchInstruments() { return instruments; }
  async fetchDailyBars(code: string) { return completedBars(code); }
  async fetchQuote(): Promise<Quote> { throw new Error("Quotes in this test are emitted explicitly."); }
  async fetchQuotes() { return []; }
  async replaceQuoteSubscriptions() {}
  readonly placeOrder = vi.fn(async (request: PlaceOrderRequest) => {
    const brokerOrderId = `memory-order-${++this.#orderSequence}`;
    this.openOrders.push({
      brokerOrderId,
      symbol: request.symbol,
      side: request.side,
      orderType: request.orderType,
      orderedQuantity: request.quantity,
      filledQuantity: 0,
      remainingQuantity: request.quantity,
      status: "ACKED",
      orderedAt: new Date().toISOString(),
      exchange: request.exchange,
    });
    return { outcome: "ACCEPTED" as const, brokerOrderId };
  });
  async amendOrder() { return { outcome: "REJECTED" as const }; }
  async cancelOrder() { return { outcome: "REJECTED" as const }; }
  readonly fetchAccountSnapshot = vi.fn(async (): Promise<AccountSnapshot> => {
    await this.snapshotGate;
    return {
      scope,
      cash: 1_000_000,
      availableCash: 1_000_000,
      totalEvaluation: 1_100_000,
      realizedPnlToday: 0,
      unrealizedPnl: 0,
      positions: [structuredClone(this.position)],
      openOrders: structuredClone(this.openOrders),
      fetchedAt: new Date().toISOString(),
    };
  });
  async fetchOpenOrders() { return structuredClone(this.openOrders); }
  readonly fetchOrderHistory = vi.fn(async () => structuredClone(this.orderHistory));
  async fetchExecutions() { return structuredClone(this.executions); }
}

let engine: TradingEngine | null = null;
let repository: TradingRepository | null = null;

function createMemoryEngine(adapter: MemoryCycleBroker): TradingEngine {
  return new TradingEngine({
    repository: repository!,
    dataDirectory: path.join(tmpdir(), `kstock-automatic-cycle-${randomUUID()}`),
    credentialStore: memoryCredentials,
    brokerAdapterFactory: () => adapter,
    derivativeAdapterFactory: () => { throw new Error("Derivative adapters are not part of this test."); },
  });
}

async function startMemoryEngine(configure: (settings: AppSettings) => void) {
  repository = createInMemoryTradingRepository();
  repository.upsertInstruments(instruments);
  repository.upsertDailyBars(instruments.flatMap((instrument) => completedBars(instrument.symbol)), "kiwoom");
  const settings = createDefaultSettings();
  settings.emergencyHalt = false;
  settings.globalAutoTradingEnabled = true;
  settings.newBuysPaused = false;
  settings.scanIntervalMs = 1_000;
  settings.marketRegime.minimumSampleSize = 20;
  Object.assign(settings.brokers.kiwoom, {
    enabled: true,
    environment: "live",
    autoTradingEnabled: true,
    newBuysPaused: false,
    resumeAfterRestart: true,
  });
  configure(settings);
  repository.setAppSettings(settings);
  const adapter = new MemoryCycleBroker();
  engine = createMemoryEngine(adapter);
  await engine.start();
  await vi.waitFor(async () => {
    expect((await engine!.dashboard()).market.regime).toMatchObject({
      status: "WEAK", buyAllowed: false, reasonCode: "DAILY_BREADTH_WEAK", dailySampleCount: 20,
    });
  });
  return adapter;
}

beforeEach(() => {
  // Keep actual async timers, but make exchange hours and quote freshness deterministic.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(sessionStart);
});

afterEach(async () => {
  await engine?.stop();
  repository?.close();
  engine = null;
  repository = null;
  vi.useRealTimers();
});

describe("automatic account-exit integration", () => {
  it("contains a malformed realtime quote without crashing the engine", async () => {
    const adapter = await startMemoryEngine(() => undefined);

    adapter.emitQuote(10_000, { open: 10_000.25 });

    await vi.waitFor(() => {
      expect(repository!.listErrors({ scope, limit: 10 })).toEqual(expect.arrayContaining([
        expect.objectContaining({ message: expect.stringContaining("quote.open must be a safe integer") }),
      ]));
    });
    expect((await engine!.dashboard()).engine.state).toBe("RUNNING");
  });

  it("rechecks a conditional time exit after a profit recovery instead of reusing the old sell decision", async () => {
    const adapter = await startMemoryEngine((settings) => {
      Object.assign(settings.brokers.kiwoom.orderPolicy, { takeProfitEnabled: false, maxHoldingMinutes: 15,
        timedExitOnlyWithoutNetProfit: true, estimatedRoundTripCostBps: 30 });
    });
    const lifecycle = new PositionLifecycle(repository!);
    lifecycle.rememberExit(scope, symbol, { action: "SELL", reasonCodes: ["MAX_HOLDING_TIME_REACHED"], metrics: {} },
      positionExitPolicyKey(engine!.settings.brokers.kiwoom.orderPolicy));
    vi.setSystemTime(sessionStart + 16 * 60000);
    adapter.emitQuote(10500);
    await setImmediate();
    await setImmediate();
    expect(lifecycle.get(scope, symbol)?.exitDecision).toBeNull();
    expect(adapter.placeOrder).not.toHaveBeenCalled();
    vi.setSystemTime(sessionStart + 16 * 60000 + 5000);
    adapter.emitQuote(10020);
    await vi.waitFor(() => expect(adapter.placeOrder).toHaveBeenCalledOnce());
  });
  it("submits a stop-loss sell from a fresh quote despite a weak market buy gate and missing strategy history", async () => {
    const adapter = await startMemoryEngine((settings) => {
      settings.brokers.kiwoom.orderPolicy.stopLossEnabled = true;
      settings.brokers.kiwoom.orderPolicy.stopLossBps = 300;
    });

    adapter.emitQuote(9_600);

    await vi.waitFor(() => expect(adapter.placeOrder).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      symbol, side: "sell", quantity: 10, orderType: "market", exchange: "KRX",
    })));
    expect(repository!.listOrders(scope)).toEqual([
      expect.objectContaining({ symbol, side: "sell", status: "ACKED", orderedQuantity: 10 }),
    ]);
    expect((await engine!.dashboard()).market.regime.buyAllowed).toBe(false);
  });

  it("ignores the pre-observation day high and restores the observed peak after restart before a trailing sell", async () => {
    const adapter = await startMemoryEngine((settings) => {
      settings.brokers.kiwoom.orderPolicy.trailingProfitEnabled = true;
      settings.brokers.kiwoom.orderPolicy.trailingActivationBps = 300;
      settings.brokers.kiwoom.orderPolicy.trailingDrawdownBps = 150;
    });

    // An intraday high may precede the purchase. It must not arm the trail.
    adapter.emitQuote(10_000, { high: 20_000 });
    await setImmediate();
    expect(adapter.placeOrder).not.toHaveBeenCalled();

    vi.setSystemTime(sessionStart + 2_000);
    adapter.emitQuote(11_000, { high: 20_000 });
    await setImmediate();
    expect(adapter.placeOrder).not.toHaveBeenCalled();

    await engine!.stop();
    engine = createMemoryEngine(adapter);
    await engine.start();
    expect(adapter.placeOrder).not.toHaveBeenCalled();

    vi.setSystemTime(sessionStart + 4_000);
    adapter.emitQuote(10_700, { high: 20_000 });

    await vi.waitFor(() => expect(adapter.placeOrder).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      symbol, side: "sell", quantity: 10,
    })));
    expect(repository!.listOrders(scope)).toEqual([
      expect.objectContaining({ symbol, side: "sell", status: "ACKED" }),
    ]);
  });

  it("holds a cost-recovered winner through noise and sells only through its rising protected floor", async () => {
    const adapter = await startMemoryEngine((settings) => {
      Object.assign(settings.brokers.kiwoom.orderPolicy, {
        trailingProfitEnabled: true,
        trailingActivationBps: 90,
        trailingDrawdownBps: 30,
        estimatedRoundTripCostBps: 30,
      });
    });

    adapter.emitQuote(10_100);
    await setImmediate();
    adapter.emitQuote(10_090);
    await setImmediate();
    expect(adapter.placeOrder).not.toHaveBeenCalled();

    vi.setSystemTime(sessionStart + 2_000);
    adapter.emitQuote(10_069);
    await vi.waitFor(() => expect(adapter.placeOrder).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ symbol, side: "sell", quantity: 10 }),
    ));
  });

  it("records the current quote when retrying a latched trailing exit", async () => {
    const adapter = await startMemoryEngine((settings) => {
      Object.assign(settings.brokers.kiwoom.orderPolicy, {
        trailingProfitEnabled: true,
        trailingActivationBps: 90,
        trailingDrawdownBps: 30,
        estimatedRoundTripCostBps: 30,
        orderRetrySeconds: 5,
      });
    });

    adapter.emitQuote(10_100);
    await setImmediate();
    vi.setSystemTime(sessionStart + 2_000);
    adapter.emitQuote(10_069);
    await vi.waitFor(() => expect(adapter.placeOrder).toHaveBeenCalledTimes(1));

    const firstOrder = adapter.openOrders.shift()!;
    adapter.emitOrder({ ...firstOrder, status: "CANCELED", remainingQuantity: 0 });
    await vi.waitFor(async () => {
      expect((await engine!.settingsResponse()).connections.kiwoom.accountSynchronized).toBe(true);
    }, { timeout: 2_000 });

    vi.setSystemTime(sessionStart + 8_000);
    adapter.emitQuote(10_000);
    await vi.waitFor(() => expect(adapter.placeOrder).toHaveBeenCalledTimes(2));
    const sellSignals = repository!.listSignals(scope, { actions: ["SELL"], limit: 10 });
    expect(sellSignals.map((signal) => signal.metrics.currentPrice)).toContain(10_000);
  });

  it("waits for the account snapshot after a partial-fill cancellation and retries only the confirmed remainder without duplicating active orders", async () => {
    const adapter = await startMemoryEngine((settings) => {
      settings.brokers.kiwoom.orderPolicy.stopLossEnabled = true;
      settings.brokers.kiwoom.orderPolicy.stopLossBps = 300;
    });
    adapter.emitQuote(9_600);
    await vi.waitFor(() => expect(adapter.placeOrder).toHaveBeenCalledTimes(1));

    // The same exit keeps firing, but the first order is still active.
    vi.setSystemTime(sessionStart + 2_000);
    adapter.emitQuote(9_500);
    await setImmediate();
    expect(adapter.placeOrder).toHaveBeenCalledTimes(1);

    let releaseSnapshot!: () => void;
    adapter.snapshotGate = new Promise<void>((resolve) => { releaseSnapshot = resolve; });
    const partial: BrokerOrder = {
      ...adapter.openOrders[0]!, status: "PARTIALLY_FILLED", filledQuantity: 4, remainingQuantity: 6,
    };
    adapter.openOrders.splice(0, 1, partial);
    adapter.emitOrder(partial);
    adapter.openOrders.splice(0, 1);
    adapter.emitOrder({ ...partial, status: "CANCELED", remainingQuantity: 0 });
    Object.assign(adapter.position, {
      quantity: 6, availableQuantity: 6, currentPrice: 9_500, marketValue: 57_000,
      unrealizedPnl: -3_000, unrealizedPnlBps: -500,
    });

    try {
      await vi.waitFor(() => expect(adapter.fetchAccountSnapshot).toHaveBeenCalledTimes(2), { timeout: 2_000 });
      expect((await engine!.settingsResponse()).connections.kiwoom.accountSynchronized).toBe(false);
      expect(repository!.getPosition(scope, symbol)?.quantity).toBe(10);

      // More than 30 seconds have passed, so only account reconciliation can
      // prevent a second sell against the obsolete ten-share local balance.
      vi.setSystemTime(sessionStart + 31_000);
      adapter.emitQuote(9_400);
      await setImmediate();
      expect(adapter.placeOrder).toHaveBeenCalledTimes(1);
    } finally {
      adapter.snapshotGate = null;
      releaseSnapshot();
    }

    await vi.waitFor(async () => {
      expect((await engine!.settingsResponse()).connections.kiwoom.accountSynchronized).toBe(true);
      expect(repository!.getPosition(scope, symbol)?.quantity).toBe(6);
    });
    vi.setSystemTime(sessionStart + 33_000);
    adapter.emitQuote(9_400);
    await vi.waitFor(() => expect(adapter.placeOrder).toHaveBeenCalledTimes(2));
    expect(adapter.placeOrder.mock.calls.map(([request]) => ({ side: request.side, quantity: request.quantity })))
      .toEqual([{ side: "sell", quantity: 10 }, { side: "sell", quantity: 6 }]);
    expect(repository!.listOrders(scope)).toEqual(expect.arrayContaining([
      expect.objectContaining({ brokerOrderId: "memory-order-1", status: "CANCELED", filledQuantity: 4 }),
      expect.objectContaining({ brokerOrderId: "memory-order-2", status: "ACKED", orderedQuantity: 6 }),
    ]));

    vi.setSystemTime(sessionStart + 65_000);
    adapter.emitQuote(9_300);
    await setImmediate();
    expect(adapter.placeOrder).toHaveBeenCalledTimes(2);
  });

  it("deduplicates the same signal after cancellation while permitting a new sell signal on the same day", async () => {
    const adapter = await startMemoryEngine((settings) => {
      settings.brokers.kiwoom.orderPolicy.stopLossEnabled = true;
      settings.brokers.kiwoom.orderPolicy.stopLossBps = 300;
    });
    adapter.emitQuote(9_600);
    await vi.waitFor(() => expect(adapter.placeOrder).toHaveBeenCalledTimes(1));
    const settings = engine!.settings;
    await engine!.stop();
    const original = repository!.listOrders(scope)[0]!;
    repository!.applyOrderEvent({
      scope, orderId: original.id, dedupeKey: "test:confirmed-cancellation",
      eventType: "BROKER_CANCELED", toStatus: "CANCELED", eventAt: new Date().toISOString(),
    });
    adapter.openOrders.splice(0, 1);
    const signal = repository!.listSignals(scope)[0]!;
    const quote = repository!.getLatestQuote(symbol)!;
    const dispatcher = new OrderDispatcher(repository!);
    const input = {
      adapter, appSettings: settings, brokerSettings: settings.brokers.kiwoom, signal, quote,
      riskContext: {
        positions: [adapter.position], openOrders: [], dailyInvestedAmount: 0, dailyTotalPnl: 0,
        reservedAmount: 0, availableCash: 1_000_000, instrumentBuyAllowed: true,
        instrumentRestrictionCodes: [], marketRegimeBuyAllowed: false, marketOpen: true,
      },
    };

    expect(await dispatcher.dispatch(input)).toMatchObject({ submitted: false, reasonCodes: ["DUPLICATE_ORDER_BLOCKED"] });
    expect(adapter.placeOrder).toHaveBeenCalledTimes(1);

    const next = repository!.insertSignal({
      ...signal, id: `${signal.id}-next`, inputHash: `${signal.inputHash}-next`,
    }).signal;
    expect(await dispatcher.dispatch({ ...input, signal: next })).toMatchObject({ submitted: true, outcome: "ACCEPTED" });
    expect(adapter.placeOrder).toHaveBeenCalledTimes(2);
    expect(repository!.listOrders(scope)).toEqual(expect.arrayContaining([
      expect.objectContaining({ brokerOrderId: "memory-order-1", status: "CANCELED" }),
      expect.objectContaining({ brokerOrderId: "memory-order-2", status: "ACKED" }),
    ]));
  });

  it.each(["history-only", "history-and-execution"] as const)(
    "requires another balance after discovering a canceled partial fill through %s without websocket notifications",
    async (discovery) => {
      const adapter = await startMemoryEngine((settings) => {
        settings.brokers.kiwoom.orderPolicy.stopLossEnabled = true;
        settings.brokers.kiwoom.orderPolicy.stopLossBps = 300;
      });
      adapter.emitQuote(9_600);
      await vi.waitFor(() => expect(adapter.placeOrder).toHaveBeenCalledTimes(1));
      await engine!.stop();

      // Only the remote REST fixtures change: neither the fill nor cancellation
      // sends a websocket event. Restart supplies the next reconciliation round.
      vi.setSystemTime(sessionStart + 31_000);
      const remoteOrder = adapter.openOrders.shift()!;
      adapter.orderHistory.push({
        ...remoteOrder, status: "CANCELED", filledQuantity: 4, remainingQuantity: 0,
      });
      if (discovery === "history-and-execution") {
        adapter.executions.push({
          executionId: "memory-rest-fill-1", brokerOrderId: remoteOrder.brokerOrderId,
          symbol, side: "sell", quantity: 4, price: 9_600,
          executedAt: new Date(sessionStart + 30_000).toISOString(), exchange: "KRX",
        });
      }

      // The balance response races the history/execution response and still
      // contains ten shares. The next response will confirm six, but is held.
      const staleSnapshot = await adapter.fetchAccountSnapshot();
      const priorSnapshotCalls = adapter.fetchAccountSnapshot.mock.calls.length;
      let releaseSnapshot!: () => void;
      adapter.snapshotGate = new Promise<void>((resolve) => { releaseSnapshot = resolve; });
      adapter.fetchAccountSnapshot.mockResolvedValueOnce(staleSnapshot);
      Object.assign(adapter.position, {
        quantity: 6, availableQuantity: 6, currentPrice: 9_600, marketValue: 57_600,
        unrealizedPnl: -2_400, unrealizedPnlBps: -400,
      });

      try {
        engine = createMemoryEngine(adapter);
        await engine.start();
        expect(adapter.fetchOrderHistory).toHaveBeenCalledTimes(1);
        expect(repository!.findOrderByBrokerId(scope, remoteOrder.brokerOrderId)).toMatchObject({
          status: "CANCELED", filledQuantity: 4,
        });
        expect(repository!.getPosition(scope, symbol)?.quantity).toBe(10);
        expect((await engine.settingsResponse()).connections.kiwoom.accountSynchronized).toBe(false);

        adapter.emitQuote(9_500);
        await setImmediate();
        expect(adapter.placeOrder).toHaveBeenCalledTimes(1);
        await vi.waitFor(() => {
          expect(adapter.fetchAccountSnapshot).toHaveBeenCalledTimes(priorSnapshotCalls + 2);
        }, { timeout: 2_000 });
        expect((await engine.settingsResponse()).connections.kiwoom.accountSynchronized).toBe(false);
      } finally {
        adapter.snapshotGate = null;
        releaseSnapshot();
      }

      await vi.waitFor(async () => {
        expect((await engine!.settingsResponse()).connections.kiwoom.accountSynchronized).toBe(true);
        expect(repository!.getPosition(scope, symbol)?.quantity).toBe(6);
      });
      vi.setSystemTime(sessionStart + 33_000);
      adapter.emitQuote(9_500);
      await vi.waitFor(() => expect(adapter.placeOrder).toHaveBeenCalledTimes(2));
      expect(adapter.placeOrder.mock.calls.map(([request]) => request.quantity)).toEqual([10, 6]);
      expect(repository!.listFills(scope)).toHaveLength(discovery === "history-and-execution" ? 1 : 0);
    },
  );
});
