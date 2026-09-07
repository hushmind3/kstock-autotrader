import type {
  BrokerPosition,
  OrderPolicy,
  Quote,
  StrategyDecision,
} from "@kstock/shared";

export interface PositionExitPolicyInput {
  position: BrokerPosition | null;
  quote: Quote;
  orderPolicy: OrderPolicy;
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
    !orderPolicy.takeProfitEnabled ||
    !position ||
    position.quantity <= 0 ||
    position.averagePrice <= 0 ||
    quote.price <= 0
  ) {
    return null;
  }

  const positionReturnBps = Math.round(
    ((quote.price - position.averagePrice) / position.averagePrice) * 10_000,
  );
  if (positionReturnBps < orderPolicy.takeProfitBps) return null;

  return {
    action: "SELL",
    reasonCodes: ["TAKE_PROFIT_TARGET_REACHED"],
    metrics: {
      currentPrice: quote.price,
      averagePrice: position.averagePrice,
      positionReturnBps,
      takeProfitTargetBps: orderPolicy.takeProfitBps,
      accountExitPolicy: true,
    },
  };
}
