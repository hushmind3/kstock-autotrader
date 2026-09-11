import { describe, expect, it } from "vitest";
import type { DailyBar, Quote, StrategyMarketSnapshot } from "@kstock/shared";
import { PullbackReboundSettingsSchema, pullbackReboundStrategy } from "../src/pullback-rebound.js";

function bars(prices: number[], volume = 200_000): DailyBar[] {
  return prices.map((close, index) => ({
    symbol: "005930",
    tradingDate: new Date(Date.UTC(2026, 5, index + 1)).toISOString().slice(0, 10),
    open: close,
    high: close + 1,
    low: close - 1,
    close,
    volume,
    adjusted: true,
  }));
}

function quote(price = 104): Quote {
  return {
    symbol: "005930",
    price,
    cumulativeVolume: 0,
    tradingDate: "2026-09-10",
    tradingTime: "100000",
    receivedAt: "2026-09-10T01:00:00.000Z",
    source: "kiwoom",
  };
}

const config = PullbackReboundSettingsSchema.parse({
  shortPeriod: 3,
  longPeriod: 6,
  pullbackLookbackDays: 3,
  slopeLookbackDays: 2,
  volumeLookbackDays: 5,
});

function snapshot(overrides: Partial<StrategyMarketSnapshot> = {}): StrategyMarketSnapshot {
  return {
    symbol: "005930",
    completedDailyBars: bars([98, 99, 100, 101, 102, 104, 103, 101]),
    quote: quote(),
    hasPosition: false,
    ...overrides,
  };
}

describe("pullbackReboundStrategy", () => {
  it("buys a fresh reclaim after a completed pullback using only daily average volume", () => {
    expect(pullbackReboundStrategy.evaluate(snapshot(), config)).toMatchObject({
      action: "BUY",
      reasonCodes: ["RECENT_PULLBACK", "REBOUND_CONFIRMED", "LONG_MA_ACCEPTABLE", "VOLUME_ACCEPTABLE"],
      metrics: { averageVolume: 200_000, pullbackDate: "2026-06-08", completedThrough: "2026-06-08" },
    });
    expect(pullbackReboundStrategy.requirements(config)).toEqual({
      minimumDailyBars: 8,
      needsCurrentPrice: true,
      needsCumulativeVolume: false,
    });
  });

  it("requires enough history for every rolling average and historical pullback", () => {
    expect(pullbackReboundStrategy.requirements(PullbackReboundSettingsSchema.parse({})).minimumDailyBars).toBe(43);
    expect(pullbackReboundStrategy.requirements({ ...config, pullbackLookbackDays: 10 }).minimumDailyBars).toBe(13);
    expect(pullbackReboundStrategy.evaluate(snapshot({ completedDailyBars: snapshot().completedDailyBars.slice(1) }), config))
      .toMatchObject({ action: "NOT_READY", metrics: { availableBars: 7, requiredBars: 8 } });
  });

  it("waits while the price has not reclaimed the short moving average", () => {
    const result = pullbackReboundStrategy.evaluate(snapshot({ quote: quote(102) }), config);
    expect(result.action).toBe("HOLD");
    expect(result.reasonCodes).toContain("REBOUND_NOT_CONFIRMED");
  });

  it("requires a recent real decline rather than an uninterrupted rise", () => {
    const result = pullbackReboundStrategy.evaluate(snapshot({
      completedDailyBars: bars([98, 99, 100, 101, 102, 103, 104, 105]),
      quote: quote(106),
    }), config);
    expect(result.action).toBe("HOLD");
    expect(result.reasonCodes).toContain("NO_RECENT_PULLBACK");
    expect(result.reasonCodes).toContain("REBOUND_ALREADY_ESTABLISHED");
  });

  it("expires an old pullback once it leaves the configured lookback", () => {
    const input = snapshot({
      completedDailyBars: bars([98, 99, 100, 105, 104, 101, 101, 101]),
      quote: quote(104),
    });
    expect(pullbackReboundStrategy.evaluate(input, config).action).toBe("BUY");
    const result = pullbackReboundStrategy.evaluate(input, { ...config, pullbackLookbackDays: 2 });
    expect(result.action).toBe("HOLD");
    expect(result.reasonCodes).toContain("NO_RECENT_PULLBACK");
  });

  it("blocks a sharp long-term decline and a quote below the long average", () => {
    const result = pullbackReboundStrategy.evaluate(snapshot({
      completedDailyBars: bars([120, 118, 116, 114, 110, 108, 105, 102]),
      quote: quote(107),
    }), config);
    expect(result.action).toBe("HOLD");
    expect(result.reasonCodes).toContain("LONG_MA_DECLINING");
    expect(result.reasonCodes).toContain("PRICE_BELOW_LONG_MA");
  });

  it("blocks chasing an excessive rebound and low daily liquidity", () => {
    const chasing = pullbackReboundStrategy.evaluate(snapshot({ quote: quote(110) }), config);
    expect(chasing.action).toBe("HOLD");
    expect(chasing.reasonCodes).toContain("PRICE_TOO_FAR_ABOVE_SHORT_MA");
    const illiquid = pullbackReboundStrategy.evaluate(snapshot({
      completedDailyBars: bars([98, 99, 100, 101, 102, 104, 103, 101], 10_000),
    }), config);
    expect(illiquid.action).toBe("HOLD");
    expect(illiquid.reasonCodes).toContain("AVERAGE_VOLUME_TOO_LOW");
  });

  it("sells a short-average breakdown even if the entry liquidity filter fails", () => {
    expect(pullbackReboundStrategy.evaluate(snapshot({
      hasPosition: true,
      quote: quote(100),
      completedDailyBars: bars([98, 99, 100, 101, 102, 104, 103, 101], 0),
    }), config)).toMatchObject({ action: "SELL", reasonCodes: ["PRICE_BELOW_SHORT_MA"] });
    expect(pullbackReboundStrategy.evaluate(snapshot({ hasPosition: true }), config))
      .toMatchObject({ action: "HOLD", reasonCodes: ["PULLBACK_EXIT_NOT_MET"] });
  });

  it("ignores same-day unfinished and future bars without mutating input", () => {
    const baseline = snapshot();
    const polluted = snapshot({ completedDailyBars: [
      { ...baseline.completedDailyBars[0]!, tradingDate: "2026-09-10", close: 1_000 },
      ...baseline.completedDailyBars.toReversed(),
      { ...baseline.completedDailyBars[0]!, tradingDate: "2026-09-11", close: 1_000 },
    ] });
    const before = structuredClone(polluted);
    expect(pullbackReboundStrategy.evaluate(polluted, config)).toEqual(pullbackReboundStrategy.evaluate(baseline, config));
    expect(polluted).toEqual(before);
  });

  it("does not count unfinished, future, wrong-symbol, or duplicate bars toward history", () => {
    const input = snapshot();
    const history = input.completedDailyBars.slice(0, -1);
    for (const invalid of [
      { ...input.completedDailyBars.at(-1)!, tradingDate: "2026-09-10" },
      { ...input.completedDailyBars.at(-1)!, tradingDate: "2026-09-11" },
      { ...input.completedDailyBars.at(-1)!, symbol: "000660" },
      input.completedDailyBars[0]!,
    ]) {
      expect(pullbackReboundStrategy.evaluate(snapshot({ completedDailyBars: [...history, invalid] }), config).action).toBe("NOT_READY");
    }
  });

  it("returns NOT_READY for missing or invalid quotes and malformed OHLCV", () => {
    for (const invalidQuote of [null, quote(Number.NaN), quote(Infinity), { ...quote(), stale: true }, { ...quote(), tradingDate: "2026-02-30" }]) {
      expect(pullbackReboundStrategy.evaluate(snapshot({ quote: invalidQuote }), config).action).toBe("NOT_READY");
    }
    for (const changes of [{ volume: Number.NaN }, { low: 200 }, { close: Infinity }]) {
      const history = snapshot().completedDailyBars;
      history[history.length - 1] = { ...history.at(-1)!, ...changes };
      expect(pullbackReboundStrategy.evaluate(snapshot({ completedDailyBars: history }), config))
        .toMatchObject({ action: "NOT_READY", reasonCodes: ["INVALID_DAILY_BARS"] });
    }
  });

  it("rejects incompatible settings and exposes editable defaults consistently", () => {
    expect(() => PullbackReboundSettingsSchema.parse({ shortPeriod: 40, longPeriod: 20 })).toThrow();
    expect(() => PullbackReboundSettingsSchema.parse({ reboundBufferBps: 200, maxPriceVsShortMaBps: 100 })).toThrow();
    const defaults = PullbackReboundSettingsSchema.parse({});
    for (const field of pullbackReboundStrategy.configFields!) {
      expect(defaults[field.key as keyof typeof defaults]).toBe(field.defaultValue);
    }
  });
});
