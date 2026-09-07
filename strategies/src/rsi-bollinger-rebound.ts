import { z } from "zod";
import type {
  StrategyDecision,
  StrategyDefinition,
  StrategyMarketSnapshot,
  StrategyRequirements,
} from "@kstock/shared";

export const RsiBollingerSettingsSchema = z
  .object({
    rsiPeriod: z.number().int().min(2).max(60).default(14),
    buyRsi: z.number().min(1).max(50).default(30),
    sellRsi: z.number().min(50).max(99).default(70),
    bollingerPeriod: z.number().int().min(5).max(120).default(20),
    bollingerStdDevBps: z.number().int().min(5_000).max(40_000).default(20_000),
    volumeLookbackDays: z.number().int().min(5).max(120).default(20),
    minAverageVolume: z.number().int().min(0).default(100_000),
  })
  .refine((value) => value.sellRsi > value.buyRsi, {
    message: "매도 RSI는 매수 RSI보다 높아야 합니다.",
    path: ["sellRsi"],
  });

export type RsiBollingerSettings = z.infer<typeof RsiBollingerSettingsSchema>;

function average(values: number[]): number {
  return values.length === 0
    ? 0
    : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function standardDeviation(values: number[], mean: number): number {
  if (values.length === 0) return 0;
  return Math.sqrt(average(values.map((value) => (value - mean) ** 2)));
}

function calculateRsi(prices: number[], period: number): number {
  const recent = prices.slice(-(period + 1));
  if (recent.length < period + 1) return Number.NaN;
  let gains = 0;
  let losses = 0;
  for (let index = 1; index < recent.length; index += 1) {
    const change = recent[index]! - recent[index - 1]!;
    if (change >= 0) gains += change;
    else losses -= change;
  }
  if (losses === 0) return gains === 0 ? 50 : 100;
  const relativeStrength = gains / losses;
  return 100 - 100 / (1 + relativeStrength);
}

export const rsiBollingerReboundStrategy: StrategyDefinition<RsiBollingerSettings> = {
  id: "rsi-bollinger-rebound",
  version: "1.0.0",
  name: "RSI·볼린저 반등",
  description:
    "가격이 볼린저 하단에 닿고 RSI가 과매도 구간일 때 반등을 노리는 역추세 전략입니다.",
  defaultConfig: () => RsiBollingerSettingsSchema.parse({}),
  configFields: [
    { key: "rsiPeriod", label: "RSI 계산 기간", kind: "number", defaultValue: 14, suffix: "일", min: 2, max: 60, help: "최근 가격 상승폭과 하락폭을 비교할 기간입니다." },
    { key: "buyRsi", label: "매수 RSI 기준", kind: "number", defaultValue: 30, min: 1, max: 50, help: "RSI가 이 값 이하일 때 과매도 조건으로 봅니다." },
    { key: "sellRsi", label: "매도 RSI 기준", kind: "number", defaultValue: 70, min: 50, max: 99, help: "보유 중 RSI가 이 값 이상이면 매도 후보로 봅니다." },
    { key: "bollingerPeriod", label: "볼린저 계산 기간", kind: "number", defaultValue: 20, suffix: "일", min: 5, max: 120, help: "평균과 가격 변동폭을 계산할 기간입니다." },
    { key: "bollingerStdDevBps", label: "볼린저 변동폭 배수", kind: "percent", defaultValue: 20_000, min: 50, max: 400, help: "200%는 표준편차 2배입니다. 값이 클수록 매수 신호가 드뭅니다." },
    { key: "volumeLookbackDays", label: "평균 거래량 확인 기간", kind: "number", defaultValue: 20, suffix: "일", min: 5, max: 120, help: "거래량이 너무 적은 종목을 거르기 위한 기간입니다." },
    { key: "minAverageVolume", label: "필요한 하루 평균 거래량", kind: "number", defaultValue: 100_000, suffix: "주", min: 0, help: "평균 거래량이 이 수량보다 적으면 매수하지 않습니다." },
  ],

  requirements(config): StrategyRequirements {
    const parsed = RsiBollingerSettingsSchema.parse(config);
    return {
      minimumDailyBars: Math.max(
        parsed.rsiPeriod,
        parsed.bollingerPeriod,
        parsed.volumeLookbackDays,
      ),
      needsCurrentPrice: true,
      needsCumulativeVolume: false,
    };
  },

  validateConfig(input): RsiBollingerSettings {
    return RsiBollingerSettingsSchema.parse(input);
  },

  evaluate(snapshot: StrategyMarketSnapshot, rawConfig): StrategyDecision {
    const config = RsiBollingerSettingsSchema.parse(rawConfig);
    const bars = [...snapshot.completedDailyBars]
      .filter((bar) => bar.close > 0 && bar.volume >= 0)
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

    const closesWithCurrent = [...bars.map((bar) => bar.close), snapshot.quote.price];
    const rsi = calculateRsi(closesWithCurrent, config.rsiPeriod);
    const bandPrices = closesWithCurrent.slice(-config.bollingerPeriod);
    const middleBand = average(bandPrices);
    const deviation = standardDeviation(bandPrices, middleBand);
    const multiplier = config.bollingerStdDevBps / 10_000;
    const lowerBand = middleBand - deviation * multiplier;
    const upperBand = middleBand + deviation * multiplier;
    const averageVolume = Math.round(
      average(bars.slice(-config.volumeLookbackDays).map((bar) => bar.volume)),
    );
    const metrics = {
      currentPrice: snapshot.quote.price,
      rsi: Math.round(rsi * 100) / 100,
      lowerBand: Math.round(lowerBand * 100) / 100,
      middleBand: Math.round(middleBand * 100) / 100,
      upperBand: Math.round(upperBand * 100) / 100,
      averageVolume,
    };

    if (snapshot.hasPosition) {
      return rsi >= config.sellRsi || snapshot.quote.price >= upperBand
        ? {
            action: "SELL",
            reasonCodes: [
              ...(rsi >= config.sellRsi ? ["RSI_OVERBOUGHT"] : []),
              ...(snapshot.quote.price >= upperBand ? ["PRICE_AT_UPPER_BAND"] : []),
            ],
            metrics,
          }
        : { action: "HOLD", reasonCodes: ["REBOUND_EXIT_NOT_MET"], metrics };
    }

    const failures: string[] = [];
    if (rsi > config.buyRsi) failures.push("RSI_NOT_OVERSOLD");
    if (snapshot.quote.price > lowerBand) failures.push("PRICE_ABOVE_LOWER_BAND");
    if (averageVolume < config.minAverageVolume) failures.push("AVERAGE_VOLUME_TOO_LOW");
    return failures.length > 0
      ? { action: "HOLD", reasonCodes: failures, metrics }
      : { action: "BUY", reasonCodes: ["RSI_OVERSOLD", "PRICE_AT_LOWER_BAND", "VOLUME_ACCEPTABLE"], metrics };
  },
};
