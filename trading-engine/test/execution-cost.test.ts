import { describe, expect, it } from "vitest";
import { estimateExecutionCost } from "../src/core/execution-cost.js";

describe("observed execution cost", () => {
  it("keeps the configured estimate when real fills show a smaller cost", () => {
    expect(estimateExecutionCost([
      { side: "buy", quantity: 10, fillPrice: 10_010, referencePrice: 10_000, feeKrw: 0, taxKrw: 0 },
      { side: "sell", quantity: 10, fillPrice: 10_490, referencePrice: 10_500, feeKrw: 0, taxKrw: 0 },
    ], 30)).toMatchObject({ roundTripCostBps: 30, sampleCount: 2 });
  });

  it("raises the floor from adverse fill slippage and broker-reported costs", () => {
    const estimate = estimateExecutionCost([
      { side: "buy", quantity: 100, fillPrice: 10_020, referencePrice: 10_000, feeKrw: 100, taxKrw: 0 },
      { side: "sell", quantity: 100, fillPrice: 10_970, referencePrice: 11_000, feeKrw: 100, taxKrw: 1_500 },
    ], 30);
    expect(estimate.roundTripCostBps).toBeGreaterThan(30);
    expect(estimate.observedRoundTripCostBps).toBeGreaterThan(30);
    expect(estimate.sampleCount).toBe(2);
  });

  it("ignores favorable slippage and rows with no cost evidence", () => {
    expect(estimateExecutionCost([
      { side: "buy", quantity: 10, fillPrice: 9_990, referencePrice: 10_000, feeKrw: 0, taxKrw: 0 },
      { side: "sell", quantity: 10, fillPrice: 10_010, referencePrice: 10_000, feeKrw: 0, taxKrw: 0 },
      { side: "sell", quantity: 10, fillPrice: 10_000, feeKrw: 0, taxKrw: 0 },
    ], 30)).toEqual({ roundTripCostBps: 30, observedRoundTripCostBps: 0, sampleCount: 2 });
  });
});
