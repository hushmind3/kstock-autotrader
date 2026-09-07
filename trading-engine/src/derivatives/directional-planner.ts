import type { DerivativeDailyBar } from "@kstock/broker-kis-derivatives";
import type {
  DerivativesDirection,
  DerivativesOrderAction,
} from "@kstock/shared";
import { planSignedPositionTransition } from "./hedge-planner.js";

export type DirectionalSignal = "LONG" | "SHORT" | "FLAT" | "WAITING_FOR_HISTORY";

export interface DirectionalTrendPlan {
  signal: DirectionalSignal;
  fastAverage: number | null;
  slowAverage: number | null;
  gapBps: number | null;
  currentDirectionalQuantity: number;
  targetDirectionalQuantity: number;
  targetBrokerNetQuantity: number;
  orders: Array<{
    purpose: "DIRECTIONAL";
    action: DerivativesOrderAction;
    direction: DerivativesDirection;
    quantity: number;
  }>;
}

export function planDirectionalMovingAverage(input: {
  bars: readonly Pick<DerivativeDailyBar, "tradingDate" | "close">[];
  fastPeriod: number;
  slowPeriod: number;
  minimumGapBps: number;
  sideMode: "BOTH" | "LONG_ONLY" | "SHORT_ONLY";
  targetContracts: number;
  currentDirectionalQuantity: number;
  currentHedgeQuantity: number;
  brokerNetQuantity: number;
}): DirectionalTrendPlan {
  const ordered = [...input.bars]
    .filter((bar) => /^\d{8}$/.test(bar.tradingDate) && Number.isFinite(bar.close) && bar.close > 0)
    .sort((left, right) => left.tradingDate.localeCompare(right.tradingDate));
  if (ordered.length < input.slowPeriod) {
    return {
      signal: "WAITING_FOR_HISTORY",
      fastAverage: null,
      slowAverage: null,
      gapBps: null,
      currentDirectionalQuantity: input.currentDirectionalQuantity,
      targetDirectionalQuantity: input.currentDirectionalQuantity,
      targetBrokerNetQuantity: input.brokerNetQuantity,
      orders: [],
    };
  }

  const closes = ordered.map((bar) => bar.close);
  const average = (period: number) =>
    closes.slice(-period).reduce((sum, value) => sum + value, 0) / period;
  const fastAverage = average(input.fastPeriod);
  const slowAverage = average(input.slowPeriod);
  const gapBps = Math.round(((fastAverage - slowAverage) / slowAverage) * 10_000);

  let signal: Exclude<DirectionalSignal, "WAITING_FOR_HISTORY"> = "FLAT";
  if (gapBps >= input.minimumGapBps && input.sideMode !== "SHORT_ONLY") signal = "LONG";
  if (gapBps <= -input.minimumGapBps && input.sideMode !== "LONG_ONLY") signal = "SHORT";
  const targetDirectionalQuantity = signal === "LONG"
    ? input.targetContracts
    : signal === "SHORT"
      ? -input.targetContracts
      : 0;
  const targetBrokerNetQuantity = input.currentHedgeQuantity + targetDirectionalQuantity;
  const orders = planSignedPositionTransition(
    input.brokerNetQuantity,
    targetBrokerNetQuantity,
  ).map((order) => ({ ...order, purpose: "DIRECTIONAL" as const }));
  return {
    signal,
    fastAverage,
    slowAverage,
    gapBps,
    currentDirectionalQuantity: input.currentDirectionalQuantity,
    targetDirectionalQuantity,
    targetBrokerNetQuantity,
    orders,
  };
}
