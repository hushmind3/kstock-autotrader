import { describe, expect, it } from "vitest";
import type { BrokerSettings, StrategySummary } from "../lib/api-types";
import { withAutoTradingPreset } from "../lib/auto-trading-preset";

const settings: BrokerSettings = {
  enabled: true,
  autoTradingEnabled: true,
  newBuysPaused: true,
  orderRoute: "NXT",
  resumeAfterRestart: true,
  environment: "live",
  strategyId: "moving-average",
  strategyConfig: { shortPeriod: 7 },
  orderPolicy: {
    orderType: "limit",
    limitOffsetBps: 20,
    takeProfitEnabled: true,
    takeProfitBps: 725,
    perTradeBudget: 123_000,
    perSymbolLimit: 456_000,
    accountInvestmentLimit: 1_234_000,
    dailyInvestmentLimit: 567_000,
    dailyMaxLoss: 89_000,
    maxPositions: 3,
    unfilledTimeoutSeconds: 45,
    cancelRemainderOnTimeout: false,
  },
};

const strategy: StrategySummary = {
  id: "pullback-rebound",
  name: "눌림 후 반등",
  version: "1.0.0",
  description: "눌림 이후 반등을 확인합니다.",
  defaultConfig: { shortPeriod: 6, longPeriod: 24, minimumVolumeRatio: 1.1 },
  configFields: [],
};

describe("자동 매매 기본값 채우기", () => {
  it("엔진이 제공한 전략 기본값과 자동매도·재매수 조건을 화면에 채운다", () => {
    const next = withAutoTradingPreset(settings, [strategy]);

    expect(next.strategyId).toBe("pullback-rebound");
    expect(next.strategyConfig).toEqual(strategy.defaultConfig);
    expect(next.strategyConfig).not.toBe(strategy.defaultConfig);
    expect(next.orderPolicy).toMatchObject({
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
    });
  });

  it.each([true, false])("자동운용이 %s여도 계좌·운용 상태·금액 한도를 그대로 둔다", (autoTradingEnabled) => {
    const previous = { ...settings, autoTradingEnabled };
    const snapshot = structuredClone(previous);
    const next = withAutoTradingPreset(previous, [strategy]);

    expect(next).toMatchObject({
      enabled: previous.enabled,
      autoTradingEnabled,
      newBuysPaused: previous.newBuysPaused,
      orderRoute: previous.orderRoute,
      resumeAfterRestart: previous.resumeAfterRestart,
      environment: previous.environment,
      orderPolicy: {
        ...previous.orderPolicy,
        takeProfitEnabled: false,
      },
    });
    expect(previous).toEqual(snapshot);
  });

  it("기본 전략이 아직 없으면 기존 입력값을 바꾸지 않는다", () => {
    expect(withAutoTradingPreset(settings, [])).toBe(settings);
  });
});
