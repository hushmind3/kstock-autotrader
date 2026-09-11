import { describe, expect, it } from "vitest";
import type { IntradayTradeSample, Quote, StrategyMarketSnapshot } from "@kstock/shared";
import { IntradayMomentumSettingsSchema, intradayMomentumStrategy } from "../src/intraday-momentum.js";

const startAt = Date.parse("2026-09-11T01:00:00.000Z");
const config = IntradayMomentumSettingsSchema.parse({});

function samples(stepSeconds = 5, finalSecond = 120): IntradayTradeSample[] {
  return Array.from({ length: Math.floor(finalSecond / stepSeconds) + 1 }, (_, index) => ({
    observedAt: new Date(startAt + index * stepSeconds * 1_000).toISOString(),
    price: index * stepSeconds === finalSecond ? 10_020 : 10_000,
    cumulativeVolume: 10_000 + index * stepSeconds * 100,
  }));
}

function quoteFor(sample: IntradayTradeSample): Quote {
  const koreanTime = new Date(Date.parse(sample.observedAt) + 9 * 3_600_000).toISOString();
  return {
    symbol: "005930",
    price: sample.price,
    cumulativeVolume: sample.cumulativeVolume,
    tradingDate: koreanTime.slice(0, 10),
    tradingTime: koreanTime.slice(11, 19).replaceAll(":", ""),
    receivedAt: sample.observedAt,
    source: "kiwoom",
    exchange: "KRX",
    brokerTimestampVerified: true,
  };
}

function snapshot(recentTradeSamples = samples(), hasPosition = false): StrategyMarketSnapshot {
  return {
    symbol: "005930",
    completedDailyBars: [],
    recentTradeSamples,
    quote: quoteFor(recentTradeSamples.at(-1)!),
    hasPosition,
  };
}

function setCurrentPrice(input: StrategyMarketSnapshot, price: number): StrategyMarketSnapshot {
  const updated = structuredClone(input);
  updated.recentTradeSamples!.at(-1)!.price = price;
  updated.quote!.price = price;
  return updated;
}

describe("intradayMomentumStrategy", () => {
  it("buys a confirmed short-window breakout using real time coverage and no daily bars", () => {
    expect(intradayMomentumStrategy.requirements(config)).toEqual({
      minimumDailyBars: 0,
      needsCurrentPrice: true,
      needsCumulativeVolume: true,
      intradayWindowSeconds: 120,
    });
    const input = snapshot();
    const before = structuredClone(input);
    expect(intradayMomentumStrategy.evaluate(input, config)).toMatchObject({
      action: "BUY",
      metrics: {
        collectedSeconds: 120, requiredSeconds: 120, sampleCount: 25,
        shortMa: 10_000, recentHigh: 10_000, momentumBps: 20,
        windowVolume: 12_000, largestGapSeconds: 5,
      },
    });
    expect(input).toEqual(before);
  });

  it("reports the required observation time when there is no actual stream", () => {
    const input = snapshot();
    delete input.recentTradeSamples;
    expect(intradayMomentumStrategy.evaluate(input, config)).toMatchObject({
      action: "NOT_READY", reasonCodes: ["INTRADAY_SAMPLES_MISSING"],
      metrics: { collectedSeconds: 0, requiredSeconds: 120, sampleCount: 0 },
    });
  });

  it("does not mistake enough samples collected in only 19 seconds for a two-minute window", () => {
    expect(intradayMomentumStrategy.evaluate(snapshot(samples(1, 19)), config)).toMatchObject({
      action: "NOT_READY", reasonCodes: ["INTRADAY_WINDOW_INCOMPLETE"],
      metrics: { collectedSeconds: 19, requiredSeconds: 120, sampleCount: 20 },
    });
  });

  it("requires the configured sample count even if the actual time span is long enough", () => {
    expect(intradayMomentumStrategy.evaluate(snapshot(samples(20)), config)).toMatchObject({
      action: "NOT_READY", reasonCodes: ["INTRADAY_WINDOW_INCOMPLETE"],
      metrics: { collectedSeconds: 120, sampleCount: 7 },
    });
  });

  it("rejects a missing middle section rather than filling a stream gap", () => {
    const stream = samples(1).filter((_sample, index) => index <= 30 || index >= 90);
    expect(intradayMomentumStrategy.evaluate(snapshot(stream), config)).toMatchObject({
      action: "NOT_READY", reasonCodes: ["INTRADAY_SAMPLE_GAP"],
      metrics: { collectedSeconds: 120, sampleCount: 62, largestGapSeconds: 60 },
    });
  });

  it("requires enough observations inside the short window as well", () => {
    const stream = samples().filter((_sample, index) => index <= 17 || index === 20 || index === 24);
    expect(intradayMomentumStrategy.evaluate(snapshot(stream), config)).toMatchObject({
      action: "NOT_READY", reasonCodes: ["INTRADAY_SHORT_WINDOW_INCOMPLETE"],
    });
  });

  it("does not buy when cumulative volume has not increased", () => {
    const stream = samples().map((sample) => ({ ...sample, cumulativeVolume: 10_000 }));
    expect(intradayMomentumStrategy.evaluate(snapshot(stream), config)).toMatchObject({
      action: "HOLD", reasonCodes: ["INTRADAY_VOLUME_TOO_LOW"], metrics: { windowVolume: 0 },
    });
  });

  it("rejects a cumulative-volume reset even if the latest value recovers", () => {
    const stream = samples();
    stream[12]!.cumulativeVolume = 100;
    expect(intradayMomentumStrategy.evaluate(snapshot(stream), config)).toMatchObject({
      action: "NOT_READY", reasonCodes: ["INTRADAY_VOLUME_RESET"],
    });
  });

  it("sells a held position below the historical short average even when entry volume is absent", () => {
    const stream = samples().map((sample) => ({ ...sample, cumulativeVolume: 10_000 }));
    const input = setCurrentPrice(snapshot(stream, true), 9_980);
    expect(intradayMomentumStrategy.evaluate(input, config)).toMatchObject({
      action: "SELL", reasonCodes: ["PRICE_BELOW_INTRADAY_SHORT_MA"], metrics: { shortMa: 10_000, windowVolume: 0 },
    });
    expect(intradayMomentumStrategy.evaluate(snapshot(samples(), true), config)).toMatchObject({
      action: "HOLD", reasonCodes: ["INTRADAY_EXIT_NOT_MET"],
    });
  });

  it("rejects future samples instead of using them to manufacture a signal", () => {
    const input = snapshot();
    input.recentTradeSamples!.push({ observedAt: "2026-09-11T01:02:01.000Z", price: 10_030, cumulativeVolume: 22_100 });
    expect(intradayMomentumStrategy.evaluate(input, config)).toMatchObject({
      action: "NOT_READY", reasonCodes: ["INTRADAY_SAMPLE_IN_FUTURE"],
    });
  });

  it("rejects a quote that extends an older stream without its own matching sample", () => {
    const input = snapshot();
    input.quote!.tradingTime = "100201";
    input.quote!.receivedAt = "2026-09-11T01:02:01.000Z";
    expect(intradayMomentumStrategy.evaluate(input, config)).toMatchObject({
      action: "NOT_READY", reasonCodes: ["QUOTE_SAMPLE_MISMATCH"],
    });
  });

  it.each(["price", "cumulativeVolume"] as const)("rejects a latest quote whose %s differs from its real stream sample", (field) => {
    const input = snapshot();
    input.quote![field] += 1;
    expect(intradayMomentumStrategy.evaluate(input, config)).toMatchObject({
      action: "NOT_READY", reasonCodes: ["QUOTE_SAMPLE_MISMATCH"],
    });
  });

  it("rejects duplicate and out-of-order samples without sorting or deduplicating them", () => {
    const duplicate = snapshot();
    duplicate.recentTradeSamples!.splice(5, 0, { ...duplicate.recentTradeSamples![5]! });
    expect(intradayMomentumStrategy.evaluate(duplicate, config)).toMatchObject({
      action: "NOT_READY", reasonCodes: ["INTRADAY_SAMPLES_OUT_OF_ORDER"],
    });
    const reversed = snapshot();
    reversed.recentTradeSamples!.reverse();
    expect(intradayMomentumStrategy.evaluate(reversed, config)).toMatchObject({
      action: "NOT_READY", reasonCodes: ["INTRADAY_SAMPLES_OUT_OF_ORDER"],
    });
  });

  it("does not allow multiple observations from the same second to satisfy sample requirements", () => {
    const input = snapshot();
    input.recentTradeSamples!.splice(2, 0, {
      ...input.recentTradeSamples![1]!, observedAt: "2026-09-11T01:00:05.500Z",
    });
    expect(intradayMomentumStrategy.evaluate(input, config)).toMatchObject({
      action: "NOT_READY", reasonCodes: ["INTRADAY_SAMPLES_SAME_SECOND"],
    });
  });

  it("rejects invalid prices, volumes, or calendar timestamps", () => {
    for (const invalid of [
      { price: Number.NaN }, { price: Infinity }, { cumulativeVolume: -1 },
      { cumulativeVolume: Number.NaN }, { observedAt: "2026-02-30T01:00:00.000Z" },
    ]) {
      const input = snapshot();
      Object.assign(input.recentTradeSamples![3]!, invalid);
      expect(intradayMomentumStrategy.evaluate(input, config)).toMatchObject({
        action: "NOT_READY", reasonCodes: ["INTRADAY_SAMPLE_INVALID"],
      });
    }
  });

  it("requires a current verified quote with a matching symbol and reasonable receipt time", () => {
    for (const changes of [
      { stale: true }, { brokerTimestampVerified: false }, { symbol: "000660" },
      { price: Number.NaN }, { cumulativeVolume: 0 }, { tradingTime: "250000" },
      { receivedAt: "2026-09-11T01:03:00.000Z" }, { receivedAt: "2026-09-11T01:01:59.000Z" },
    ]) {
      const input = snapshot();
      Object.assign(input.quote!, changes);
      expect(intradayMomentumStrategy.evaluate(input, config).action).toBe("NOT_READY");
    }
  });

  it("blocks a steeply declining background trend despite a small current breakout", () => {
    const stream = samples().map((sample, index) => ({ ...sample, price: index < 12 ? 10_050 : sample.price }));
    expect(intradayMomentumStrategy.evaluate(snapshot(stream), config)).toMatchObject({
      action: "HOLD", reasonCodes: ["INTRADAY_TREND_DECLINING"],
    });
  });

  it("blocks a weak move, a missing high breakout, and excessive extension", () => {
    expect(intradayMomentumStrategy.evaluate(setCurrentPrice(snapshot(), 10_005), config).reasonCodes)
      .toContain("INTRADAY_MOMENTUM_TOO_LOW");
    expect(intradayMomentumStrategy.evaluate(setCurrentPrice(snapshot(), 10_000), config).reasonCodes)
      .toContain("INTRADAY_HIGH_NOT_BROKEN");
    expect(intradayMomentumStrategy.evaluate(setCurrentPrice(snapshot(), 10_100), config)).toMatchObject({
      action: "HOLD", reasonCodes: ["INTRADAY_PRICE_EXTENDED"],
    });
  });

  it("validates compatible observation settings and exposes their defaults", () => {
    for (const invalid of [
      { lookbackSeconds: 30, shortWindowSeconds: 30 },
      { shortWindowSeconds: 20, maxGapSeconds: 20 },
      { lookbackSeconds: 30, shortWindowSeconds: 10, maxGapSeconds: 5, minSamples: 32 },
      { entryMomentumBps: 100, maxExtensionBps: 80 },
    ]) expect(() => IntradayMomentumSettingsSchema.parse(invalid)).toThrow();
    for (const field of intradayMomentumStrategy.configFields!) {
      expect(config[field.key as keyof typeof config]).toBe(field.defaultValue);
    }
  });
});
