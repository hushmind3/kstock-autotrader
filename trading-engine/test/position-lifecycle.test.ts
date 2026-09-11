import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInMemoryTradingRepository, openTradingRepository, type FillRecord } from "@kstock/database";
import type { BrokerPosition, Quote, StrategyDecision } from "@kstock/shared";
import { PositionLifecycle, verifiedQuoteObservedAt } from "../src/core/position-lifecycle.js";
import { MarketClock } from "../src/core/market-clock.js";

const scope = { brokerId: "kiwoom", environment: "live", accountId: "lifecycle-test" } as const;
const position: BrokerPosition = {
  symbol: "005930", quantity: 10, availableQuantity: 10, averagePrice: 10_000,
  currentPrice: 10_000, marketValue: 100_000, unrealizedPnl: 0, unrealizedPnlBps: 0,
};
const buy: StrategyDecision = { action: "BUY", reasonCodes: ["ENTRY"], metrics: {} };
const hold: StrategyDecision = { action: "HOLD", reasonCodes: ["NO_ENTRY"], metrics: {} };
const sell: StrategyDecision = { action: "SELL", reasonCodes: ["TRAILING_PROFIT_TRIGGERED"], metrics: {} };
const openedAt = "2026-09-03T01:00:00.000Z";
const soldAt = "2026-09-03T02:00:00.000Z";

function quote(price: number, receivedAt: string): Quote {
  const localTime = new Date(Date.parse(receivedAt) + 9 * 3_600_000).toISOString();
  return { symbol: position.symbol, price, high: 99_999, cumulativeVolume: 100_000,
    source: "kiwoom", tradingDate: localTime.slice(0, 10), tradingTime: localTime.slice(11, 19).replaceAll(":", ""),
    brokerTimestampVerified: true, receivedAt };
}
function fill(side: "buy" | "sell", quantity: number, executedAt: string): FillRecord {
  return { id: `${side}-${executedAt}`, scope, orderId: "test-order", brokerExecutionId: "test-fill",
    brokerOrderId: "test-broker-order", symbol: position.symbol, side, quantity, price: 10_000,
    fee: 0, tax: 0, executedAt, receivedAt: executedAt, raw: null };
}
const repositories: ReturnType<typeof createInMemoryTradingRepository>[] = [];
function setup() {
  const repository = createInMemoryTradingRepository();
  repositories.push(repository);
  const lifecycle = new PositionLifecycle(repository);
  lifecycle.synchronize(scope, [position], [], openedAt);
  return { repository, lifecycle };
}
afterEach(() => { for (const repository of repositories.splice(0)) repository.close(); });

describe("durable position cycles", () => {
  it("restores peaks, exit decisions and reentry gates after closing and reopening a SQLite file", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "kstock-position-cycle-test-"));
    const filename = path.join(directory, "cycles.sqlite");
    let repository = openTradingRepository(filename);
    try {
      let lifecycle = new PositionLifecycle(repository);
      lifecycle.synchronize(scope, [position], [], openedAt);
      lifecycle.observeQuote(scope, quote(11_000, "2026-09-03T01:01:00.000Z"));
      lifecycle.rememberExit(scope, position.symbol, sell, "exit-settings");
      repository.close();
      repository = openTradingRepository(filename);
      lifecycle = new PositionLifecycle(repository);
      expect(lifecycle.get(scope, position.symbol)).toMatchObject({ peakPrice: 11_000, exitDecision: sell, exitPolicyKey: "exit-settings" });
      lifecycle.synchronize(scope, [], [fill("sell", 10, soldAt)], soldAt);
      lifecycle.filterReentry(scope, position.symbol, hold, 30, "2026-09-03T02:01:00.000Z");
      repository.close();
      repository = openTradingRepository(filename);
      lifecycle = new PositionLifecycle(repository);
      expect(lifecycle.filterReentry(scope, position.symbol, buy, 30, "2026-09-03T02:15:00.000Z").reasonCodes).toEqual(["REENTRY_COOLDOWN"]);
      expect(lifecycle.filterReentry(scope, position.symbol, buy, 30, "2026-09-03T02:31:00.000Z")).toEqual(buy);
    } finally {
      repository.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("preserves observed peaks and latched exits across reconstruction and partial sales", () => {
    const { repository, lifecycle } = setup();
    lifecycle.observeQuote(scope, quote(11_000, "2026-09-03T01:01:00.000Z"));
    lifecycle.observeQuote(scope, quote(20_000, "2026-09-03T00:59:00.000Z"));
    lifecycle.observeQuote(scope, { ...quote(20_000, "2026-09-03T01:03:00.000Z"), tradingTime: "095959" });
    lifecycle.rememberExit(scope, position.symbol, sell);
    const restored = new PositionLifecycle(repository);
    restored.synchronize(scope, [{ ...position, quantity: 6, availableQuantity: 6 }], [fill("sell", 4, soldAt)], soldAt);
    expect(restored.get(scope, position.symbol)).toMatchObject({
      quantity: 6, openedAt, peakPrice: 11_000, exitDecision: sell, lastExitAt: null,
    });
    expect(restored.get({ ...scope, accountId: "another-account" }, position.symbol)).toBeNull();
  });

  it("requires both elapsed cooldown and a new observed neutral-to-buy signal after closing", () => {
    const { repository, lifecycle } = setup();
    lifecycle.synchronize(scope, [], [fill("sell", 10, soldAt)], soldAt);
    const restored = new PositionLifecycle(repository);
    expect(restored.filterReentry(scope, position.symbol, buy, 30, "2026-09-03T02:31:00.000Z").reasonCodes)
      .toEqual(["REENTRY_WAIT_FOR_NEW_SIGNAL"]);
    restored.filterReentry(scope, position.symbol, hold, 30, "2026-09-03T02:01:00.000Z", false);
    restored.filterReentry(scope, position.symbol, { ...hold, action: "NOT_READY" }, 30, "2026-09-03T02:02:00.000Z");
    expect(restored.filterReentry(scope, position.symbol, buy, 0, "2026-09-03T02:31:00.000Z").action).toBe("HOLD");
    restored.filterReentry(scope, position.symbol, hold, 30, "2026-09-03T02:10:00.000Z");
    expect(restored.filterReentry(scope, position.symbol, buy, 30, "2026-09-03T02:15:00.000Z").reasonCodes).toEqual(["REENTRY_COOLDOWN"]);
    expect(new PositionLifecycle(repository).filterReentry(scope, position.symbol, buy, 30, "2026-09-03T02:30:00.000Z")).toEqual(buy);
    restored.synchronize(scope, [position], [fill("buy", 10, "2026-09-03T02:31:00.000Z"), fill("sell", 10, soldAt)], "2026-09-03T02:32:00.000Z");
    expect(restored.get(scope, position.symbol)).toMatchObject({ openedAt: "2026-09-03T02:31:00.000Z", peakPrice: 10_000, exitDecision: null });
  });

  it("does not move a recorded exit time forward on every account refresh", () => {
    const { lifecycle } = setup();
    lifecycle.synchronize(scope, [], [], soldAt);
    lifecycle.synchronize(scope, [], [], "2026-09-03T02:30:00.000Z");
    expect(lifecycle.get(scope, position.symbol)?.lastExitAt).toBe(soldAt);
  });

  it("does not mistake an old partial sale for the time of final liquidation", () => {
    const { lifecycle } = setup();
    const partialAt = "2026-09-03T01:10:00.000Z";
    const partial = fill("sell", 4, partialAt);
    lifecycle.synchronize(scope, [{ ...position, quantity: 6 }], [partial], "2026-09-03T01:11:00.000Z");
    lifecycle.synchronize(scope, [], [partial], soldAt);
    expect(lifecycle.get(scope, position.symbol)?.lastExitAt).toBe(soldAt);
    lifecycle.filterReentry(scope, position.symbol, hold, 30, "2026-09-03T02:01:00.000Z");
    expect(lifecycle.filterReentry(scope, position.symbol, buy, 30, "2026-09-03T02:02:00.000Z").reasonCodes).toEqual(["REENTRY_COOLDOWN"]);
  });

  it("ignores unverified peaks and delayed pre-exit neutral signals", () => {
    const { lifecycle } = setup();
    lifecycle.observeQuote(scope, { ...quote(20_000, "2026-09-03T01:01:00.000Z"), brokerTimestampVerified: false });
    expect(lifecycle.get(scope, position.symbol)?.peakPrice).toBe(10_000);
    lifecycle.synchronize(scope, [], [fill("sell", 10, soldAt)], soldAt);
    const delayed = { ...quote(10_000, "2026-09-03T02:00:02.000Z"), tradingTime: "105959" };
    lifecycle.filterReentry(scope, position.symbol, hold, 0, verifiedQuoteObservedAt(delayed)!);
    expect(lifecycle.filterReentry(scope, position.symbol, buy, 0, "2026-09-03T02:01:00.000Z").reasonCodes).toEqual(["REENTRY_WAIT_FOR_NEW_SIGNAL"]);
    expect(verifiedQuoteObservedAt({ ...delayed, tradingTime: "246100" })).toBeNull();
  });

  it("associates a persisted exit with the policy that produced it", () => {
    const { repository, lifecycle } = setup();
    lifecycle.rememberExit(scope, position.symbol, sell, "first-policy");
    const restored = new PositionLifecycle(repository);
    expect(restored.get(scope, position.symbol)?.exitPolicyKey).toBe("first-policy");
    restored.rememberExit(scope, position.symbol, null, "changed-policy");
    expect(lifecycle.get(scope, position.symbol)).toMatchObject({ exitDecision: null, exitPolicyKey: "changed-policy" });
  });

  it("restores the true entry date when known and conservatively resets a changed cost basis", () => {
    const { lifecycle } = setup();
    lifecycle.synchronize(scope, [position], [fill("buy", 10, openedAt)], "2026-09-03T01:01:00.000Z");
    lifecycle.observeQuote(scope, quote(11_000, "2026-09-03T01:02:00.000Z"));
    lifecycle.synchronize(scope, [{ ...position, averagePrice: 5_000, quantity: 20 }], [], "2026-09-03T01:03:00.000Z");
    expect(lifecycle.get(scope, position.symbol)).toMatchObject({ peakPrice: 5_000, openedAt: "2026-09-03T01:03:00.000Z" });
  });

  it("counts only full holding sessions, excluding holidays, weekends and the entry/current days", () => {
    const clock = new MarketClock();
    clock.applyOfficialCalendar([{ tradingDate: "2026-09-04", isOpen: false }]);
    expect(clock.completedHoldingSessions(openedAt, new Date("2026-09-10T01:00:00.000Z"))).toBe(3);
    expect(clock.completedHoldingSessions(openedAt, new Date(openedAt))).toBe(0);
  });
});
