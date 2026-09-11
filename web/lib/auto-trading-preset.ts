import type { BrokerSettings, StrategySummary } from "./api-types";

export const autoTradingPresetStrategyId = "pullback-rebound";
export const intradayTradingPresetStrategyId = "intraday-momentum";

export function withAutoTradingPreset(
  settings: BrokerSettings,
  strategies: readonly StrategySummary[],
): BrokerSettings {
  const strategy = strategies.find((row) => row.id === autoTradingPresetStrategyId);
  if (!strategy) return settings;

  return {
    ...settings,
    strategyId: strategy.id,
    strategyConfig: { ...strategy.defaultConfig },
    orderPolicy: {
      ...settings.orderPolicy,
      takeProfitEnabled: false,
      stopLossEnabled: true,
      stopLossBps: 300,
      trailingProfitEnabled: true,
      trailingActivationBps: 300,
      trailingDrawdownBps: 150,
      stagnationExitEnabled: true,
      stagnationTradingDays: 5,
      stagnationMaxReturnBps: 100,
      reentryCooldownMinutes: 30,
      reentryCooldownSeconds: 1800,
      orderRetrySeconds: 30,
      signalEvaluationSeconds: undefined,
      takeProfitAfterCosts: false,
      maxHoldingMinutes: 0,
    },
  };
}

export function withIntradayTradingPreset(
  settings: BrokerSettings,
  strategies: readonly StrategySummary[],
): BrokerSettings {
  const strategy = strategies.find((row) => row.id === intradayTradingPresetStrategyId);
  if (!strategy) return settings;

  return {
    ...settings,
    strategyId: strategy.id,
    strategyConfig: { ...strategy.defaultConfig },
    orderPolicy: {
      ...settings.orderPolicy,
      orderRetrySeconds: 5,
      unfilledTimeoutSeconds: 15,
      cancelRemainderOnTimeout: true,
      dailyInvestmentLimitEnabled: false,
      sizeToAvailableBudget: true,
      limitOffsetBps: 0,
      signalEvaluationSeconds: 1,
      reentryCooldownSeconds: 15,
      reentryCooldownMinutes: 0,
      estimatedRoundTripCostBps: 30,
      takeProfitAfterCosts: true,
      takeProfitEnabled: true,
      takeProfitBps: 20,
      stopLossEnabled: true,
      stopLossBps: 60,
      trailingProfitEnabled: false,
      stagnationExitEnabled: false,
      maxHoldingMinutes: 15,
    },
  };
}

export function dailyBuyBudgetMultiple(policy: BrokerSettings["orderPolicy"]): number | null {
  const { perTradeBudget, dailyInvestmentLimit } = policy;
  if (!Number.isFinite(perTradeBudget) || perTradeBudget <= 0 ||
      !Number.isFinite(dailyInvestmentLimit) || dailyInvestmentLimit < 0) return null;
  return Math.round((dailyInvestmentLimit / perTradeBudget) * 10) / 10;
}

export function reentryCooldownSeconds(policy: BrokerSettings["orderPolicy"]): number {
  return policy.reentryCooldownSeconds ?? (policy.reentryCooldownMinutes ?? 30) * 60;
}
