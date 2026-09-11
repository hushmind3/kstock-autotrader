import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInMemoryTradingRepository, type SignalRecord, type TradingRepository } from "@kstock/database";
import {
  createDefaultSettings,
  type BrokerAdapter,
  type BrokerOrder,
  type BrokerPosition,
  type PlaceOrderRequest,
  type Quote,
} from "@kstock/shared";
import { OrderDispatcher, type DispatchSignalInput } from "../src/core/order-dispatcher.js";

const scope = { brokerId: "kiwoom", environment: "paper", accountId: "memory-dispatch-cycle" } as const;
const symbol = "005930";
const repositories: TradingRepository[] = [];

function currentQuote(): Quote {
  const koreanTime = new Date(Date.now() + 9 * 3_600_000).toISOString();
  return {
    symbol,
    price: 70_000,
    cumulativeVolume: 1_000_000,
    tradingDate: koreanTime.slice(0, 10),
    tradingTime: koreanTime.slice(11, 19).replaceAll(":", ""),
    receivedAt: new Date().toISOString(),
    source: "kiwoom",
    exchange: "KRX",
    brokerTimestampVerified: true,
  };
}

function position(quantity = 3): BrokerPosition {
  return {
    symbol,
    quantity,
    availableQuantity: quantity,
    averagePrice: 70_000,
    currentPrice: 70_000,
    marketValue: quantity * 70_000,
    unrealizedPnl: 0,
    unrealizedPnlBps: 0,
  };
}

function setup() {
  const repository = createInMemoryTradingRepository();
  repositories.push(repository);
  const settings = createDefaultSettings();
  settings.emergencyHalt = false;
  settings.globalAutoTradingEnabled = true;
  settings.newBuysPaused = false;
  Object.assign(settings.brokers.kiwoom, {
    enabled: true, autoTradingEnabled: true, newBuysPaused: false, environment: "paper",
  });
  const strategyConfig = repository.createStrategyConfigVersion({
    id: "cycle-strategy-config",
    strategyId: "pullback-rebound",
    strategyVersion: "1.0.0",
    config: {},
  });
  let orderSequence = 0;
  // Every broker method is a local stub. This test never loads credentials,
  // connects to a broker, or persists an account outside the in-memory database.
  const unexpectedCall = async (): Promise<never> => { throw new Error("Unexpected broker method in dispatcher test"); };
  const placeOrder = vi.fn(async (_request: PlaceOrderRequest) => ({
    outcome: "ACCEPTED" as const,
    brokerOrderId: `memory-order-${++orderSequence}`,
  }));
  const adapter: BrokerAdapter = {
    scope,
    capabilities: {
      supportsLive: false, supportsPaper: true, supportsAmend: false, supportsCancel: false,
      maxQuoteSubscriptions: 1, quoteBatchSize: 1, queryRequestsPerSecond: 1,
      orderRequestsPerSecond: 1, clientOrderIdSupported: true,
    },
    connect: unexpectedCall,
    disconnect: unexpectedCall,
    onEvent: () => { throw new Error("Unexpected broker subscription"); },
    getHealth: () => ({
      state: "CONNECTED", restConnected: true, marketWebSocketConnected: true,
      accountWebSocketConnected: true, checkedAt: new Date().toISOString(),
    }),
    fetchInstruments: unexpectedCall,
    fetchDailyBars: unexpectedCall,
    fetchQuote: unexpectedCall,
    replaceQuoteSubscriptions: unexpectedCall,
    placeOrder,
    amendOrder: unexpectedCall,
    cancelOrder: unexpectedCall,
    fetchAccountSnapshot: unexpectedCall,
    fetchOpenOrders: unexpectedCall,
    fetchExecutions: unexpectedCall,
  };
  function signal(id: string, action: "BUY" | "SELL"): SignalRecord {
    return repository.insertSignal({
      id,
      scope,
      strategyConfigId: strategyConfig.id,
      symbol,
      action,
      reasonCodes: ["TEST_SIGNAL"],
      metrics: { currentPrice: 70_000 },
      inputHash: `input-${id}`,
      observedAt: new Date().toISOString(),
    }).signal;
  }
  function input(decision: SignalRecord, positions: BrokerPosition[] = []): DispatchSignalInput {
    const openOrders: BrokerOrder[] = repository.listOpenOrders(scope).map((order) => ({
      brokerOrderId: order.brokerOrderId ?? order.id,
      symbol: order.symbol,
      side: order.side,
      orderType: order.orderType,
      orderedQuantity: order.orderedQuantity,
      filledQuantity: order.filledQuantity,
      remainingQuantity: order.remainingQuantity,
      status: order.status,
      orderedAt: order.orderedAt,
      exchange: order.exchange,
    }));
    return {
      adapter,
      appSettings: settings,
      brokerSettings: settings.brokers.kiwoom,
      signal: decision,
      quote: currentQuote(),
      riskContext: {
        positions,
        openOrders,
        dailyInvestedAmount: 0,
        dailyTotalPnl: 0,
        reservedAmount: repository.getActiveReservedAmount(scope),
        availableCash: 2_000_000,
        instrumentBuyAllowed: true,
        instrumentRestrictionCodes: [],
        marketRegimeBuyAllowed: true,
        marketOpen: true,
      },
    };
  }
  function cancel(orderId: string, confirmed: boolean) {
    repository.applyOrderEvent({
      scope,
      orderId,
      dedupeKey: `cancel-${confirmed}-${orderId}`,
      eventType: confirmed ? "BROKER_CANCELED" : "CANCEL_SENT",
      toStatus: confirmed ? "CANCELED" : "CANCEL_REQUESTED",
      ...(confirmed ? { remainingQuantity: 0 } : {}),
      eventAt: new Date().toISOString(),
    });
  }
  return { repository, dispatcher: new OrderDispatcher(repository), placeOrder, signal, input, cancel };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-10T01:00:00.000Z"));
});

afterEach(() => {
  for (const repository of repositories.splice(0)) repository.close();
  vi.useRealTimers();
});

describe("OrderDispatcher repeated trading cycles", () => {
  it.each(["BUY", "SELL"] as const)("does not resend the same %s signal after cancellation or dispatcher recreation", async (action) => {
    const test = setup();
    const positions = action === "SELL" ? [position()] : [];
    const signal = test.signal("same-signal", action);
    const first = await test.dispatcher.dispatch(test.input(signal, positions));
    expect(first.submitted).toBe(true);
    test.cancel(first.orderId!, true);
    vi.setSystemTime(new Date("2026-09-10T01:01:00.000Z"));

    const restartedDispatcher = new OrderDispatcher(test.repository);
    const duplicate = await restartedDispatcher.dispatch(test.input(signal, positions));

    expect(duplicate).toEqual({ submitted: false, orderId: first.orderId, reasonCodes: ["DUPLICATE_ORDER_BLOCKED"] });
    expect(test.placeOrder).toHaveBeenCalledTimes(1);
    expect(test.repository.listOrders(scope)).toHaveLength(1);
  });

  it.each(["BUY", "SELL"] as const)("allows a new same-day %s signal only after the previous cancellation is confirmed", async (action) => {
    const test = setup();
    const positions = action === "SELL" ? [position()] : [];
    const first = await test.dispatcher.dispatch(test.input(test.signal("first", action), positions));
    expect(first.submitted).toBe(true);
    test.cancel(first.orderId!, false);
    vi.setSystemTime(new Date("2026-09-10T01:01:00.000Z"));
    const nextSignal = test.signal("next", action);

    const pending = await test.dispatcher.dispatch(test.input(nextSignal, positions));
    expect(pending).toMatchObject({ submitted: false, reasonCodes: ["ACTIVE_ORDER_EXISTS"] });
    expect(test.placeOrder).toHaveBeenCalledTimes(1);

    test.cancel(first.orderId!, true);
    const next = await test.dispatcher.dispatch(test.input(nextSignal, positions));

    expect(next).toMatchObject({ submitted: true, outcome: "ACCEPTED" });
    expect(next.orderId).not.toBe(first.orderId);
    expect(test.placeOrder).toHaveBeenCalledTimes(2);
    const requests = test.placeOrder.mock.calls.map(([request]) => request);
    expect(requests.map((request) => request.side)).toEqual([action.toLowerCase(), action.toLowerCase()]);
    expect(requests[0]!.clientOrderId).not.toBe(requests[1]!.clientOrderId);
    expect(test.repository.listOrders(scope).map((order) => order.orderedAt.slice(0, 10)))
      .toEqual(["2026-09-10", "2026-09-10"]);
  });

  it.each(["BUY", "SELL"] as const)("blocks %s while the opposite side has an active order", async (action) => {
    const test = setup();
    const opposite = action === "BUY" ? "SELL" : "BUY";
    const first = await test.dispatcher.dispatch(test.input(test.signal("opposite", opposite), opposite === "SELL" ? [position()] : []));
    expect(first.submitted).toBe(true);

    const blocked = await test.dispatcher.dispatch(test.input(test.signal("incoming", action), [position()]));

    expect(blocked.submitted).toBe(false);
    expect(blocked.reasonCodes).toContain("ACTIVE_ORDER_EXISTS");
    expect(test.placeOrder).toHaveBeenCalledTimes(1);
    expect(test.repository.listOrders(scope)).toHaveLength(1);
  });

  it("blocks a fresh buy signal for an already held symbol even with no active order", async () => {
    const test = setup();

    const result = await test.dispatcher.dispatch(test.input(test.signal("already-held", "BUY"), [position()]));

    expect(result).toEqual({ submitted: false, reasonCodes: ["POSITION_ALREADY_HELD"] });
    expect(test.placeOrder).not.toHaveBeenCalled();
    expect(test.repository.listOrders(scope)).toHaveLength(0);
  });

  it("resubmits only the reconciled sellable remainder after a partial sell is canceled", async () => {
    const test = setup();
    const first = await test.dispatcher.dispatch(test.input(test.signal("sell-first", "SELL"), [position(10)]));
    expect(first.submitted).toBe(true);
    test.repository.recordExecution({
      scope,
      execution: {
        executionId: "memory-partial-fill",
        brokerOrderId: "memory-order-1",
        symbol,
        side: "sell",
        quantity: 4,
        price: 70_000,
        executedAt: new Date().toISOString(),
        exchange: "KRX",
      },
    });
    test.cancel(first.orderId!, true);
    vi.setSystemTime(new Date("2026-09-10T01:01:00.000Z"));

    const retry = await test.dispatcher.dispatch(test.input(test.signal("sell-remainder", "SELL"), [position(6)]));

    expect(retry.submitted).toBe(true);
    expect(test.placeOrder.mock.calls.map(([request]) => request.quantity)).toEqual([10, 6]);
    expect(test.repository.getOrder(first.orderId!, scope)).toMatchObject({
      status: "CANCELED", filledQuantity: 4, remainingQuantity: 0,
    });
  });
});
