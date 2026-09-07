import { describe, expect, it } from "vitest";
import type { DerivativeDailyBar } from "@kstock/broker-kis-derivatives";
import { planDirectionalMovingAverage } from "../src/derivatives/directional-planner.js";

function bars(closes: readonly number[]): DerivativeDailyBar[] {
  return closes.map((close, index) => ({
    tradingDate: `202608${String(index + 1).padStart(2, "0")}`,
    open: close,
    high: close,
    low: close,
    close,
    volume: 1,
    raw: {},
  }));
}

const baseInput = {
  fastPeriod: 3,
  slowPeriod: 5,
  minimumGapBps: 50,
  sideMode: "BOTH" as const,
  targetContracts: 2,
  currentDirectionalQuantity: 0,
  currentHedgeQuantity: 0,
  brokerNetQuantity: 0,
};

describe("directional futures moving-average planner", () => {
  it("waits without inventing a signal when completed history is insufficient", () => {
    const result = planDirectionalMovingAverage({
      ...baseInput,
      bars: bars([100, 101, 102, 103]),
    });

    expect(result).toEqual({
      signal: "WAITING_FOR_HISTORY",
      fastAverage: null,
      slowAverage: null,
      gapBps: null,
      currentDirectionalQuantity: 0,
      targetDirectionalQuantity: 0,
      targetBrokerNetQuantity: 0,
      orders: [],
    });
  });

  it("sorts valid daily bars and opens long only after the configured upward gap", () => {
    const unordered = bars([100, 100, 100, 110, 120]).reverse();
    unordered.push({ ...unordered[0]!, tradingDate: "bad-date", close: 999 });
    unordered.push({ ...unordered[0]!, tradingDate: "20260731", close: 0 });

    const result = planDirectionalMovingAverage({ ...baseInput, bars: unordered });

    expect(result.signal).toBe("LONG");
    expect(result.fastAverage).toBe(110);
    expect(result.slowAverage).toBe(106);
    expect(result.gapBps).toBe(377);
    expect(result.targetDirectionalQuantity).toBe(2);
    expect(result.targetBrokerNetQuantity).toBe(2);
    expect(result.orders).toEqual([
      { purpose: "DIRECTIONAL", action: "OPEN", direction: "LONG", quantity: 2 },
    ]);
  });

  it("opens short for a downward gap and respects long-only mode by staying flat", () => {
    const fallingBars = bars([120, 110, 100, 90, 80]);
    const both = planDirectionalMovingAverage({ ...baseInput, bars: fallingBars });
    const longOnly = planDirectionalMovingAverage({
      ...baseInput,
      bars: fallingBars,
      sideMode: "LONG_ONLY",
    });

    expect(both.signal).toBe("SHORT");
    expect(both.orders).toEqual([
      { purpose: "DIRECTIONAL", action: "OPEN", direction: "SHORT", quantity: 2 },
    ]);
    expect(longOnly).toMatchObject({
      signal: "FLAT",
      targetDirectionalQuantity: 0,
      orders: [],
    });
  });

  it("plans the physical broker transition while keeping the hedge allocation unchanged", () => {
    const result = planDirectionalMovingAverage({
      ...baseInput,
      bars: bars([100, 100, 100, 110, 120]),
      currentDirectionalQuantity: -2,
      currentHedgeQuantity: -1,
      brokerNetQuantity: -3,
    });

    expect(result).toMatchObject({
      signal: "LONG",
      currentDirectionalQuantity: -2,
      targetDirectionalQuantity: 2,
      targetBrokerNetQuantity: 1,
    });
    expect(result.orders).toEqual([
      { purpose: "DIRECTIONAL", action: "CLOSE", direction: "SHORT", quantity: 3 },
      { purpose: "DIRECTIONAL", action: "OPEN", direction: "LONG", quantity: 1 },
    ]);
  });

  it("closes an existing directional position when the averages are inside the dead band", () => {
    const result = planDirectionalMovingAverage({
      ...baseInput,
      bars: bars([100, 100, 100, 100, 100]),
      currentDirectionalQuantity: 2,
      currentHedgeQuantity: -1,
      brokerNetQuantity: 1,
    });

    expect(result).toMatchObject({
      signal: "FLAT",
      targetDirectionalQuantity: 0,
      targetBrokerNetQuantity: -1,
    });
    expect(result.orders).toEqual([
      { purpose: "DIRECTIONAL", action: "CLOSE", direction: "LONG", quantity: 1 },
      { purpose: "DIRECTIONAL", action: "OPEN", direction: "SHORT", quantity: 1 },
    ]);
  });
});
