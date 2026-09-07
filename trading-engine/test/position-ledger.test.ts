import { describe, expect, it } from "vitest";
import type { BrokerPosition } from "@kstock/shared";
import {
  hasUnresolvedUnknownOrders,
  positionLedgerChanged,
} from "../src/core/trading-engine.js";

const position: BrokerPosition = {
  symbol: "005930",
  name: "삼성전자",
  quantity: 10,
  availableQuantity: 10,
  averagePrice: 70_000,
  currentPrice: 72_000,
  marketValue: 720_000,
  unrealizedPnl: 20_000,
  unrealizedPnlBps: 286,
};

describe("positionLedgerChanged", () => {
  it("does not treat price and profit updates as a ledger change", () => {
    expect(positionLedgerChanged(position, {
      ...position,
      currentPrice: 73_000,
      marketValue: 730_000,
      unrealizedPnl: 30_000,
      unrealizedPnlBps: 429,
    })).toBe(false);
  });

  it.each([
    { quantity: 9 },
    { availableQuantity: 9 },
    { averagePrice: 70_100 },
  ])("requires reconciliation when $s changes", (change) => {
    expect(positionLedgerChanged(position, { ...position, ...change })).toBe(true);
  });

  it("requires reconciliation for a newly reported holding", () => {
    expect(positionLedgerChanged(null, position)).toBe(true);
  });

  it("ignores an empty notification when no holding exists", () => {
    expect(positionLedgerChanged(null, {
      ...position,
      quantity: 0,
      availableQuantity: 0,
      averagePrice: 0,
      currentPrice: 0,
      marketValue: 0,
      unrealizedPnl: 0,
      unrealizedPnlBps: 0,
    })).toBe(false);
  });
});

describe("hasUnresolvedUnknownOrders", () => {
  it("ignores historical unknown rows whose remaining quantity is zero", () => {
    expect(hasUnresolvedUnknownOrders([
      { remainingQuantity: 0 },
      { remainingQuantity: 0 },
    ])).toBe(false);
  });

  it("blocks when any unknown order can still fill", () => {
    expect(hasUnresolvedUnknownOrders([
      { remainingQuantity: 0 },
      { remainingQuantity: 1 },
    ])).toBe(true);
  });
});
