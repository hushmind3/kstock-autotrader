import { describe, expect, it } from "vitest";
import type { DailyBar, Quote } from "@kstock/shared";
import { RsiBollingerSettingsSchema, rsiBollingerReboundStrategy } from "../src/rsi-bollinger-rebound.js";

const bars: DailyBar[] = Array.from({ length: 20 }, (_, index) => ({
  symbol: "005930",
  tradingDate: `2026-07-${String(index + 1).padStart(2, "0")}`,
  open: 100,
  high: 100,
  low: 100,
  close: 100,
  volume: 200_000,
  adjusted: true,
}));

function quote(price: number): Quote {
  return {
    symbol: "005930",
    price,
    cumulativeVolume: 200_000,
    tradingDate: "2026-09-04",
    tradingTime: "100000",
    receivedAt: "2026-09-04T01:00:00.000Z",
    source: "kiwoom",
  };
}

describe("rsiBollingerReboundStrategy", () => {
  const config = RsiBollingerSettingsSchema.parse({});

  it("finds a deterministic oversold lower-band entry", () => {
    expect(rsiBollingerReboundStrategy.evaluate({ symbol: "005930", completedDailyBars: bars, quote: quote(50), hasPosition: false }, config)).toMatchObject({
      action: "BUY",
      reasonCodes: ["RSI_OVERSOLD", "PRICE_AT_LOWER_BAND", "VOLUME_ACCEPTABLE"],
    });
  });

  it("exits a held position in the overbought upper-band area", () => {
    expect(rsiBollingerReboundStrategy.evaluate({ symbol: "005930", completedDailyBars: bars, quote: quote(150), hasPosition: true }, config).action).toBe("SELL");
  });

  it("does not buy an ordinary middle-band price", () => {
    expect(rsiBollingerReboundStrategy.evaluate({ symbol: "005930", completedDailyBars: bars, quote: quote(100), hasPosition: false }, config).action).toBe("HOLD");
  });
});
