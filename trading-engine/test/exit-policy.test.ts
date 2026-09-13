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
  it("does not cut profitable positions just because the holding timer expired", () => {
    const orderPolicy = createDefaultSettings().brokers.kiwoom.orderPolicy;
    Object.assign(orderPolicy, { takeProfitEnabled: false, maxHoldingMinutes: 15,
      timedExitOnlyWithoutNetProfit: true, estimatedRoundTripCostBps: 30, stopLossEnabled: true, stopLossBps: 60 });
    for (const price of [10051, 10500, 11000]) {
      expect(evaluatePositionExitPolicy({ position, quote: { ...quote, price }, orderPolicy, heldForMs: 3600000 })).toBeNull();
    }
    for (const price of [10000, 10020, 10030]) {
      expect(evaluatePositionExitPolicy({ position, quote: { ...quote, price }, orderPolicy, heldForMs: 900000 }))
        .toMatchObject({ action: "SELL", reasonCodes: ["MAX_HOLDING_TIME_REACHED"] });
    }
    expect(evaluatePositionExitPolicy({ position, quote: { ...quote, price: 9900 }, orderPolicy, heldForMs: 1000 }))
      .toMatchObject({ action: "SELL", reasonCodes: ["STOP_LOSS_TRIGGERED"] });
  });
  it("requires profit after estimated costs and provides a minimum profit limit price", () => {
    const orderPolicy = createDefaultSettings().brokers.kiwoom.orderPolicy;
    Object.assign(orderPolicy, { takeProfitEnabled: true, takeProfitAfterCosts: true, takeProfitBps: 20, estimatedRoundTripCostBps: 30 });
    expect(evaluatePositionExitPolicy({ position, quote: { ...quote, price: 10040 }, orderPolicy })).toBeNull();
    expect(evaluatePositionExitPolicy({ position, quote: { ...quote, price: 10051 }, orderPolicy })).toMatchObject({
      action: "SELL", reasonCodes: ["NET_PROFIT_TARGET_REACHED"],
    });
  });
  it("exits at a configured minute limit without waiting for daily bars", () => {
    const orderPolicy = createDefaultSettings().brokers.kiwoom.orderPolicy;
    orderPolicy.maxHoldingMinutes = 15;
    expect(evaluatePositionExitPolicy({ position, quote, orderPolicy, heldForMs: 899999 })).toBeNull();
    expect(evaluatePositionExitPolicy({ position, quote, orderPolicy, heldForMs: 900000 })).toMatchObject({
      action: "SELL", reasonCodes: ["MAX_HOLDING_TIME_REACHED"],
    });
  });
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

  it("sells at the loss boundary independently of fixed take profit", () => {
    const orderPolicy = createDefaultSettings().brokers.kiwoom.orderPolicy;
    orderPolicy.stopLossEnabled = true;
    orderPolicy.stopLossBps = 300;
    expect(evaluatePositionExitPolicy({ position, quote: { ...quote, price: 9_700 }, orderPolicy }))
      .toMatchObject({ action: "SELL", reasonCodes: ["STOP_LOSS_TRIGGERED"] });
    expect(evaluatePositionExitPolicy({ position, quote: { ...quote, price: 9_701 }, orderPolicy })).toBeNull();
  });

  it("uses only the position peak and waits for activation plus a sufficient drawdown", () => {
    const orderPolicy = createDefaultSettings().brokers.kiwoom.orderPolicy;
    orderPolicy.trailingProfitEnabled = true;
    expect(evaluatePositionExitPolicy({ position, quote: { ...quote, price: 10_000, high: 50_000 }, orderPolicy })).toBeNull();
    expect(evaluatePositionExitPolicy({ position, quote: { ...quote, price: 10_000 }, peakPrice: 10_200, orderPolicy })).toBeNull();
    expect(evaluatePositionExitPolicy({ position, quote: { ...quote, price: 10_136 }, peakPrice: 10_300, orderPolicy }))
      .toMatchObject({ action: "SELL", reasonCodes: ["TRAILING_PROFIT_TRIGGERED"] });
    expect(evaluatePositionExitPolicy({ position, quote: { ...quote, price: 10_200 }, peakPrice: 10_300, orderPolicy }))
      .toMatchObject({ action: "HOLD", reasonCodes: ["PROFIT_PROTECTION_ACTIVE"] });
  });

  it("locks the learned cost floor after activation without selling at a fresh peak", () => {
    const orderPolicy = createDefaultSettings().brokers.kiwoom.orderPolicy;
    Object.assign(orderPolicy, {
      trailingProfitEnabled: true,
      trailingActivationBps: 30,
      trailingDrawdownBps: 150,
      estimatedRoundTripCostBps: 20,
    });
    expect(evaluatePositionExitPolicy({
      position,
      quote: { ...quote, price: 10_040 },
      peakPrice: 10_040,
      orderPolicy,
      observedRoundTripCostBps: 40,
    })).toMatchObject({
      action: "HOLD",
      reasonCodes: ["PROFIT_PROTECTION_ACTIVE"],
      metrics: {
        estimatedRoundTripCostBps: 40,
        profitProtectionActivationBps: 40,
        protectedFloorPrice: 10_040,
      },
    });
    expect(evaluatePositionExitPolicy({
      position,
      quote: { ...quote, price: 10_039 },
      peakPrice: 10_040,
      orderPolicy,
      observedRoundTripCostBps: 40,
    })).toMatchObject({ action: "SELL", reasonCodes: ["TRAILING_PROFIT_TRIGGERED"] });
  });

  it("lets a profitable peak run and raises the protected floor with it", () => {
    const orderPolicy = createDefaultSettings().brokers.kiwoom.orderPolicy;
    Object.assign(orderPolicy, {
      trailingProfitEnabled: true,
      trailingActivationBps: 90,
      trailingDrawdownBps: 30,
      estimatedRoundTripCostBps: 30,
    });
    expect(evaluatePositionExitPolicy({
      position,
      quote: { ...quote, price: 10_970 },
      peakPrice: 11_000,
      orderPolicy,
    })).toMatchObject({
      action: "HOLD",
      reasonCodes: ["PROFIT_PROTECTION_ACTIVE"],
      metrics: { protectedFloorPrice: 10_967 },
    });
    expect(evaluatePositionExitPolicy({
      position,
      quote: { ...quote, price: 10_967 },
      peakPrice: 11_000,
      orderPolicy,
    })).toMatchObject({ action: "SELL", reasonCodes: ["TRAILING_PROFIT_TRIGGERED"] });
  });

  it("ages out only stagnant holdings and lets profitable trends continue", () => {
    const orderPolicy = createDefaultSettings().brokers.kiwoom.orderPolicy;
    orderPolicy.stagnationExitEnabled = true;
    const flatQuote = { ...quote, price: 10_100 };
    expect(evaluatePositionExitPolicy({ position, quote: flatQuote, orderPolicy, completedHoldingSessions: 4 })).toBeNull();
    expect(evaluatePositionExitPolicy({ position, quote: flatQuote, orderPolicy, completedHoldingSessions: 5 }))
      .toMatchObject({ action: "SELL", reasonCodes: ["STAGNATION_EXIT_TRIGGERED"] });
    expect(evaluatePositionExitPolicy({ position, quote, orderPolicy, completedHoldingSessions: 50 })).toBeNull();
    expect(evaluatePositionExitPolicy({ position, quote: flatQuote, orderPolicy })).toBeNull();
  });

  it("does not emit an exit from invalid prices", () => {
    const orderPolicy = createDefaultSettings().brokers.kiwoom.orderPolicy;
    orderPolicy.takeProfitEnabled = true;
    orderPolicy.stopLossEnabled = true;
    for (const price of [Number.NaN, Infinity, 0, -1]) {
      expect(evaluatePositionExitPolicy({ position, quote: { ...quote, price }, orderPolicy })).toBeNull();
    }
  });
});
