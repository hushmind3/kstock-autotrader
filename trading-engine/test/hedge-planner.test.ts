import { describe, expect, it } from "vitest";
import {
  planEquityExposureHedge,
  planEquityExposureHedgeFromLedger,
  type EquityHedgePlanInput,
} from "../src/derivatives/hedge-planner.js";

const baseInput: EquityHedgePlanInput = {
  equityExposureKrw: 300_000_000,
  futuresPriceTicks: 35_000,
  priceScale: 100,
  contractMultiplierKrw: 250_000,
  hedgeRatioBps: 10_000,
  existingHedgeSignedQuantity: 0,
  directionalSignedQuantity: 0,
  brokerNetQuantity: 0,
  minRebalanceContracts: 1,
};

describe("cash-equity futures hedge planner", () => {
  it("floors the target so a full hedge never exceeds long cash exposure", () => {
    const result = planEquityExposureHedge({
      ...baseInput,
      equityExposureKrw: 249_999_999,
    });

    // One contract is 350 * 250,000 = 87,500,000 KRW. Rounding to three
    // contracts would hedge 262,500,000 KRW and exceed the cash exposure.
    expect(result).toMatchObject({
      status: "ORDER_REQUIRED",
      targetHedgeSignedQuantity: -2,
      orderQuantity: 2,
      orders: [{ purpose: "HEDGE", action: "OPEN", direction: "SHORT", quantity: 2 }],
    });
  });

  it("sums multiple cash accounts before applying a partial hedge ratio", () => {
    const result = planEquityExposureHedge({
      ...baseInput,
      equityExposureKrw: [100_000_000, 75_000_000],
      hedgeRatioBps: 5_000,
    });

    expect(result.sourceEquityExposureKrw).toBe(175_000_000);
    expect(result.targetHedgeSignedQuantity).toBe(-1);
    expect(result.orders).toEqual([
      { purpose: "HEDGE", action: "OPEN", direction: "SHORT", quantity: 1 },
    ]);
  });

  it("closes excess shorts without changing the directional allocation", () => {
    const result = planEquityExposureHedge({
      ...baseInput,
      equityExposureKrw: 175_000_000,
      existingHedgeSignedQuantity: -3,
      directionalSignedQuantity: 2,
      brokerNetQuantity: -1,
    });

    expect(result).toMatchObject({
      targetHedgeSignedQuantity: -2,
      directionalSignedQuantity: 2,
      expectedBrokerNetQuantityAfterOrders: 0,
      orders: [{ purpose: "HEDGE", action: "CLOSE", direction: "SHORT", quantity: 1 }],
    });
  });

  it("changes the broker net directly when virtual hedge and directional lots offset", () => {
    const result = planEquityExposureHedge({
      ...baseInput,
      equityExposureKrw: 175_000_000,
      existingHedgeSignedQuantity: 1,
      directionalSignedQuantity: -1,
      brokerNetQuantity: 0,
    });

    // The broker is physically flat because +1 HEDGE and -1 DIRECTIONAL
    // offset. KIS therefore needs one OPEN SHORT 3 order; trying to close an
    // imaginary physical long would be rejected by the broker preflight.
    expect(result.orders).toEqual([
      { purpose: "HEDGE", action: "OPEN", direction: "SHORT", quantity: 3 },
    ]);
    expect(result.orderQuantity).toBe(3);
  });

  it("does not churn when the difference is below the configured threshold", () => {
    const result = planEquityExposureHedge({
      ...baseInput,
      equityExposureKrw: 350_000_000,
      existingHedgeSignedQuantity: -3,
      directionalSignedQuantity: 1,
      brokerNetQuantity: -2,
      minRebalanceContracts: 2,
    });

    expect(result).toMatchObject({
      status: "BELOW_REBALANCE_THRESHOLD",
      blocked: false,
      targetHedgeSignedQuantity: -4,
      expectedBrokerNetQuantityAfterOrders: -2,
      orderQuantity: 0,
      orders: [],
      reasons: ["REBALANCE_THRESHOLD_NOT_MET"],
    });
  });

  it("blocks every order when broker net differs from HEDGE plus DIRECTIONAL", () => {
    const result = planEquityExposureHedge({
      ...baseInput,
      existingHedgeSignedQuantity: -2,
      directionalSignedQuantity: 1,
      brokerNetQuantity: 0,
    });

    expect(result).toMatchObject({
      status: "BLOCKED",
      blocked: true,
      allocatedNetQuantity: -1,
      brokerNetQuantity: 0,
      orderQuantity: 0,
      orders: [],
    });
    expect(result.reasons).toContain("PURPOSE_LEDGER_MISMATCH");
  });

  it.each([
    ["zero futures price", { futuresPriceTicks: 0 }, "INVALID_FUTURES_PRICE_TICKS"],
    ["zero price scale", { priceScale: 0 }, "INVALID_PRICE_SCALE"],
    ["zero multiplier", { contractMultiplierKrw: 0 }, "INVALID_CONTRACT_MULTIPLIER"],
    ["zero ratio", { hedgeRatioBps: 0 }, "INVALID_HEDGE_RATIO"],
    ["over-100% ratio", { hedgeRatioBps: 10_001 }, "INVALID_HEDGE_RATIO"],
    ["negative exposure", { equityExposureKrw: -1 }, "INVALID_EQUITY_EXPOSURE"],
    ["zero threshold", { minRebalanceContracts: 0 }, "INVALID_MIN_REBALANCE_CONTRACTS"],
  ] as const)("fails closed for %s", (_label, patch, reason) => {
    const result = planEquityExposureHedge({ ...baseInput, ...patch });
    expect(result.status).toBe("BLOCKED");
    expect(result.orders).toEqual([]);
    expect(result.reasons).toContain(reason);
  });

  it("reads persisted purpose allocations without merging directional intent into the hedge", () => {
    const result = planEquityExposureHedgeFromLedger({
      equityExposureKrw: 262_500_000,
      futuresPriceTicks: 35_000,
      priceScale: 100,
      contractMultiplierKrw: 250_000,
      hedgeRatioBps: 10_000,
      minRebalanceContracts: 1,
      purposeLedger: [
        { purpose: "HEDGE", signedQuantity: -2 },
        { purpose: "DIRECTIONAL", signedQuantity: 1 },
      ],
      brokerPosition: { netQuantity: -1 },
    });

    expect(result).toMatchObject({
      targetHedgeSignedQuantity: -3,
      directionalSignedQuantity: 1,
      expectedBrokerNetQuantityAfterOrders: -2,
      orders: [{ purpose: "HEDGE", action: "OPEN", direction: "SHORT", quantity: 1 }],
    });
  });
});
