import { z } from "zod";
import type {
  StrategyDecision,
  StrategyDefinition,
  StrategyMarketSnapshot,
  StrategyRequirements,
} from "@kstock/shared";

export const BreakoutVolumeSettingsSchema = z.object({
  breakoutLookbackDays: z.number().int().min(5).max(120).default(20),
  breakoutBufferBps: z.number().int().min(0).max(2_000).default(10),
  volumeLookbackDays: z.number().int().min(5).max(120).default(20),
  minVolumeRatioBps: z.number().int().min(1_000).max(100_000).default(10_000),
  minAverageVolume: z.number().int().min(0).default(100_000),
  exitLookbackDays: z.number().int().min(2).max(60).default(10),
});

export type BreakoutVolumeSettings = z.infer<typeof BreakoutVolumeSettingsSchema>;

function average(values: number[]): number {
  return values.length === 0
    ? 0
    : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function basisPointChange(current: number, reference: number): number {
  return reference <= 0 ? 0 : Math.round(((current - reference) / reference) * 10_000);
}

export const breakoutVolumeStrategy: StrategyDefinition<BreakoutVolumeSettings> = {
  id: "breakout-volume",
  version: "1.0.0",
  name: "고점 돌파·거래량",
  description:
    "현재가가 최근 고점을 돌파하고 오늘 거래량이 평소 수준을 충족할 때 진입하는 추세 돌파 전략입니다.",
  defaultConfig: () => BreakoutVolumeSettingsSchema.parse({}),
  configFields: [
    { key: "breakoutLookbackDays", label: "돌파 고점 확인 기간", kind: "number", defaultValue: 20, suffix: "일", min: 5, max: 120, help: "이 기간의 최고가를 오늘 현재가가 넘어야 합니다." },
    { key: "breakoutBufferBps", label: "고점 돌파 여유폭", kind: "percent", defaultValue: 10, min: 0, help: "최근 고점보다 이 비율만큼 더 올라야 돌파로 인정합니다." },
    { key: "volumeLookbackDays", label: "평균 거래량 확인 기간", kind: "number", defaultValue: 20, suffix: "일", min: 5, max: 120, help: "오늘 거래량과 비교할 평소 거래량의 기간입니다." },
    { key: "minVolumeRatioBps", label: "평균 대비 오늘 거래량", kind: "percent", defaultValue: 10_000, min: 10, help: "예: 100%면 오늘 누적 거래량이 최근 평균 이상이어야 합니다." },
    { key: "minAverageVolume", label: "필요한 하루 평균 거래량", kind: "number", defaultValue: 100_000, suffix: "주", min: 0, help: "거래가 너무 적은 종목을 매수 대상에서 제외합니다." },
    { key: "exitLookbackDays", label: "하락 이탈 매도 기간", kind: "number", defaultValue: 10, suffix: "일", min: 2, max: 60, help: "보유 중 현재가가 이 기간의 최저가 아래로 내려가면 매도 후보로 봅니다." },
  ],

  requirements(config): StrategyRequirements {
    const parsed = BreakoutVolumeSettingsSchema.parse(config);
    return {
      minimumDailyBars: Math.max(
        parsed.breakoutLookbackDays,
        parsed.volumeLookbackDays,
        parsed.exitLookbackDays,
      ),
      needsCurrentPrice: true,
      needsCumulativeVolume: true,
    };
  },

  validateConfig(input): BreakoutVolumeSettings {
    return BreakoutVolumeSettingsSchema.parse(input);
  },

  evaluate(snapshot: StrategyMarketSnapshot, rawConfig): StrategyDecision {
    const config = BreakoutVolumeSettingsSchema.parse(rawConfig);
    const bars = [...snapshot.completedDailyBars]
      .filter((bar) => bar.high > 0 && bar.low > 0 && bar.volume >= 0)
      .sort((left, right) => left.tradingDate.localeCompare(right.tradingDate));
    const required = this.requirements(config).minimumDailyBars;
    if (!snapshot.quote || snapshot.quote.price <= 0) {
      return { action: "NOT_READY", reasonCodes: ["QUOTE_MISSING"], metrics: {} };
    }
    if (bars.length < required) {
      return {
        action: "NOT_READY",
        reasonCodes: ["INSUFFICIENT_DAILY_BARS"],
        metrics: { availableBars: bars.length, requiredBars: required },
      };
    }

    const breakoutHigh = Math.max(...bars.slice(-config.breakoutLookbackDays).map((bar) => bar.high));
    const exitLow = Math.min(...bars.slice(-config.exitLookbackDays).map((bar) => bar.low));
    const averageVolume = Math.round(
      average(bars.slice(-config.volumeLookbackDays).map((bar) => bar.volume)),
    );
    const priceVsBreakoutBps = basisPointChange(snapshot.quote.price, breakoutHigh);
    const currentVolumeRatioBps = averageVolume <= 0
      ? 0
      : Math.round((snapshot.quote.cumulativeVolume / averageVolume) * 10_000);
    const metrics = {
      currentPrice: snapshot.quote.price,
      breakoutHigh,
      exitLow,
      priceVsBreakoutBps,
      averageVolume,
      currentVolume: snapshot.quote.cumulativeVolume,
      currentVolumeRatioBps,
    };

    if (snapshot.hasPosition) {
      return snapshot.quote.price < exitLow
        ? { action: "SELL", reasonCodes: ["PRICE_BELOW_BREAKOUT_EXIT_LOW"], metrics }
        : { action: "HOLD", reasonCodes: ["BREAKOUT_EXIT_NOT_MET"], metrics };
    }

    const failures: string[] = [];
    if (priceVsBreakoutBps < config.breakoutBufferBps) failures.push("RECENT_HIGH_NOT_BROKEN");
    if (averageVolume < config.minAverageVolume) failures.push("AVERAGE_VOLUME_TOO_LOW");
    if (currentVolumeRatioBps < config.minVolumeRatioBps) failures.push("CURRENT_VOLUME_RATIO_TOO_LOW");
    return failures.length > 0
      ? { action: "HOLD", reasonCodes: failures, metrics }
      : { action: "BUY", reasonCodes: ["RECENT_HIGH_BROKEN", "VOLUME_CONFIRMED"], metrics };
  },
};
