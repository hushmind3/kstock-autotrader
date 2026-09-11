const tradeReasonLabels: Record<string, string> = {
  TAKE_PROFIT_TARGET_REACHED: "목표수익에 도달해 팔기",
  STOP_LOSS_TRIGGERED: "손실이 손절 기준에 도달해 팔기",
  TRAILING_PROFIT_TRIGGERED: "수익 추적 중 고점에서 내려와 팔기",
  STAGNATION_EXIT_TRIGGERED: "기다린 기간 동안 수익이 부족해 팔기",
  REENTRY_COOLDOWN: "매도 후 재매수 대기 중",
  REENTRY_WAIT_FOR_NEW_SIGNAL: "새로운 매수 신호를 기다리는 중",
};

export function tradeReasonSummary(reasonCodes: readonly string[]): string | null {
  const labels = reasonCodes.flatMap((code) => tradeReasonLabels[code] ? [tradeReasonLabels[code]] : []);
  return labels.length > 0 ? [...new Set(labels)].join(" · ") : null;
}
