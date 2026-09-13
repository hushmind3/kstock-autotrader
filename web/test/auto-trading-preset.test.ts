import { describe, expect, it } from "vitest";
import type { BrokerSettings, StrategySummary } from "../lib/api-types";
import { dailyBuyBudgetMultiple, reentryCooldownSeconds, withAutoTradingPreset, withIntradayTradingPreset } from "../lib/auto-trading-preset";

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

const intradayStrategy: StrategySummary = {
  ...strategy,
  id: "intraday-momentum",
  name: "실시간 짧은 매매",
  defaultConfig: { minimumObservationSeconds: 75 },
};

describe("초단타 기본값 채우기", () => {
  it("고정 익절 없이 비용 회수 뒤 고점을 추적하고 초 단위 대기를 채운다", () => {
    const next = withIntradayTradingPreset(settings, [intradayStrategy]);
    expect(next.strategyId).toBe("intraday-momentum");
    expect(next.strategyConfig).toEqual(intradayStrategy.defaultConfig);
    expect(next.strategyConfig).not.toBe(intradayStrategy.defaultConfig);
    expect(next.orderPolicy).toMatchObject({
      orderRetrySeconds: 5,
      signalEvaluationSeconds: 1,
      reentryCooldownSeconds: 15,
      reentryCooldownMinutes: 0,
      estimatedRoundTripCostBps: 30,
      takeProfitAfterCosts: true,
      takeProfitEnabled: false,
      takeProfitBps: 500,
      stopLossEnabled: true,
      stopLossBps: 60,
      trailingProfitEnabled: true,
      trailingActivationBps: 90,
      trailingDrawdownBps: 30,
      stagnationExitEnabled: false,
      maxHoldingMinutes: 15,
      timedExitOnlyWithoutNetProfit: true,
      dailyInvestmentLimitEnabled: false,
      sizeToAvailableBudget: true,
      limitOffsetBps: 0,
    });
  });

  it.each([true, false])("운용 %s와 투자금·손실 한도를 보존하며 입력만 새 객체에 채운다", (autoTradingEnabled) => {
    const previous = { ...settings, autoTradingEnabled };
    const snapshot = structuredClone(previous);
    const next = withIntradayTradingPreset(previous, [intradayStrategy]);
    expect(next).toMatchObject({
      enabled: previous.enabled,
      autoTradingEnabled,
      newBuysPaused: previous.newBuysPaused,
      orderRoute: previous.orderRoute,
      resumeAfterRestart: previous.resumeAfterRestart,
      environment: previous.environment,
      orderPolicy: {
        orderType: previous.orderPolicy.orderType,
        perTradeBudget: previous.orderPolicy.perTradeBudget,
        perSymbolLimit: previous.orderPolicy.perSymbolLimit,
        accountInvestmentLimit: previous.orderPolicy.accountInvestmentLimit,
        dailyInvestmentLimit: previous.orderPolicy.dailyInvestmentLimit,
        dailyMaxLoss: previous.orderPolicy.dailyMaxLoss,
        maxPositions: previous.orderPolicy.maxPositions,
        unfilledTimeoutSeconds: 15,
        cancelRemainderOnTimeout: true,
      },
    });
    expect(previous).toEqual(snapshot);
  });

  it("스윙 기본값으로 돌아가면 초단타 보유시간과 초 단위 대기가 남지 않는다", () => {
    const intraday = withIntradayTradingPreset(settings, [intradayStrategy]);
    const swing = withAutoTradingPreset(intraday, [strategy]);
    expect(swing.orderPolicy.maxHoldingMinutes).toBe(0);
    expect(swing.orderPolicy.signalEvaluationSeconds).toBeUndefined();
    expect(swing.orderPolicy.orderRetrySeconds).toBe(30);
    expect(reentryCooldownSeconds(swing.orderPolicy)).toBe(1800);
    expect(swing.orderPolicy.takeProfitAfterCosts).toBe(false);
    expect(swing.orderPolicy.dailyInvestmentLimitEnabled).toBe(false);
  });

  it("등록되지 않은 실시간 전략을 임의로 만들지 않는다", () => {
    expect(withIntradayTradingPreset(settings, [strategy])).toBe(settings);
  });

  it("기존 분 단위 재매수 설정을 환산하되 명시한 0초는 유지한다", () => {
    expect(reentryCooldownSeconds({ ...settings.orderPolicy, reentryCooldownMinutes: 2 })).toBe(120);
    expect(reentryCooldownSeconds({ ...settings.orderPolicy, reentryCooldownMinutes: 2, reentryCooldownSeconds: 0 })).toBe(0);
  });

  it("하루 매수 한도의 금액 배수를 실제 주문 횟수와 구분해 계산한다", () => {
    expect(dailyBuyBudgetMultiple({ ...settings.orderPolicy, perTradeBudget: 5_000_000, dailyInvestmentLimit: 20_000_000 })).toBe(4);
    expect(dailyBuyBudgetMultiple({ ...settings.orderPolicy, perTradeBudget: 0 })).toBeNull();
  });
});
