import { describe, expect, it } from "vitest";
import {
  pairAccountExecutionsFifo,
  type DashboardExecutionRow,
  type PairableDashboardExecution,
} from "../src/core/execution-trades.js";

function row(input: {
  id: string;
  symbol?: string;
  side: "buy" | "sell";
  quantity: number;
  executedAt: string;
  receivedAt?: string;
}): PairableDashboardExecution {
  const execution: DashboardExecutionRow = {
    id: input.id,
    brokerId: "kiwoom",
    environment: "live",
    accountIdMasked: "****5678",
    brokerExecutionId: `execution-${input.id}`,
    brokerOrderId: `order-${input.id}`,
    symbol: input.symbol ?? "005930",
    name: input.symbol === "000660" ? "SK하이닉스" : "삼성전자",
    side: input.side,
    quantity: input.quantity,
    price: 70_000,
    grossAmount: input.quantity * 70_000,
    fee: 0,
    tax: 0,
    exchange: "KRX",
    realizedPnl: null,
    executedAt: input.executedAt,
  };
  return {
    execution,
    receivedAt: input.receivedAt ?? input.executedAt,
  };
}

describe("pairAccountExecutionsFifo", () => {
  it("allocates partial sells against the oldest real buys and leaves the remainder open", () => {
    const pairs = pairAccountExecutionsFifo([
      row({ id: "buy-1", side: "buy", quantity: 3, executedAt: "2026-09-15T00:00:00.000Z" }),
      row({ id: "buy-2", side: "buy", quantity: 4, executedAt: "2026-09-15T00:01:00.000Z" }),
      row({ id: "sell-1", side: "sell", quantity: 5, executedAt: "2026-09-15T00:02:00.000Z" }),
    ]);

    expect(pairs).toEqual(expect.arrayContaining([
      expect.objectContaining({
        status: "matched",
        quantity: 3,
        buy: expect.objectContaining({
          quantity: 3,
          execution: expect.objectContaining({ id: "buy-1" }),
        }),
        sell: expect.objectContaining({
          quantity: 3,
          execution: expect.objectContaining({ id: "sell-1" }),
        }),
      }),
      expect.objectContaining({
        status: "matched",
        quantity: 2,
        buy: expect.objectContaining({
          quantity: 2,
          execution: expect.objectContaining({ id: "buy-2" }),
        }),
      }),
      expect.objectContaining({
        status: "open-buy",
        quantity: 2,
        buy: expect.objectContaining({
          quantity: 2,
          execution: expect.objectContaining({ id: "buy-2" }),
        }),
        sell: null,
      }),
    ]));
  });

  it("uses durable receive order for equal broker timestamps and never crosses symbols", () => {
    const executedAt = "2026-09-15T00:00:00.000Z";
    const pairs = pairAccountExecutionsFifo([
      row({
        id: "later-buy",
        side: "buy",
        quantity: 1,
        executedAt,
        receivedAt: "2026-09-15T00:00:02.000Z",
      }),
      row({
        id: "earlier-sell",
        side: "sell",
        quantity: 1,
        executedAt,
        receivedAt: "2026-09-15T00:00:01.000Z",
      }),
      row({
        id: "other-symbol-sell",
        symbol: "000660",
        side: "sell",
        quantity: 2,
        executedAt: "2026-09-15T00:01:00.000Z",
      }),
    ]);

    expect(pairs.filter((pair) => pair.status === "matched")).toHaveLength(0);
    expect(pairs).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: "unmatched-sell", symbol: "005930", quantity: 1 }),
      expect.objectContaining({ status: "open-buy", symbol: "005930", quantity: 1 }),
      expect.objectContaining({ status: "unmatched-sell", symbol: "000660", quantity: 2 }),
    ]));
  });
});
