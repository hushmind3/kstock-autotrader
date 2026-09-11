import type { BrokerSettings, StrategySummary } from "./api-types";

export const autoTradingPresetStrategyId = "pullback-rebound";

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
    },
  };
}
