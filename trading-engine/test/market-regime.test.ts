import { describe, expect, it } from "vitest";
import { MarketRegimeSettingsSchema } from "@kstock/shared";
import { evaluateMarketRegime } from "../src/core/market-regime.js";

const settings = MarketRegimeSettingsSchema.parse({
  minimumSampleSize: 100,
  minimumAboveLongMaBps: 3_500,
  minimumIntradayAdvancingBps: 3_000,
});

function evaluate(overrides: Partial<Parameters<typeof evaluateMarketRegime>[0]> = {}) {
  return evaluateMarketRegime({
    settings,
    dailySampleCount: 500,
    dailyAboveLongMaCount: 250,
    intradaySampleCount: 300,
    intradayAdvancingCount: 150,
    requireIntradayEvidence: true,
    checkedAt: "2026-09-08T00:00:00.000Z",
    ...overrides,
  });
}

describe("시장 전체 흐름 자동 판단", () => {
  it("장기 흐름과 당일 흐름이 모두 정상일 때 신규매수를 허용한다", () => {
    expect(evaluate()).toMatchObject({
      status: "NORMAL",
      buyAllowed: true,
      reasonCode: "MARKET_HEALTHY",
      dailyAboveLongMaBps: 5_000,
      intradayAdvancingBps: 5_000,
    });
  });

  it("장기 평균선 위 종목이 너무 적으면 신규매수만 막는다", () => {
    expect(evaluate({ dailyAboveLongMaCount: 100 })).toMatchObject({
      status: "WEAK",
      buyAllowed: false,
      reasonCode: "DAILY_BREADTH_WEAK",
    });
  });

  it("장중 상승 종목이 너무 적으면 신규매수만 막는다", () => {
    expect(evaluate({ intradayAdvancingCount: 60 })).toMatchObject({
      status: "WEAK",
      buyAllowed: false,
      reasonCode: "INTRADAY_BREADTH_WEAK",
    });
  });

  it("장중 표본이 모자라면 추측하지 않고 기다린다", () => {
    expect(evaluate({ intradaySampleCount: 30, intradayAdvancingCount: 20 })).toMatchObject({
      status: "WAITING_FOR_DATA",
      buyAllowed: false,
      reasonCode: "INTRADAY_BREADTH_NOT_READY",
    });
  });

  it("시장이 닫힌 동안에는 확정 일봉 흐름만으로 다음 장 준비 상태를 계산한다", () => {
    expect(evaluate({
      requireIntradayEvidence: false,
      intradaySampleCount: 0,
      intradayAdvancingCount: 0,
    })).toMatchObject({
      status: "NORMAL",
      buyAllowed: true,
      intradayAdvancingBps: null,
    });
  });
});
