import { describe, expect, it } from "vitest";
import { createDefaultSettings } from "@kstock/shared";
import { plainTradingRuleSummary, tradingRuleSummary } from "../lib/trading-rule-summary";

describe("쉬운 매매 규칙 설명", () => {
  it("기본 화면에는 숫자와 퍼센트 대신 매매 동작을 설명한다", () => {
    const settings = createDefaultSettings().brokers.kiwoom;
    Object.assign(settings.orderPolicy, { takeProfitEnabled: false, stopLossEnabled: true,
      maxHoldingMinutes: 15, timedExitOnlyWithoutNetProfit: true });
    const text = plainTradingRuleSummary(settings).sell;
    expect(text).not.toMatch(/[\d%]/);
    expect(text).toContain("정해진 수익률에 도달했다는 이유만으로 팔지 않습니다");
    expect(text).toContain("손절합니다");
    expect(text).toContain("수익 중이면 시간만으로 팔지 않습니다");
  });
  it("켜진 규칙만 설명하며 설정값을 바꾸지 않는다", () => {
    const settings = createDefaultSettings().brokers.kiwoom;
    settings.strategyId = "intraday-momentum";
    Object.assign(settings.orderPolicy, { takeProfitEnabled: true, takeProfitAfterCosts: true,
      takeProfitBps: 20, stopLossEnabled: true, stopLossBps: 60, maxHoldingMinutes: 15 });
    const before = JSON.stringify(settings);
    const result = tradingRuleSummary(settings);
    expect(result.buy).toContain("최근 고점");
    expect(result.sell).toContain("예상 비용을 빼고 0.2% 수익");
    expect(result.sell).toContain("매수가보다 0.6% 하락");
    expect(result.sell).toContain("15분 경과(수익·손실과 관계없이)");
    expect(result.sell).not.toContain("기록한 고점");
    expect(JSON.stringify(settings)).toBe(before);
  });
  it("고정 익절을 끄면 목표수익을 임의로 만들지 않는다", () => {
    const settings = createDefaultSettings().brokers.kiwoom;
    settings.strategyId = "intraday-momentum";
    settings.strategyConfig = { sellBelowMaBufferBps: 15 };
    expect(tradingRuleSummary(settings).sell).not.toContain("수익에 도달");
    expect(tradingRuleSummary(settings).sell).toContain("평균가격보다 0.15% 넘게 하락");
    expect(tradingRuleSummary(settings).sell).not.toContain("분 경과");
  });
  it("비용 회수 뒤 고정 상한 없이 고점을 따라가는 동작을 설명한다", () => {
    const settings = createDefaultSettings().brokers.kiwoom;
    Object.assign(settings.orderPolicy, {
      takeProfitEnabled: false,
      trailingProfitEnabled: true,
      trailingActivationBps: 90,
      trailingDrawdownBps: 30,
    });
    expect(plainTradingRuleSummary(settings).sell).toContain("거래비용을 회수한 뒤에는 본전선을 지키면서 상승 고점을 따라가고");
    const detailed = tradingRuleSummary(settings).sell;
    expect(detailed).toContain("0.9% 오른 뒤 거래비용 회수선을 보호하면서 고점을 추적");
    expect(detailed).toContain("고점에서 0.3% 하락");
  });
  it("시간이 지나도 수익 중인 종목을 유지하는 설정을 설명한다", () => {
    const settings = createDefaultSettings().brokers.kiwoom;
    Object.assign(settings.orderPolicy, { maxHoldingMinutes: 15, timedExitOnlyWithoutNetProfit: true });
    expect(tradingRuleSummary(settings).sell).toContain("예상 비용을 뺀 수익이 없을 때");
    expect(tradingRuleSummary(settings).sell).not.toContain("수익·손실과 관계없이");
  });
});
