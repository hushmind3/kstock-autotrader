import type { BrokerSettings } from "./api-types";

/** The basic screen uses plain language; exact values stay in advanced settings. */
export function plainTradingRuleSummary(settings: BrokerSettings): { buy: string; sell: string } {
  const policy = settings.orderPolicy;
  const parts = [policy.takeProfitEnabled
    ? "정한 목표수익에 도달하면 팝니다."
    : "정해진 수익률에 도달했다는 이유만으로 팔지 않습니다."];
  parts.push(settings.strategyId === "intraday-momentum"
    ? "짧은 가격 흐름이 꺾여 매도 조건에 걸리면 팝니다." : "선택한 전략의 매도 조건에 걸리면 팝니다.");
  if (policy.stopLossEnabled) parts.push("손실이 커지면 손절합니다.");
  if (policy.trailingProfitEnabled) parts.push("상승 중 기록한 고점에서 정한 폭만큼 내려와도 팝니다.");
  if (policy.maxHoldingMinutes) parts.push(policy.timedExitOnlyWithoutNetProfit
    ? "오래 보유해도 예상 거래비용을 뺀 수익이 없으면 정리합니다. 수익 중이면 시간만으로 팔지 않습니다."
    : "정한 보유시간이 지나면 수익 여부와 관계없이 정리합니다.");
  if (policy.stagnationExitEnabled) parts.push("오랫동안 제자리인 종목도 정리합니다.");
  return { buy: tradingRuleSummary(settings).buy, sell: parts.join(" ") };
}

/** Describe the configured rules, not a promise about their returns. */
export function tradingRuleSummary(settings: BrokerSettings): { buy: string; sell: string } {
  const policy = settings.orderPolicy;
  const intraday = settings.strategyId === "intraday-momentum";
  const exits: string[] = [];
  if (policy.takeProfitEnabled) {
    exits.push(`${policy.takeProfitAfterCosts ? "예상 비용을 빼고 " : "가격 기준 "}${policy.takeProfitBps / 100}% 수익에 도달`);
  }
  if (policy.stopLossEnabled) exits.push(`매수가보다 ${(policy.stopLossBps ?? 300) / 100}% 하락`);
  if (policy.trailingProfitEnabled) {
    exits.push(`${(policy.trailingActivationBps ?? 300) / 100}% 오른 뒤 기록한 고점에서 ${(policy.trailingDrawdownBps ?? 150) / 100}% 하락`);
  }
  if (policy.maxHoldingMinutes) exits.push(policy.timedExitOnlyWithoutNetProfit
    ? `보유 ${policy.maxHoldingMinutes}분이 지나도 예상 비용을 뺀 수익이 없을 때`
    : `보유 ${policy.maxHoldingMinutes}분 경과(수익·손실과 관계없이)`);
  if (policy.stagnationExitEnabled) {
    exits.push(`${policy.stagnationTradingDays ?? 5}거래일 후 수익률이 ${(policy.stagnationMaxReturnBps ?? 100) / 100}% 이하`);
  }
  const buffer = settings.strategyConfig.sellBelowMaBufferBps;
  exits.push(intraday
    ? typeof buffer === "number" && buffer > 0 ? `현재가가 짧은 평균가격보다 ${buffer / 100}% 넘게 하락` : "현재가가 짧은 평균가격 아래로 하락"
    : "선택한 전략의 매도 조건 충족");
  return {
    buy: intraday
      ? "가격이 최근 고점을 넘고 거래량·상승 흐름 조건을 통과하면 매수 후보로 봅니다. 잔고와 주문 가능 여부를 확인한 뒤 주문합니다."
      : "선택한 전략의 매수 조건을 통과하면 후보로 봅니다. 잔고와 주문 가능 여부를 확인한 뒤 주문합니다.",
    sell: `${exits.join(" / ")} 중 하나라도 해당하면 주문 가능한 시간에 매도합니다. 실제 체결 시점과 가격은 달라질 수 있습니다.`,
  };
}
