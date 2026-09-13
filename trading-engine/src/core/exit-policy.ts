import type {
  BrokerPosition,
  OrderPolicy,
  Quote,
  StrategyDecision,
} from "@kstock/shared";
import { stableHash } from "@kstock/shared";

/** Changing exit conditions invalidates an old exit latch, not the observed peak. */
export function positionExitPolicyKey(
  policy: OrderPolicy,
  observedRoundTripCostBps = policy.estimatedRoundTripCostBps,
): string {
  return stableHash({
    stopLossEnabled: policy.stopLossEnabled, stopLossBps: policy.stopLossBps,
    takeProfitEnabled: policy.takeProfitEnabled, takeProfitBps: policy.takeProfitBps,
    trailingProfitEnabled: policy.trailingProfitEnabled,
    trailingActivationBps: policy.trailingActivationBps, trailingDrawdownBps: policy.trailingDrawdownBps,
    stagnationExitEnabled: policy.stagnationExitEnabled,
    stagnationTradingDays: policy.stagnationTradingDays, stagnationMaxReturnBps: policy.stagnationMaxReturnBps,
    estimatedRoundTripCostBps: policy.estimatedRoundTripCostBps,
    observedRoundTripCostBps,
    takeProfitAfterCosts: policy.takeProfitAfterCosts, maxHoldingMinutes: policy.maxHoldingMinutes,
    timedExitOnlyWithoutNetProfit: policy.timedExitOnlyWithoutNetProfit,
  });
}

export interface PositionExitPolicyInput {
  position: BrokerPosition | null;
  quote: Quote;
  orderPolicy: OrderPolicy;
  /** Persisted peak of quotes observed during this position, never the day's high. */
  peakPrice?: number;
  completedHoldingSessions?: number;
  heldForMs?: number;
  /**
   * Cost learned from durable fills. The configured estimate remains a floor
   * so a small or incomplete sample can never make the exit gate optimistic.
   */
  observedRoundTripCostBps?: number;
}

/**
 * Account-level exits are intentionally evaluated outside individual strategy
 * modules. A take-profit rule therefore behaves the same after changing the
 * entry strategy and after the engine restores a broker position on restart.
 */
export function evaluatePositionExitPolicy(
  input: PositionExitPolicyInput,
): StrategyDecision | null {
  const { position, quote, orderPolicy } = input;
  if (
    !position ||
    position.quantity <= 0 ||
    !Number.isFinite(position.averagePrice) ||
    position.averagePrice <= 0 ||
    !Number.isFinite(quote.price) ||
    quote.price <= 0
  ) {
    return null;
  }

  const rawReturnBps =
    ((quote.price - position.averagePrice) / position.averagePrice) * 10_000;
  const positionReturnBps = Math.round(rawReturnBps);
  const observedCost = input.observedRoundTripCostBps;
  const effectiveRoundTripCostBps = Math.max(
    orderPolicy.estimatedRoundTripCostBps,
    observedCost !== undefined && Number.isFinite(observedCost) ? observedCost : 0,
  );
  const estimatedNetReturnBps = rawReturnBps - effectiveRoundTripCostBps;
  const metrics: StrategyDecision["metrics"] = {
    currentPrice: quote.price,
    averagePrice: position.averagePrice,
    positionReturnBps,
    accountExitPolicy: true,
    estimatedNetReturnBps: Math.round(estimatedNetReturnBps),
    estimatedRoundTripCostBps: effectiveRoundTripCostBps,
  };
  if (orderPolicy.stopLossEnabled && rawReturnBps <= -orderPolicy.stopLossBps) {
    return {
      action: "SELL",
      reasonCodes: ["STOP_LOSS_TRIGGERED"],
      metrics: { ...metrics, stopLossBps: orderPolicy.stopLossBps },
    };
  }
  const profitBasisBps = orderPolicy.takeProfitAfterCosts ? estimatedNetReturnBps : rawReturnBps;
  if (orderPolicy.takeProfitEnabled && profitBasisBps >= orderPolicy.takeProfitBps) {
    return {
      action: "SELL",
      reasonCodes: [orderPolicy.takeProfitAfterCosts ? "NET_PROFIT_TARGET_REACHED" : "TAKE_PROFIT_TARGET_REACHED"],
      metrics: {
        ...metrics, takeProfitTargetBps: orderPolicy.takeProfitBps,
        ...(orderPolicy.takeProfitAfterCosts ? {
          minimumSellPrice: position.averagePrice * (1 + (orderPolicy.takeProfitBps + effectiveRoundTripCostBps) / 10_000),
        } : {}),
      },
    };
  }
  const peak = input.peakPrice;
  let protectedProfitHold: StrategyDecision | null = null;
  if (orderPolicy.trailingProfitEnabled && peak !== undefined && Number.isFinite(peak) && peak > 0) {
    const peakReturnBps = ((peak - position.averagePrice) / position.averagePrice) * 10_000;
    const drawdownBps = ((peak - quote.price) / peak) * 10_000;
    const activationBps = Math.max(
      orderPolicy.trailingActivationBps,
      effectiveRoundTripCostBps,
    );
    if (peakReturnBps >= activationBps) {
      const costRecoveryPrice = position.averagePrice *
        (1 + effectiveRoundTripCostBps / 10_000);
      const trailingFloorPrice = peak *
        (1 - orderPolicy.trailingDrawdownBps / 10_000);
      const protectedFloorPrice = Math.max(costRecoveryPrice, trailingFloorPrice);
      const protectionMetrics = {
        ...metrics,
        peakPrice: peak,
        peakReturnBps: Math.round(peakReturnBps),
        drawdownBps: Math.round(drawdownBps),
        profitProtectionActivationBps: activationBps,
        protectedFloorPrice: Math.round(protectedFloorPrice),
      };
      // A newly observed peak must arm protection, not immediately liquidate
      // the position. Only a later reversal through the protected floor exits.
      if (quote.price < peak && quote.price <= protectedFloorPrice) return {
        action: "SELL",
        reasonCodes: ["TRAILING_PROFIT_TRIGGERED"],
        metrics: protectionMetrics,
      };
      // Once costs have been recovered, the account-level profit protector
      // owns the exit. This HOLD intentionally prevents a noisy strategy-level
      // moving-average cross from cutting a winner before its protected floor.
      protectedProfitHold = {
        action: "HOLD",
        reasonCodes: ["PROFIT_PROTECTION_ACTIVE"],
        metrics: protectionMetrics,
      };
    }
  }
  if (
    orderPolicy.maxHoldingMinutes > 0 &&
    input.heldForMs !== undefined && Number.isFinite(input.heldForMs) &&
    input.heldForMs >= orderPolicy.maxHoldingMinutes * 60_000 &&
    (!orderPolicy.timedExitOnlyWithoutNetProfit || estimatedNetReturnBps <= 1e-8)
  ) {
    return {
      action: "SELL", reasonCodes: ["MAX_HOLDING_TIME_REACHED"],
      metrics: { ...metrics, heldMinutes: Math.floor(input.heldForMs / 60_000),
        timedExitOnlyWithoutNetProfit: orderPolicy.timedExitOnlyWithoutNetProfit },
    };
  }
  if (
    orderPolicy.stagnationExitEnabled &&
    input.completedHoldingSessions !== undefined &&
    input.completedHoldingSessions >= orderPolicy.stagnationTradingDays &&
    rawReturnBps <= orderPolicy.stagnationMaxReturnBps
  ) {
    return {
      action: "SELL",
      reasonCodes: ["STAGNATION_EXIT_TRIGGERED"],
      metrics: { ...metrics, completedHoldingSessions: input.completedHoldingSessions },
    };
  }
  return protectedProfitHold;
}
