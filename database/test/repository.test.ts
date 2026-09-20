import { afterEach, describe, expect, it } from "vitest";
import {
  ActiveOrderConflictError,
  createInMemoryTradingRepository,
  type TradingRepository,
} from "../src/index.js";
import type { AccountScope, PlaceOrderRequest } from "@kstock/shared";

const scope: AccountScope = {
  brokerId: "kiwoom",
  environment: "paper",
  accountId: "test-account",
};

const request: PlaceOrderRequest = {
  clientOrderId: "client-1",
  symbol: "005930",
  side: "buy",
  orderType: "market",
  quantity: 3,
  exchange: "KRX",
};

const openRepositories: TradingRepository[] = [];
function repository(): TradingRepository {
  const value = createInMemoryTradingRepository();
  openRepositories.push(value);
  return value;
}

afterEach(() => {
  for (const value of openRepositories.splice(0)) value.close();
});

describe("TradingRepository order ledger", () => {
  it("persists the market-data route with the latest quote", () => {
    const repo = repository();
    repo.upsertLatestQuote({
      source: "kiwoom",
      symbol: "005930",
      price: 70_000,
      cumulativeVolume: 1_000,
      tradingDate: "2026-09-01",
      tradingTime: "08:10:00",
      receivedAt: "2026-09-01T23:10:00.000Z",
      exchange: "NXT",
    });

    expect(repo.getLatestQuote("005930", "kiwoom")).toMatchObject({
      exchange: "NXT",
      price: 70_000,
    });
  });

  it("returns the original order for the same idempotency key", () => {
    const repo = repository();
    const first = repo.createOrderIntent({
      id: "intent-1",
      orderId: "order-1",
      outboxId: "outbox-1",
      scope,
      idempotencyKey: "decision-1",
      request,
      reservation: { budgetKey: "daily", amount: 210_000, maximumActiveAmount: 500_000 },
    });
    const duplicate = repo.createOrderIntent({
      id: "intent-never-used",
      orderId: "order-never-used",
      outboxId: "outbox-never-used",
      scope,
      idempotencyKey: "decision-1",
      request: { ...request, clientOrderId: "client-2" },
    });

    expect(first.created).toBe(true);
    expect(first.order.exchange).toBe("KRX");
    expect(duplicate.created).toBe(false);
    expect(duplicate.intent.id).toBe("intent-1");
    expect(duplicate.order.id).toBe("order-1");
    expect(repo.listOpenOrders(scope)).toHaveLength(1);
    expect(repo.getActiveReservedAmount(scope, "daily")).toBe(210_000);
  });

  it("keeps the requested SOR route after an NXT execution is received", () => {
    const repo = repository();
    repo.createOrderIntent({
      id: "intent-sor",
      orderId: "order-sor",
      outboxId: "outbox-sor",
      scope,
      idempotencyKey: "decision-sor",
      request: { ...request, clientOrderId: "client-sor", exchange: "SOR" },
      createdAt: "2026-09-01T01:00:00.000Z",
    });
    repo.applyOrderEvent({
      scope,
      orderId: "order-sor",
      dedupeKey: "ack-sor",
      eventType: "BROKER_ACK",
      toStatus: "ACKED",
      eventAt: "2026-09-01T01:00:01.000Z",
      brokerOrderId: "broker-sor",
    });

    const result = repo.recordExecution({
      scope,
      execution: {
        executionId: "fill-sor",
        brokerOrderId: "broker-sor",
        symbol: "005930",
        side: "buy",
        quantity: 3,
        price: 70_000,
        executedAt: "2026-09-01T01:01:00.000Z",
        exchange: "NXT",
      },
    });

    expect(result.order.exchange).toBe("SOR");
  });

  it("records the broker route for externally discovered orders and executions", () => {
    const repo = repository();
    const reconciled = repo.upsertReconciledOrder({
      scope,
      brokerOrder: {
        brokerOrderId: "external-nxt",
        symbol: "000660",
        side: "buy",
        orderType: "limit",
        orderedQuantity: 1,
        filledQuantity: 0,
        remainingQuantity: 1,
        limitPrice: 200_000,
        status: "ACKED",
        orderedAt: "2026-09-01T01:00:00.000Z",
        exchange: "NXT",
      },
    });
    const execution = repo.recordExecution({
      scope,
      execution: {
        executionId: "external-fill-krx",
        brokerOrderId: "external-execution-krx",
        symbol: "035420",
        side: "sell",
        quantity: 1,
        price: 250_000,
        executedAt: "2026-09-01T01:02:00.000Z",
        exchange: "KRX",
      },
    });

    expect(reconciled.exchange).toBe("NXT");
    expect(execution.order.exchange).toBe("KRX");
  });

  it("blocks a second active order for the same account, symbol and side", () => {
    const repo = repository();
    repo.createOrderIntent({
      id: "intent-1",
      orderId: "order-1",
      outboxId: "outbox-1",
      scope,
      idempotencyKey: "decision-1",
      request,
    });

    expect(() => repo.createOrderIntent({
      id: "intent-2",
      orderId: "order-2",
      outboxId: "outbox-2",
      scope,
      idempotencyKey: "decision-2",
      request: { ...request, clientOrderId: "client-2" },
    })).toThrow(ActiveOrderConflictError);
  });

  it("does not treat a zero-remainder historical UNKNOWN row as an open order", () => {
    const repo = repository();
    repo.upsertReconciledOrder({
      scope,
      brokerOrder: {
        brokerOrderId: "historical-external-fill",
        symbol: request.symbol,
        side: request.side,
        orderType: "market",
        orderedQuantity: 2,
        filledQuantity: 2,
        remainingQuantity: 0,
        status: "UNKNOWN",
        orderedAt: "2026-09-01T00:30:00.000Z",
      },
    });

    expect(repo.listOpenOrders(scope)).toHaveLength(0);
    expect(() => repo.createOrderIntent({
      id: "intent-after-historical-fill",
      orderId: "order-after-historical-fill",
      outboxId: "outbox-after-historical-fill",
      scope,
      idempotencyKey: "decision-after-historical-fill",
      request: { ...request, clientOrderId: "client-after-historical-fill" },
    })).not.toThrow();
  });

  it("deduplicates repeated broker order events", () => {
    const repo = repository();
    repo.createOrderIntent({
      id: "intent-1",
      orderId: "order-1",
      outboxId: "outbox-1",
      scope,
      idempotencyKey: "decision-1",
      request,
    });
    const event = {
      scope,
      orderId: "order-1",
      dedupeKey: "broker-event-1",
      eventType: "BROKER_ACK",
      toStatus: "ACKED" as const,
      eventAt: "2026-08-31T01:00:00.000Z",
      brokerOrderId: "broker-order-1",
    };

    expect(repo.applyOrderEvent(event).applied).toBe(true);
    expect(repo.applyOrderEvent(event).applied).toBe(false);
    expect(repo.listOrderEvents(scope, { orderId: "order-1" })).toHaveLength(2);
  });

  it("keeps broker order numbers from different trading days independent", () => {
    const repo = repository();
    const first = repo.upsertReconciledOrder({
      scope,
      brokerOrder: {
        brokerOrderId: "reused-order-number",
        symbol: "005930",
        side: "buy",
        orderType: "market",
        orderedQuantity: 1,
        filledQuantity: 1,
        remainingQuantity: 0,
        status: "FILLED",
        orderedAt: "2026-08-31T01:00:00.000Z",
      },
    });
    const second = repo.upsertReconciledOrder({
      scope,
      brokerOrder: {
        brokerOrderId: "reused-order-number",
        symbol: "005930",
        side: "buy",
        orderType: "market",
        orderedQuantity: 2,
        filledQuantity: 0,
        remainingQuantity: 2,
        status: "ACKED",
        orderedAt: "2026-09-01T01:00:00.000Z",
      },
    });

    expect(second.id).not.toBe(first.id);
    expect(repo.findOrderByBrokerId(scope, "reused-order-number", first.orderedAt)?.id).toBe(first.id);
    expect(repo.findOrderByBrokerId(scope, "reused-order-number", second.orderedAt)?.id).toBe(second.id);
  });

  it("records only the positive delta from cumulative execution snapshots", () => {
    const repo = repository();
    repo.createOrderIntent({
      id: "intent-cumulative",
      orderId: "order-cumulative",
      outboxId: "outbox-cumulative",
      scope,
      idempotencyKey: "decision-cumulative",
      request: { ...request, clientOrderId: "client-cumulative", quantity: 5 },
      createdAt: "2026-09-01T01:00:00.000Z",
    });
    repo.applyOrderEvent({
      scope,
      orderId: "order-cumulative",
      dedupeKey: "ack-cumulative",
      eventType: "BROKER_ACK",
      toStatus: "ACKED",
      eventAt: "2026-09-01T01:00:00.000Z",
      brokerOrderId: "broker-cumulative",
    });

    const first = repo.recordExecution({
      scope,
      execution: {
        executionId: "snapshot-broker-cumulative",
        brokerOrderId: "broker-cumulative",
        symbol: "005930",
        side: "buy",
        quantity: 2,
        price: 100,
        cumulativeQuantity: 2,
        cumulativeNotional: 200,
        executedAt: "2026-09-01T01:01:00.000Z",
      },
    });
    const repeated = repo.recordExecution({
      scope,
      execution: {
        executionId: "snapshot-broker-cumulative",
        brokerOrderId: "broker-cumulative",
        symbol: "005930",
        side: "buy",
        quantity: 2,
        price: 100,
        cumulativeQuantity: 2,
        cumulativeNotional: 200,
        executedAt: "2026-09-01T01:01:00.000Z",
      },
    });
    const completed = repo.recordExecution({
      scope,
      execution: {
        executionId: "snapshot-broker-cumulative",
        brokerOrderId: "broker-cumulative",
        symbol: "005930",
        side: "buy",
        quantity: 5,
        price: 106,
        cumulativeQuantity: 5,
        cumulativeNotional: 530,
        executedAt: "2026-09-01T01:02:00.000Z",
      },
    });

    expect(first.inserted).toBe(true);
    expect(repeated.inserted).toBe(false);
    expect(completed.inserted).toBe(true);
    expect(completed.fill?.quantity).toBe(3);
    expect(completed.fill?.price).toBe(110);
    expect(completed.order.filledQuantity).toBe(5);
    expect(completed.order.status).toBe("FILLED");
    expect(repo.listFills(scope, { orderId: "order-cumulative" }))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ quantity: 2, price: 100 }),
        expect.objectContaining({ quantity: 3, price: 110 }),
      ]));
  });

  it("does not duplicate a real-time fill when the cumulative REST row overlaps", () => {
    const repo = repository();
    repo.createOrderIntent({
      id: "intent-overlap",
      orderId: "order-overlap",
      outboxId: "outbox-overlap",
      scope,
      idempotencyKey: "decision-overlap",
      request: { ...request, clientOrderId: "client-overlap", quantity: 5 },
      createdAt: "2026-09-01T02:00:00.000Z",
    });
    repo.applyOrderEvent({
      scope,
      orderId: "order-overlap",
      dedupeKey: "ack-overlap",
      eventType: "BROKER_ACK",
      toStatus: "ACKED",
      eventAt: "2026-09-01T02:00:00.000Z",
      brokerOrderId: "broker-overlap",
    });
    repo.recordExecution({
      scope,
      execution: {
        executionId: "realtime-fill-1",
        brokerOrderId: "broker-overlap",
        symbol: "005930",
        side: "buy",
        quantity: 2,
        price: 100,
        executedAt: "2026-09-01T02:01:00.000Z",
      },
    });
    const overlap = repo.recordExecution({
      scope,
      execution: {
        executionId: "snapshot-broker-overlap",
        brokerOrderId: "broker-overlap",
        symbol: "005930",
        side: "buy",
        quantity: 2,
        price: 100,
        cumulativeQuantity: 2,
        cumulativeNotional: 200,
        executedAt: "2026-09-01T02:02:00.000Z",
      },
    });

    expect(overlap.inserted).toBe(false);
    expect(repo.listFills(scope, { orderId: "order-overlap" })).toHaveLength(1);
    expect(overlap.order.filledQuantity).toBe(2);
  });

  it("does not duplicate a real-time fill when a REST row has only a synthetic identity", () => {
    const repo = repository();
    repo.createOrderIntent({
      id: "intent-synthetic-overlap",
      orderId: "order-synthetic-overlap",
      outboxId: "outbox-synthetic-overlap",
      scope,
      idempotencyKey: "decision-synthetic-overlap",
      request: { ...request, clientOrderId: "client-synthetic-overlap", quantity: 2 },
      createdAt: "2026-09-01T02:00:00.000Z",
    });
    repo.applyOrderEvent({
      scope,
      orderId: "order-synthetic-overlap",
      dedupeKey: "ack-synthetic-overlap",
      eventType: "BROKER_ACK",
      toStatus: "ACKED",
      eventAt: "2026-09-01T02:00:00.000Z",
      brokerOrderId: "broker-synthetic-overlap",
    });
    repo.recordExecution({
      scope,
      execution: {
        executionId: "broker-fill-number",
        brokerOrderId: "broker-synthetic-overlap",
        symbol: "005930",
        side: "buy",
        quantity: 2,
        price: 100,
        executedAt: "2026-09-01T02:01:00.000Z",
      },
    });

    const overlap = repo.recordExecution({
      scope,
      execution: {
        executionId: "synthetic-order-time-price-quantity",
        syntheticExecutionId: true,
        brokerOrderId: "broker-synthetic-overlap",
        symbol: "005930",
        side: "buy",
        quantity: 2,
        price: 100,
        executedAt: "2026-09-01T02:01:00.000Z",
      },
    });

    expect(overlap.inserted).toBe(false);
    expect(overlap.fill?.brokerExecutionId).toBe("broker-fill-number");
    expect(repo.listFills(scope, { orderId: "order-synthetic-overlap" })).toHaveLength(1);
    expect(overlap.order.filledQuantity).toBe(2);
  });

  it("ignores a delayed ka10076 replay when the real-time fill is already stored", () => {
    const repo = repository();
    repo.createOrderIntent({
      id: "intent-synthetic-replay",
      orderId: "order-synthetic-replay",
      outboxId: "outbox-synthetic-replay",
      scope,
      idempotencyKey: "decision-synthetic-replay",
      request: { ...request, clientOrderId: "client-synthetic-replay", quantity: 2 },
      createdAt: "2026-09-04T03:23:49.000Z",
    });
    repo.applyOrderEvent({
      scope,
      orderId: "order-synthetic-replay",
      dedupeKey: "ack-synthetic-replay",
      eventType: "BROKER_ACK",
      toStatus: "ACKED",
      eventAt: "2026-09-04T03:23:50.000Z",
      brokerOrderId: "broker-synthetic-replay",
    });
    const real = repo.recordExecution({
      scope,
      execution: {
        executionId: "stream-fill-replay",
        brokerOrderId: "broker-synthetic-replay",
        symbol: "005930",
        side: "buy",
        quantity: 2,
        price: 100,
        executedAt: "2026-09-04T03:23:50.000Z",
      },
      receivedAt: "2026-09-04T03:23:50.100Z",
    });
    const replay = repo.recordExecution({
      scope,
      execution: {
        executionId: "ka10076:20260905:broker-synthetic-replay:122350:100:2",
        syntheticExecutionId: true,
        brokerOrderId: "broker-synthetic-replay",
        symbol: "005930",
        side: "buy",
        quantity: 2,
        price: 100,
        executedAt: "2026-09-05T03:23:50.000Z",
      },
      receivedAt: "2026-09-04T15:00:29.000Z",
    });

    expect(real.inserted).toBe(true);
    expect(replay.inserted).toBe(false);
    expect(replay.fill?.brokerExecutionId).toBe("stream-fill-replay");
    expect(repo.listFills(scope, { orderId: "order-synthetic-replay" })).toHaveLength(1);
  });

  it("does not show a previously stored delayed ka10076 replay in the fill ledger", () => {
    const repo = repository();
    repo.createOrderIntent({
      id: "intent-stale-synthetic",
      orderId: "order-stale-synthetic",
      outboxId: "outbox-stale-synthetic",
      scope,
      idempotencyKey: "decision-stale-synthetic",
      request: { ...request, clientOrderId: "client-stale-synthetic", quantity: 2 },
      createdAt: "2026-09-04T03:23:49.000Z",
    });
    repo.applyOrderEvent({
      scope,
      orderId: "order-stale-synthetic",
      dedupeKey: "ack-stale-synthetic",
      eventType: "BROKER_ACK",
      toStatus: "ACKED",
      eventAt: "2026-09-04T03:23:50.000Z",
      brokerOrderId: "broker-stale-synthetic",
    });
    repo.recordExecution({
      scope,
      execution: {
        executionId: "ka10076:20260905:broker-stale-synthetic:122350:100:2",
        syntheticExecutionId: true,
        brokerOrderId: "broker-stale-synthetic",
        symbol: "005930",
        side: "buy",
        quantity: 2,
        price: 100,
        executedAt: "2026-09-05T03:23:50.000Z",
      },
      receivedAt: "2026-09-04T15:00:29.000Z",
    });

    expect(repo.listFills(scope, { orderId: "order-stale-synthetic" })).toEqual([]);
  });

  it("records a late fill without reopening an already canceled order", () => {
    const repo = repository();
    repo.createOrderIntent({
      id: "intent-late-fill",
      orderId: "order-late-fill",
      outboxId: "outbox-late-fill",
      scope,
      idempotencyKey: "decision-late-fill",
      request: { ...request, clientOrderId: "client-late-fill" },
      createdAt: "2026-09-01T03:00:00.000Z",
    });
    repo.applyOrderEvent({
      scope,
      orderId: "order-late-fill",
      dedupeKey: "ack-late-fill",
      eventType: "BROKER_ACK",
      toStatus: "ACKED",
      eventAt: "2026-09-01T03:00:01.000Z",
      brokerOrderId: "broker-late-fill",
    });
    repo.applyOrderEvent({
      scope,
      orderId: "order-late-fill",
      dedupeKey: "cancel-request-late-fill",
      eventType: "CANCEL_REQUESTED",
      toStatus: "CANCEL_REQUESTED",
      eventAt: "2026-09-01T03:01:00.000Z",
    });
    repo.applyOrderEvent({
      scope,
      orderId: "order-late-fill",
      dedupeKey: "cancel-confirm-late-fill",
      eventType: "CANCEL_CONFIRMED",
      toStatus: "CANCELED",
      eventAt: "2026-09-01T03:01:01.000Z",
      remainingQuantity: 0,
    });

    const result = repo.recordExecution({
      scope,
      execution: {
        executionId: "late-fill-1",
        brokerOrderId: "broker-late-fill",
        symbol: "005930",
        side: "buy",
        quantity: 1,
        price: 70_000,
        executedAt: "2026-09-01T03:00:59.000Z",
      },
    });

    expect(result.order.status).toBe("CANCELED");
    expect(result.order.filledQuantity).toBe(1);
    expect(result.order.remainingQuantity).toBe(0);
  });
});
