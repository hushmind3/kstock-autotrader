import { describe, expect, it } from "vitest";
import type { DailyBar, Quote } from "@kstock/shared";
import { BreakoutVolumeSettingsSchema, breakoutVolumeStrategy } from "../src/breakout-volume.js";

function bars(count = 20): DailyBar[] {
  return Array.from({ length: count }, (_, index) => ({
    symbol: "005930",
    tradingDate: `2026-07-${String(index + 1).padStart(2, "0")}`,
    open: 95,
    high: 100,
    low: 90,
    close: 95,
    volume: 200_000,
    adjusted: true,
  }));
}

function quote(price: number, cumulativeVolume = 200_000): Quote {
  return {
    symbol: "005930",
    price,
    cumulativeVolume,
    tradingDate: "2026-09-04",
    tradingTime: "100000",
    receivedAt: "2026-09-04T01:00:00.000Z",
    source: "kiwoom",
  };
}

describe("breakoutVolumeStrategy", () => {
  const config = BreakoutVolumeSettingsSchema.parse({});

  it("buys only after both price breakout and volume confirmation", () => {
    expect(breakoutVolumeStrategy.evaluate({ symbol: "005930", completedDailyBars: bars(), quote: quote(101), hasPosition: false }, config).action).toBe("BUY");
    expect(breakoutVolumeStrategy.evaluate({ symbol: "005930", completedDailyBars: bars(), quote: quote(99), hasPosition: false }, config).action).toBe("HOLD");
    expect(breakoutVolumeStrategy.evaluate({ symbol: "005930", completedDailyBars: bars(), quote: quote(101, 10_000), hasPosition: false }, config).action).toBe("HOLD");
  });

  it("sells a held position below the configured recent low", () => {
    expect(breakoutVolumeStrategy.evaluate({ symbol: "005930", completedDailyBars: bars(), quote: quote(89), hasPosition: true }, config)).toMatchObject({
      action: "SELL",
      reasonCodes: ["PRICE_BELOW_BREAKOUT_EXIT_LOW"],
    });
  });
});
