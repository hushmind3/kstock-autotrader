import type {
  DerivativesDirection,
  DerivativesOrderAction,
  DerivativesPositionPurpose,
} from "@kstock/shared";
import type {
  DerivativesPositionRecord,
  DerivativesPurposeLedgerRecord,
} from "@kstock/database";

const BASIS_POINTS_PER_ONE = 10_000n;
const MAX_SAFE_INTEGER_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

export type EquityHedgePlanStatus =
  | "BLOCKED"
  | "BALANCED"
  | "BELOW_REBALANCE_THRESHOLD"
  | "ORDER_REQUIRED";

export type EquityHedgeBlockReason =
  | "INVALID_EQUITY_EXPOSURE"
  | "INVALID_FUTURES_PRICE_TICKS"
  | "INVALID_PRICE_SCALE"
  | "INVALID_CONTRACT_MULTIPLIER"
  | "INVALID_HEDGE_RATIO"
  | "INVALID_HEDGE_QUANTITY"
  | "INVALID_DIRECTIONAL_QUANTITY"
  | "INVALID_BROKER_NET_QUANTITY"
  | "INVALID_MIN_REBALANCE_CONTRACTS"
  | "TARGET_QUANTITY_OUT_OF_RANGE"
  | "PURPOSE_LEDGER_MISMATCH";

export type EquityHedgePlanReason = EquityHedgeBlockReason | "REBALANCE_THRESHOLD_NOT_MET";

export interface EquityHedgeOrderPlan {
  purpose: Extract<DerivativesPositionPurpose, "HEDGE">;
  action: DerivativesOrderAction;
  direction: DerivativesDirection;
  quantity: number;
}

export interface EquityHedgePlanInput {
  /** One total cash-equity exposure or one non-negative KRW value per cash account. */
  equityExposureKrw: number | readonly number[] | null;
  futuresPriceTicks: number;
  priceScale: number;
  contractMultiplierKrw: number;
  /** 1..10,000. Ratios above 100% are rejected to prevent over-hedging. */
  hedgeRatioBps: number;
  existingHedgeSignedQuantity: DerivativesPurposeLedgerRecord["signedQuantity"];
  directionalSignedQuantity: DerivativesPurposeLedgerRecord["signedQuantity"];
  brokerNetQuantity: DerivativesPositionRecord["netQuantity"];
  minRebalanceContracts: number;
}

export interface EquityHedgePlan {
  status: EquityHedgePlanStatus;
  blocked: boolean;
  reasons: readonly EquityHedgePlanReason[];
  sourceEquityExposureKrw: number | null;
  targetHedgeSignedQuantity: number | null;
  existingHedgeSignedQuantity: number;
  directionalSignedQuantity: number;
  brokerNetQuantity: number;
  allocatedNetQuantity: number | null;
  expectedBrokerNetQuantityAfterOrders: number | null;
  /** Sum of all planned leg quantities. */
  orderQuantity: number;
  orders: readonly EquityHedgeOrderPlan[];
}

export interface EquityHedgeLedgerInput
  extends Omit<
    EquityHedgePlanInput,
    "existingHedgeSignedQuantity" | "directionalSignedQuantity" | "brokerNetQuantity"
  > {
  purposeLedger: readonly Pick<
    DerivativesPurposeLedgerRecord,
    "purpose" | "signedQuantity"
  >[];
  brokerPosition: Pick<DerivativesPositionRecord, "netQuantity">;
}

/**
 * Plans only the HEDGE virtual allocation. The DIRECTIONAL allocation is never
 * changed. A broker/virtual-ledger mismatch blocks every order until account
 * reconciliation repairs it.
 */
export function planEquityExposureHedge(input: EquityHedgePlanInput): EquityHedgePlan {
  const reasons: EquityHedgeBlockReason[] = [];
  const exposures: readonly number[] = Array.isArray(input.equityExposureKrw)
    ? input.equityExposureKrw
    : typeof input.equityExposureKrw === "number"
      ? [input.equityExposureKrw]
      : [];

  if (
    exposures.length === 0
    || exposures.some((value) => !isNonNegativeSafeInteger(value))
  ) {
    reasons.push("INVALID_EQUITY_EXPOSURE");
  }
  if (!isPositiveSafeInteger(input.futuresPriceTicks)) {
    reasons.push("INVALID_FUTURES_PRICE_TICKS");
  }
  if (!isPositiveSafeInteger(input.priceScale)) {
    reasons.push("INVALID_PRICE_SCALE");
  }
  if (!isPositiveSafeInteger(input.contractMultiplierKrw)) {
    reasons.push("INVALID_CONTRACT_MULTIPLIER");
  }
  if (
    !isPositiveSafeInteger(input.hedgeRatioBps)
    || input.hedgeRatioBps > Number(BASIS_POINTS_PER_ONE)
  ) {
    reasons.push("INVALID_HEDGE_RATIO");
  }
  if (!Number.isSafeInteger(input.existingHedgeSignedQuantity)) {
    reasons.push("INVALID_HEDGE_QUANTITY");
  }
  if (!Number.isSafeInteger(input.directionalSignedQuantity)) {
    reasons.push("INVALID_DIRECTIONAL_QUANTITY");
  }
  if (!Number.isSafeInteger(input.brokerNetQuantity)) {
    reasons.push("INVALID_BROKER_NET_QUANTITY");
  }
  if (!isPositiveSafeInteger(input.minRebalanceContracts)) {
    reasons.push("INVALID_MIN_REBALANCE_CONTRACTS");
  }

  let exposureTotalBigInt: bigint | null = null;
  if (!reasons.includes("INVALID_EQUITY_EXPOSURE")) {
    const total = exposures.reduce((sum, value) => sum + BigInt(value), 0n);
    if (total > MAX_SAFE_INTEGER_BIGINT) {
      reasons.push("INVALID_EQUITY_EXPOSURE");
    } else {
      exposureTotalBigInt = total;
    }
  }

  const ledgerQuantitiesValid = !reasons.includes("INVALID_HEDGE_QUANTITY")
    && !reasons.includes("INVALID_DIRECTIONAL_QUANTITY")
    && !reasons.includes("INVALID_BROKER_NET_QUANTITY");
  const allocatedNetQuantity = ledgerQuantitiesValid
    ? input.existingHedgeSignedQuantity + input.directionalSignedQuantity
    : null;
  if (
    allocatedNetQuantity !== null
    && (!Number.isSafeInteger(allocatedNetQuantity)
      || allocatedNetQuantity !== input.brokerNetQuantity)
  ) {
    reasons.push("PURPOSE_LEDGER_MISMATCH");
  }

  let targetHedgeSignedQuantity: number | null = null;
  const calculationInputsValid = exposureTotalBigInt !== null
    && !reasons.includes("INVALID_FUTURES_PRICE_TICKS")
    && !reasons.includes("INVALID_PRICE_SCALE")
    && !reasons.includes("INVALID_CONTRACT_MULTIPLIER")
    && !reasons.includes("INVALID_HEDGE_RATIO");

  if (calculationInputsValid && exposureTotalBigInt !== null) {
    const numerator = exposureTotalBigInt
      * BigInt(input.hedgeRatioBps)
      * BigInt(input.priceScale);
    const denominator = BASIS_POINTS_PER_ONE
      * BigInt(input.futuresPriceTicks)
      * BigInt(input.contractMultiplierKrw);
    const targetAbsoluteQuantity = numerator / denominator;
    if (targetAbsoluteQuantity > MAX_SAFE_INTEGER_BIGINT) {
      reasons.push("TARGET_QUANTITY_OUT_OF_RANGE");
    } else {
      // A long cash portfolio is hedged with a short futures allocation.
      targetHedgeSignedQuantity = -Number(targetAbsoluteQuantity);
    }
  }

  if (reasons.length > 0 || targetHedgeSignedQuantity === null) {
    return blockedPlan(input, reasons, exposureTotalBigInt, targetHedgeSignedQuantity, allocatedNetQuantity);
  }

  const signedDifference = targetHedgeSignedQuantity - input.existingHedgeSignedQuantity;
  if (!Number.isSafeInteger(signedDifference)) {
    return blockedPlan(
      input,
      [...reasons, "TARGET_QUANTITY_OUT_OF_RANGE"],
      exposureTotalBigInt,
      targetHedgeSignedQuantity,
      allocatedNetQuantity,
    );
  }

  if (signedDifference === 0) {
    return {
      status: "BALANCED",
      blocked: false,
      reasons: [],
      sourceEquityExposureKrw: Number(exposureTotalBigInt),
      targetHedgeSignedQuantity,
      existingHedgeSignedQuantity: input.existingHedgeSignedQuantity,
      directionalSignedQuantity: input.directionalSignedQuantity,
      brokerNetQuantity: input.brokerNetQuantity,
      allocatedNetQuantity,
      expectedBrokerNetQuantityAfterOrders:
        targetHedgeSignedQuantity + input.directionalSignedQuantity,
      orderQuantity: 0,
      orders: [],
    };
  }

  if (Math.abs(signedDifference) < input.minRebalanceContracts) {
    return {
      status: "BELOW_REBALANCE_THRESHOLD",
      blocked: false,
      reasons: ["REBALANCE_THRESHOLD_NOT_MET"],
      sourceEquityExposureKrw: Number(exposureTotalBigInt),
      targetHedgeSignedQuantity,
      existingHedgeSignedQuantity: input.existingHedgeSignedQuantity,
      directionalSignedQuantity: input.directionalSignedQuantity,
      brokerNetQuantity: input.brokerNetQuantity,
      allocatedNetQuantity,
      expectedBrokerNetQuantityAfterOrders: input.brokerNetQuantity,
      orderQuantity: 0,
      orders: [],
    };
  }

  const desiredBrokerNetQuantity = targetHedgeSignedQuantity + input.directionalSignedQuantity;
  // KIS carries one physical net position per contract. When a directional
  // allocation offsets a hedge allocation, the broker-side action can be a
  // CLOSE even though the HEDGE virtual allocation is increasing. Plan the
  // actual broker net transition, not an imaginary standalone hedge position.
  const orders = planSignedPositionTransition(
    input.brokerNetQuantity,
    desiredBrokerNetQuantity,
  ).map((item) => ({ ...item, purpose: "HEDGE" as const }));
  return {
    status: "ORDER_REQUIRED",
    blocked: false,
    reasons: [],
    sourceEquityExposureKrw: Number(exposureTotalBigInt),
    targetHedgeSignedQuantity,
    existingHedgeSignedQuantity: input.existingHedgeSignedQuantity,
    directionalSignedQuantity: input.directionalSignedQuantity,
    brokerNetQuantity: input.brokerNetQuantity,
    allocatedNetQuantity,
    expectedBrokerNetQuantityAfterOrders:
      targetHedgeSignedQuantity + input.directionalSignedQuantity,
    orderQuantity: orders.reduce((sum, order) => sum + order.quantity, 0),
    orders,
  };
}

/** Adapts the persisted purpose ledger and broker position to the pure planner. */
export function planEquityExposureHedgeFromLedger(
  input: EquityHedgeLedgerInput,
): EquityHedgePlan {
  let existingHedgeSignedQuantity = 0;
  let directionalSignedQuantity = 0;
  for (const allocation of input.purposeLedger) {
    if (allocation.purpose === "HEDGE") {
      existingHedgeSignedQuantity += allocation.signedQuantity;
    } else {
      directionalSignedQuantity += allocation.signedQuantity;
    }
  }
  return planEquityExposureHedge({
    equityExposureKrw: input.equityExposureKrw,
    futuresPriceTicks: input.futuresPriceTicks,
    priceScale: input.priceScale,
    contractMultiplierKrw: input.contractMultiplierKrw,
    hedgeRatioBps: input.hedgeRatioBps,
    existingHedgeSignedQuantity,
    directionalSignedQuantity,
    brokerNetQuantity: input.brokerPosition.netQuantity,
    minRebalanceContracts: input.minRebalanceContracts,
  });
}

function blockedPlan(
  input: EquityHedgePlanInput,
  reasons: readonly EquityHedgeBlockReason[],
  exposureTotal: bigint | null,
  targetHedgeSignedQuantity: number | null,
  allocatedNetQuantity: number | null,
): EquityHedgePlan {
  return {
    status: "BLOCKED",
    blocked: true,
    reasons: [...new Set(reasons)],
    sourceEquityExposureKrw: exposureTotal === null ? null : Number(exposureTotal),
    targetHedgeSignedQuantity,
    existingHedgeSignedQuantity: input.existingHedgeSignedQuantity,
    directionalSignedQuantity: input.directionalSignedQuantity,
    brokerNetQuantity: input.brokerNetQuantity,
    allocatedNetQuantity,
    expectedBrokerNetQuantityAfterOrders: null,
    orderQuantity: 0,
    orders: [],
  };
}

export function planSignedPositionTransition(
  current: number,
  target: number,
): EquityHedgeOrderPlan[] {
  if (current === target) return [];
  if (current === 0) return [order("OPEN", target < 0 ? "SHORT" : "LONG", Math.abs(target))];
  if (target === 0) return [order("CLOSE", current < 0 ? "SHORT" : "LONG", Math.abs(current))];

  if (Math.sign(current) === Math.sign(target)) {
    const increasing = Math.abs(target) > Math.abs(current);
    return [order(
      increasing ? "OPEN" : "CLOSE",
      current < 0 ? "SHORT" : "LONG",
      Math.abs(target - current),
    )];
  }

  return [
    order("CLOSE", current < 0 ? "SHORT" : "LONG", Math.abs(current)),
    order("OPEN", target < 0 ? "SHORT" : "LONG", Math.abs(target)),
  ];
}

function order(
  action: DerivativesOrderAction,
  direction: DerivativesDirection,
  quantity: number,
): EquityHedgeOrderPlan {
  return { purpose: "HEDGE", action, direction, quantity };
}

function isPositiveSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function isNonNegativeSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}
