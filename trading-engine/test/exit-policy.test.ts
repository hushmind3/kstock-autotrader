import { describe, expect, it } from "vitest";
import { createDefaultSettings, type BrokerPosition, type Quote } from "@kstock/shared";
import { evaluatePositionExitPolicy } from "../src/core/exit-policy.js";

const position: BrokerPosition = {
  symbol: "005930",
  quantity: 10,
  availableQuantity: 10,
  averagePrice: 10_000,
  currentPrice: 10_500,
  marketValue: 105_000,
  unrealizedPnl: 5_000,
  unrealizedPnlBps: 500,
};

const quote: Quote = {
  symbol: "005930",
  price: 10_500,
  cumulativeVolume: 1_000_000,
  tradingDate: "2026-09-04",
  tradingTime: "100000",
  receivedAt: "2026-09-04T01:00:00.000Z",
  source: "kiwoom",
};

describe("account take-profit exit policy", () => {
  it("is disabled by default and preserves existing live behavior", () => {
    const orderPolicy = createDefaultSettings().brokers.kiwoom.orderPolicy;
    expect(evaluatePositionExitPolicy({ position, quote, orderPolicy })).toBeNull();
  });

  it("emits a sell decision at the configured average-price return", () => {
    const orderPolicy = createDefaultSettings().brokers.kiwoom.orderPolicy;
    orderPolicy.takeProfitEnabled = true;
    orderPolicy.takeProfitBps = 500;
    expect(evaluatePositionExitPolicy({ position, quote, orderPolicy })).toMatchObject({
      action: "SELL",
      reasonCodes: ["TAKE_PROFIT_TARGET_REACHED"],
      metrics: { positionReturnBps: 500, takeProfitTargetBps: 500 },
    });
  });

  it("does nothing below target or without a valid held position", () => {
    const orderPolicy = createDefaultSettings().brokers.kiwoom.orderPolicy;
    orderPolicy.takeProfitEnabled = true;
    orderPolicy.takeProfitBps = 501;
    expect(evaluatePositionExitPolicy({ position, quote, orderPolicy })).toBeNull();
    expect(evaluatePositionExitPolicy({ position: null, quote, orderPolicy })).toBeNull();
  });
});
