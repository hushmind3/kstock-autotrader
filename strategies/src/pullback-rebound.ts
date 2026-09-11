import { z } from "zod";
import type {
  DailyBar,
  StrategyDecision,
  StrategyDefinition,
  StrategyRequirements,
} from "@kstock/shared";

export const PullbackReboundSettingsSchema = z
  .object({
    shortPeriod: z.number().int().min(2).max(120).default(10),
    longPeriod: z.number().int().min(3).max(250).default(40),
    pullbackLookbackDays: z.number().int().min(1).max(30).default(5),
    slopeLookbackDays: z.number().int().min(1).max(20).default(3),
    minLongSlopeBps: z.number().int().min(-2_000).max(2_000).default(-50),
    reboundBufferBps: z.number().int().min(0).max(1_000).default(20),
    maxPriceVsShortMaBps: z.number().int().min(0).max(5_000).default(500),
    volumeLookbackDays: z.number().int().min(1).max(120).default(20),
    minAverageVolume: z.number().int().min(0).default(100_000),
    sellBelowMaBufferBps: z.number().int().min(0).max(1_000).default(50),
  })
  .refine((value) => value.longPeriod > value.shortPeriod, {
    message: "장기 이동평균 기간은 단기 기간보다 길어야 합니다.",
    path: ["longPeriod"],
  })
  .refine((value) => value.maxPriceVsShortMaBps >= value.reboundBufferBps, {
    message: "최대 이평선 괴리율은 반등 확인 여유폭 이상이어야 합니다.",
    path: ["maxPriceVsShortMaBps"],
  });

export type PullbackReboundSettings = z.infer<typeof PullbackReboundSettingsSchema>;

function average(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function changeBps(current: number, reference: number): number {
  return ((current - reference) / reference) * 10_000;
}

function requiredBars(config: PullbackReboundSettings): number {
  return Math.max(
    config.longPeriod + config.slopeLookbackDays,
    config.shortPeriod + config.pullbackLookbackDays,
    config.volumeLookbackDays,
  );
}

function validTradingDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value;
}

function validBar(bar: DailyBar): boolean {
  return (
    [bar.open, bar.high, bar.low, bar.close].every((value) => Number.isFinite(value) && value > 0) &&
    Number.isFinite(bar.volume) &&
    bar.volume >= 0 &&
    bar.high >= Math.max(bar.open, bar.close) &&
    bar.low <= Math.min(bar.open, bar.close) &&
    bar.high >= bar.low
  );
}

export const pullbackReboundStrategy: StrategyDefinition<PullbackReboundSettings> = {
  id: "pullback-rebound",
  version: "1.0.0",
  name: "눌림 후 반등 매매",
  description:
    "장기 흐름이 유지되는 종목에서 최근 조정 뒤 단기 이동평균을 다시 넘을 때 매수하고, 보유 중 단기선 아래로 이탈하면 매도합니다.",
  defaultConfig: () => PullbackReboundSettingsSchema.parse({}),
  configFields: [
    { key: "shortPeriod", label: "단기 이동평균 기간", kind: "number", defaultValue: 10, suffix: "일", min: 2, max: 120, help: "완성된 일봉 종가로 단기 기준선을 계산합니다." },
    { key: "longPeriod", label: "장기 이동평균 기간", kind: "number", defaultValue: 40, suffix: "일", min: 3, max: 250, help: "장기 흐름을 확인할 기간입니다. 단기 기간보다 길어야 합니다." },
    { key: "pullbackLookbackDays", label: "최근 조정 확인 기간", kind: "number", defaultValue: 5, suffix: "일", min: 1, max: 30, help: "이 기간에 종가가 전날보다 하락하며 당시 단기선에 닿은 날이 있어야 합니다." },
    { key: "slopeLookbackDays", label: "장기 흐름 비교 기간", kind: "number", defaultValue: 3, suffix: "일", min: 1, max: 20, help: "최근 장기 이동평균을 며칠 전 장기 이동평균과 비교할지 정합니다." },
    { key: "minLongSlopeBps", label: "장기선 최소 변화율", kind: "percent", defaultValue: -50, min: -20, max: 20, help: "-0.5%이면 비교기간 동안 장기선이 그보다 크게 하락한 종목은 매수하지 않습니다." },
    { key: "reboundBufferBps", label: "반등 확인 여유폭", kind: "percent", defaultValue: 20, min: 0, max: 10, help: "직전 종가가 단기선 이하일 때 현재가가 단기선과 직전 종가를 이 비율만큼 넘어야 합니다." },
    { key: "maxPriceVsShortMaBps", label: "추격매수 제한", kind: "percent", defaultValue: 500, min: 0, max: 50, help: "현재가가 단기선보다 이 비율을 초과해 높으면 매수하지 않습니다." },
    { key: "volumeLookbackDays", label: "평균 거래량 확인 기간", kind: "number", defaultValue: 20, suffix: "일", min: 1, max: 120, help: "완성된 일봉의 평균 거래량을 계산할 기간입니다." },
    { key: "minAverageVolume", label: "필요한 하루 평균 거래량", kind: "number", defaultValue: 100_000, suffix: "주", min: 0, help: "평균 거래량이 이 수량보다 적은 종목은 매수하지 않습니다." },
    { key: "sellBelowMaBufferBps", label: "단기선 이탈 매도 여유폭", kind: "percent", defaultValue: 50, min: 0, max: 10, help: "보유 중 현재가가 단기선보다 이 비율을 초과해 낮아지면 매도합니다." },
  ],

  requirements(rawConfig): StrategyRequirements {
    const config = PullbackReboundSettingsSchema.parse(rawConfig);
    return {
      minimumDailyBars: requiredBars(config),
      needsCurrentPrice: true,
      needsCumulativeVolume: false,
    };
  },

  validateConfig(input): PullbackReboundSettings {
    return PullbackReboundSettingsSchema.parse(input);
  },

  evaluate(snapshot, rawConfig): StrategyDecision {
    const config = PullbackReboundSettingsSchema.parse(rawConfig);
    const quote = snapshot.quote;
    if (!quote) {
      return { action: "NOT_READY", reasonCodes: ["QUOTE_MISSING"], metrics: {} };
    }
    if (!Number.isFinite(quote.price) || quote.price <= 0 ||
        quote.symbol !== snapshot.symbol || !validTradingDate(quote.tradingDate)) {
      return { action: "NOT_READY", reasonCodes: ["QUOTE_INVALID"], metrics: {} };
    }
    if (quote.stale) {
      return { action: "NOT_READY", reasonCodes: ["QUOTE_STALE"], metrics: {} };
    }

    // The quote's trading date is the evaluation clock. Today's unfinished candle
    // and future candles must not enter an indicator, including historical replay.
    const bars = snapshot.completedDailyBars
      .filter((bar) => bar.symbol === snapshot.symbol && validTradingDate(bar.tradingDate) &&
        bar.tradingDate < quote.tradingDate)
      .sort((left, right) => left.tradingDate.localeCompare(right.tradingDate));
    const required = requiredBars(config);
    if (new Set(bars.map((bar) => bar.tradingDate)).size !== bars.length) {
      return { action: "NOT_READY", reasonCodes: ["DUPLICATE_DAILY_BARS"], metrics: {} };
    }
    if (bars.length < required) {
      return {
        action: "NOT_READY",
        reasonCodes: ["INSUFFICIENT_DAILY_BARS"],
        metrics: { availableBars: bars.length, requiredBars: required },
      };
    }
    const recentBars = bars.slice(-required);
    if (!recentBars.every(validBar)) {
      return { action: "NOT_READY", reasonCodes: ["INVALID_DAILY_BARS"], metrics: {} };
    }

    const closes = recentBars.map((bar) => bar.close);
    const shortMa = average(closes.slice(-config.shortPeriod));
    const longMa = average(closes.slice(-config.longPeriod));
    const previousLongMa = average(closes.slice(
      -(config.longPeriod + config.slopeLookbackDays),
      -config.slopeLookbackDays,
    ));
    const longSlopeBps = changeBps(longMa, previousLongMa);
    const priceVsShortMaBps = changeBps(quote.price, shortMa);
    const averageVolume = average(recentBars.slice(-config.volumeLookbackDays).map((bar) => bar.volume));
    const previousClose = closes.at(-1)!;
    let pullbackDate: string | null = null;
    for (let index = recentBars.length - config.pullbackLookbackDays; index < recentBars.length; index += 1) {
      // Each historical pullback uses only the closes available on that day.
      const shortMaAtDate = average(closes.slice(index - config.shortPeriod + 1, index + 1));
      const bar = recentBars[index]!;
      if (bar.close < closes[index - 1]! && bar.low <= shortMaAtDate) {
        pullbackDate = bar.tradingDate;
      }
    }
    const reboundThreshold = Math.max(shortMa, previousClose) * (1 + config.reboundBufferBps / 10_000);
    const metrics = {
      currentPrice: quote.price,
      shortMa,
      longMa,
      longSlopeBps: Math.round(longSlopeBps),
      priceVsShortMaBps: Math.round(priceVsShortMaBps),
      averageVolume: Math.round(averageVolume),
      previousClose,
      pullbackDate,
      reboundThreshold,
      completedThrough: recentBars.at(-1)!.tradingDate,
    };

    if (snapshot.hasPosition) {
      return quote.price < shortMa * (1 - config.sellBelowMaBufferBps / 10_000)
        ? { action: "SELL", reasonCodes: ["PRICE_BELOW_SHORT_MA"], metrics }
        : { action: "HOLD", reasonCodes: ["PULLBACK_EXIT_NOT_MET"], metrics };
    }

    const failures: string[] = [];
    if (longSlopeBps < config.minLongSlopeBps) failures.push("LONG_MA_DECLINING");
    if (quote.price < longMa) failures.push("PRICE_BELOW_LONG_MA");
    if (pullbackDate === null) failures.push("NO_RECENT_PULLBACK");
    if (previousClose > shortMa) failures.push("REBOUND_ALREADY_ESTABLISHED");
    if (quote.price <= reboundThreshold) failures.push("REBOUND_NOT_CONFIRMED");
    if (quote.price > shortMa * (1 + config.maxPriceVsShortMaBps / 10_000)) failures.push("PRICE_TOO_FAR_ABOVE_SHORT_MA");
    if (averageVolume < config.minAverageVolume) failures.push("AVERAGE_VOLUME_TOO_LOW");
    return failures.length > 0
      ? { action: "HOLD", reasonCodes: failures, metrics }
      : {
          action: "BUY",
          reasonCodes: ["RECENT_PULLBACK", "REBOUND_CONFIRMED", "LONG_MA_ACCEPTABLE", "VOLUME_ACCEPTABLE"],
          metrics,
        };
  },
};
