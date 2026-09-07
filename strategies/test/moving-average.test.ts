import { describe, expect, it } from "vitest";
import { MovingAverageSettingsSchema, type DailyBar, type Quote } from "@kstock/shared";
import { movingAverageStrategy } from "../src/moving-average.js";

function bars(prices: number[], volume = 200_000): DailyBar[] {
  return prices.map((close, index) => ({
    symbol: "005930",
    tradingDate: `2026-01-${String(index + 1).padStart(2, "0")}`,
    open: close,
    high: close,
    low: close,
    close,
    volume,
    adjusted: true,
  }));
}

function quote(price: number, volume = 200_000): Quote {
  return {
    symbol: "005930",
    price,
    cumulativeVolume: volume,
    tradingDate: "2026-08-31",
    tradingTime: "100000",
    receivedAt: "2026-08-31T01:00:00.000Z",
    source: "kiwoom",
  };
}

describe("movingAverageStrategy", () => {
  const config = MovingAverageSettingsSchema.parse({ minAverageVolume: 100_000 });

  it("returns BUY when deterministic entry conditions pass", () => {
    const decision = movingAverageStrategy.evaluate(
      {
        symbol: "005930",
        completedDailyBars: bars(Array.from({ length: 70 }, (_, index) => 50_000 + index * 100)),
        quote: quote(58_000),
        hasPosition: false,
      },
      config,
    );
    expect(decision.action).toBe("BUY");
  });

  it("returns SELL for a held position below its short moving average", () => {
    const decision = movingAverageStrategy.evaluate(
      {
        symbol: "005930",
        completedDailyBars: bars(Array.from({ length: 70 }, (_, index) => 50_000 + index * 100)),
        quote: quote(40_000),
        hasPosition: true,
      },
      config,
    );
    expect(decision.action).toBe("SELL");
    expect(decision.reasonCodes).toContain("PRICE_BELOW_SHORT_MA");
  });

  it("does not invent a decision without enough confirmed bars", () => {
    const decision = movingAverageStrategy.evaluate(
      { symbol: "005930", completedDailyBars: bars([1, 2, 3]), quote: quote(4), hasPosition: false },
      config,
    );
    expect(decision.action).toBe("NOT_READY");
  });
});
