import type { OrderSide } from "@kstock/shared";

export interface ExecutionCostObservation {
  side: OrderSide;
  quantity: number;
  fillPrice: number;
  /** Price observed when the deterministic strategy emitted the order signal. */
  referencePrice?: number;
  feeKrw: number;
  taxKrw: number;
}

export interface ExecutionCostEstimate {
  roundTripCostBps: number;
  observedRoundTripCostBps: number | null;
  sampleCount: number;
}

interface SideAggregate {
  notional: number;
  costEquivalent: number;
  count: number;
}

function validPositive(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value) && value > 0;
}

/**
 * Learns an adverse execution-cost floor from durable fills. Broker-reported
 * fee/tax amounts are used when present; signal-to-fill slippage is measured
 * from real prices. A configured cost remains the floor because many broker
 * execution feeds do not expose fees on each individual fill.
 */
export function estimateExecutionCost(
  observations: readonly ExecutionCostObservation[],
  configuredRoundTripCostBps: number,
): ExecutionCostEstimate {
  const aggregates: Record<OrderSide, SideAggregate> = {
    buy: { notional: 0, costEquivalent: 0, count: 0 },
    sell: { notional: 0, costEquivalent: 0, count: 0 },
  };

  for (const observation of observations) {
    if (
      !Number.isSafeInteger(observation.quantity) || observation.quantity <= 0 ||
      !validPositive(observation.fillPrice) ||
      !Number.isFinite(observation.feeKrw) || observation.feeKrw < 0 ||
      !Number.isFinite(observation.taxKrw) || observation.taxKrw < 0
    ) continue;
    const referencePrice = validPositive(observation.referencePrice)
      ? observation.referencePrice
      : undefined;
    const explicitCost = observation.feeKrw + observation.taxKrw;
    const adverseSlippagePerShare = referencePrice === undefined ? 0
      : observation.side === "buy"
        ? Math.max(0, observation.fillPrice - referencePrice)
        : Math.max(0, referencePrice - observation.fillPrice);
    // A row without either an explicit broker cost or a reference price does
    // not contain any cost evidence and must not dilute the estimate.
    if (explicitCost === 0 && referencePrice === undefined) continue;
    const aggregate = aggregates[observation.side];
    aggregate.notional += observation.fillPrice * observation.quantity;
    aggregate.costEquivalent += explicitCost + adverseSlippagePerShare * observation.quantity;
    aggregate.count += 1;
  }

  const rates = (["buy", "sell"] as const).flatMap((side) => {
    const aggregate = aggregates[side];
    return aggregate.notional > 0
      ? [{ side, bps: aggregate.costEquivalent / aggregate.notional * 10_000 }]
      : [];
  });
  const observedRoundTripCostBps = rates.length === 0 ? null
    : rates.length === 1 ? rates[0]!.bps * 2
      : rates.reduce((sum, row) => sum + row.bps, 0);
  const configuredFloor = Number.isFinite(configuredRoundTripCostBps)
    ? Math.max(0, configuredRoundTripCostBps)
    : 0;
  return {
    roundTripCostBps: Math.min(1_000, Math.ceil(Math.max(
      configuredFloor,
      observedRoundTripCostBps ?? 0,
    ))),
    observedRoundTripCostBps: observedRoundTripCostBps === null
      ? null
      : Math.round(observedRoundTripCostBps),
    sampleCount: aggregates.buy.count + aggregates.sell.count,
  };
}
