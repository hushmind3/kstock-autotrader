import { z } from "zod";
import type {
  IntradayTradeSample,
  Quote,
  StrategyDecision,
  StrategyDefinition,
} from "@kstock/shared";

export const IntradayMomentumSettingsSchema = z
  .object({
    lookbackSeconds: z.number().int().min(30).max(3_600).default(120),
    shortWindowSeconds: z.number().int().min(5).max(600).default(30),
    minSamples: z.number().int().min(3).max(3_601).default(20),
    maxGapSeconds: z.number().int().min(1).max(60).default(20),
    minWindowVolume: z.number().int().min(1).default(1_000),
    entryMomentumBps: z.number().int().min(0).max(1_000).default(10),
    maxExtensionBps: z.number().int().min(1).max(2_000).default(80),
    minLongMomentumBps: z.number().int().min(-1_000).max(1_000).default(-20),
    sellBelowMaBufferBps: z.number().int().min(0).max(1_000).default(0),
  })
  .refine((value) => value.shortWindowSeconds < value.lookbackSeconds, {
    path: ["shortWindowSeconds"], message: "짧은 관측기간은 전체 관측기간보다 짧아야 합니다.",
  })
  .refine((value) => value.maxGapSeconds < value.shortWindowSeconds, {
    path: ["maxGapSeconds"], message: "허용 시세 공백은 짧은 관측기간보다 작아야 합니다.",
  })
  .refine((value) => value.minSamples <= value.lookbackSeconds + 1, {
    path: ["minSamples"], message: "초당 한 개의 시세로 관측기간 안에 모을 수 있는 개수를 입력해 주세요.",
  })
  .refine((value) => value.maxExtensionBps >= value.entryMomentumBps, {
    path: ["maxExtensionBps"], message: "추격매수 제한은 진입 최소 상승폭 이상이어야 합니다.",
  });

export type IntradayMomentumSettings = z.infer<typeof IntradayMomentumSettingsSchema>;

function isoInstant(value: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
  const instant = Date.parse(value);
  const localDateTime = value.slice(0, 19);
  const localInstant = Date.parse(`${localDateTime}Z`);
  return Number.isFinite(instant) && Number.isFinite(localInstant) &&
    new Date(localInstant).toISOString().slice(0, 19) === localDateTime
    ? instant : null;
}

function quoteInstant(quote: Quote): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(quote.tradingDate) || !/^\d{6}$/.test(quote.tradingTime)) return null;
  const time = quote.tradingTime;
  return isoInstant(`${quote.tradingDate}T${time.slice(0, 2)}:${time.slice(2, 4)}:${time.slice(4, 6)}+09:00`);
}

function average(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function changeBps(current: number, reference: number): number {
  return ((current - reference) / reference) * 10_000;
}

export const intradayMomentumStrategy: StrategyDefinition<IntradayMomentumSettings> = {
  id: "intraday-momentum",
  version: "1.0.0",
  name: "실시간 짧은 매매",
  description:
    "실제로 수신한 초 단위 시세의 짧은 고점 돌파와 거래량을 확인하고, 보유 중 짧은 평균가격 아래로 내려가면 매도합니다. 기본 수치는 검증용 예시입니다.",
  defaultConfig: () => IntradayMomentumSettingsSchema.parse({}),
  configFields: [
    { key: "lookbackSeconds", label: "전체 시세 관측기간", kind: "number", defaultValue: 120, suffix: "초", min: 30, max: 3_600, help: "실시간 시세를 모아 전체 흐름과 실제 거래량 증가를 확인하는 기간입니다." },
    { key: "shortWindowSeconds", label: "짧은 흐름 관측기간", kind: "number", defaultValue: 30, suffix: "초", min: 5, max: 600, help: "현재 시세 직전의 평균가격과 고점을 확인할 기간입니다." },
    { key: "minSamples", label: "필요한 시세 개수", kind: "number", defaultValue: 20, suffix: "개", min: 3, max: 3_601, help: "초당 최대 한 개씩 실제 수신한 시세가 이 개수 이상이어야 합니다." },
    { key: "maxGapSeconds", label: "허용 시세 공백", kind: "number", defaultValue: 20, suffix: "초", min: 1, max: 60, help: "연속 시세 사이 공백이나 현재 시세 수신지연이 이 시간을 넘으면 새 시세를 기다립니다." },
    { key: "minWindowVolume", label: "관측기간 최소 거래량", kind: "number", defaultValue: 1_000, suffix: "주", min: 1, help: "첫 관측부터 현재까지 누적 거래량이 이 수량 이상 증가해야 매수합니다." },
    { key: "entryMomentumBps", label: "진입 최소 상승폭", kind: "percent", defaultValue: 10, min: 0, max: 10, help: "현재가가 짧은 평균가격보다 이 비율 이상 높고 직전 관측 고점을 넘어야 합니다." },
    { key: "maxExtensionBps", label: "추격매수 제한", kind: "percent", defaultValue: 80, min: 0.01, max: 20, help: "현재가가 짧은 평균가격보다 이 비율을 초과해 높으면 매수하지 않습니다." },
    { key: "minLongMomentumBps", label: "전체 흐름 최소 변화율", kind: "percent", defaultValue: -20, min: -10, max: 10, help: "관측기간 앞 절반 평균과 뒤 절반 평균을 비교합니다. -0.2%면 그보다 크게 하락할 때 매수하지 않습니다." },
    { key: "sellBelowMaBufferBps", label: "평균가격 이탈 매도 여유폭", kind: "percent", defaultValue: 0, min: 0, max: 10, help: "현재가가 짧은 평균가격보다 이 비율을 초과해 낮아지면 보유 수량을 매도합니다." },
  ],

  requirements(rawConfig) {
    const config = IntradayMomentumSettingsSchema.parse(rawConfig);
    return {
      minimumDailyBars: 0,
      needsCurrentPrice: true,
      needsCumulativeVolume: true,
      intradayWindowSeconds: config.lookbackSeconds,
    };
  },

  validateConfig(input) {
    return IntradayMomentumSettingsSchema.parse(input);
  },

  evaluate(snapshot, rawConfig): StrategyDecision {
    const config = IntradayMomentumSettingsSchema.parse(rawConfig);
    const readiness = { collectedSeconds: 0, requiredSeconds: config.lookbackSeconds, sampleCount: 0 };
    const notReady = (reason: string, metrics: StrategyDecision["metrics"] = {}): StrategyDecision => ({
      action: "NOT_READY", reasonCodes: [reason], metrics: { ...readiness, ...metrics },
    });
    const quote = snapshot.quote;
    if (!quote) return notReady("QUOTE_MISSING");
    if (quote.symbol !== snapshot.symbol || !Number.isFinite(quote.price) || quote.price <= 0 ||
        !Number.isSafeInteger(quote.cumulativeVolume) || quote.cumulativeVolume <= 0) return notReady("QUOTE_INVALID");
    if (quote.stale) return notReady("QUOTE_STALE");
    if (quote.brokerTimestampVerified !== true) return notReady("QUOTE_TIME_UNVERIFIED");
    const currentAt = quoteInstant(quote);
    const receivedAt = isoInstant(quote.receivedAt);
    if (currentAt === null || receivedAt === null) return notReady("QUOTE_TIME_INVALID");
    if (receivedAt < currentAt || receivedAt - currentAt > config.maxGapSeconds * 1_000) {
      return notReady("QUOTE_STALE");
    }
    const samples = snapshot.recentTradeSamples ?? [];
    if (samples.length === 0) return notReady("INTRADAY_SAMPLES_MISSING");
    const timed: Array<IntradayTradeSample & { instant: number }> = [];
    let previousInstant: number | null = null;
    for (const sample of samples) {
      const instant = isoInstant(sample.observedAt);
      if (instant === null || !Number.isFinite(sample.price) || sample.price <= 0 ||
          !Number.isSafeInteger(sample.cumulativeVolume) || sample.cumulativeVolume < 0) {
        return notReady("INTRADAY_SAMPLE_INVALID");
      }
      if (instant > currentAt) return notReady("INTRADAY_SAMPLE_IN_FUTURE");
      if (previousInstant !== null) {
        if (instant <= previousInstant) return notReady("INTRADAY_SAMPLES_OUT_OF_ORDER");
        if (Math.floor(instant / 1_000) === Math.floor(previousInstant / 1_000)) {
          return notReady("INTRADAY_SAMPLES_SAME_SECOND");
        }
      }
      previousInstant = instant;
      if (instant >= currentAt - config.lookbackSeconds * 1_000) timed.push({ ...sample, instant });
    }
    const latest = timed.at(-1);
    // Require the quote to be the latest real WebSocket sample. A REST quote
    // must not extend an old stream or manufacture a breakout at a new time.
    if (!latest || latest.instant !== currentAt || latest.price !== quote.price ||
        latest.cumulativeVolume !== quote.cumulativeVolume) return notReady("QUOTE_SAMPLE_MISMATCH");
    readiness.collectedSeconds = (currentAt - timed[0]!.instant) / 1_000;
    readiness.sampleCount = timed.length;
    let largestGapSeconds = 0;
    for (let index = 1; index < timed.length; index += 1) {
      const previous = timed[index - 1]!;
      const current = timed[index]!;
      largestGapSeconds = Math.max(largestGapSeconds, (current.instant - previous.instant) / 1_000);
      if (current.cumulativeVolume < previous.cumulativeVolume) return notReady("INTRADAY_VOLUME_RESET");
    }
    if (largestGapSeconds > config.maxGapSeconds) return notReady("INTRADAY_SAMPLE_GAP", { largestGapSeconds });
    if (readiness.collectedSeconds < config.lookbackSeconds - config.maxGapSeconds || timed.length < config.minSamples) {
      return notReady("INTRADAY_WINDOW_INCOMPLETE");
    }

    // Current-time observations never enter the historical average or high.
    const historical = timed.slice(0, -1);
    const shortSamples = historical.filter((sample) => sample.instant >= currentAt - config.shortWindowSeconds * 1_000);
    if (shortSamples.length < 2 || currentAt - shortSamples[0]!.instant < (config.shortWindowSeconds - config.maxGapSeconds) * 1_000) {
      return notReady("INTRADAY_SHORT_WINDOW_INCOMPLETE");
    }
    const midpoint = currentAt - config.lookbackSeconds * 500;
    const earlier = historical.filter((sample) => sample.instant < midpoint);
    const later = historical.filter((sample) => sample.instant >= midpoint);
    if (earlier.length === 0 || later.length === 0) return notReady("INTRADAY_WINDOW_INCOMPLETE");
    const shortMa = average(shortSamples.map((sample) => sample.price));
    const recentHigh = Math.max(...shortSamples.map((sample) => sample.price));
    const momentumBps = changeBps(quote.price, shortMa);
    const longMomentumBps = changeBps(average(later.map((sample) => sample.price)), average(earlier.map((sample) => sample.price)));
    const windowVolume = latest.cumulativeVolume - timed[0]!.cumulativeVolume;
    const metrics = {
      ...readiness,
      largestGapSeconds,
      currentPrice: quote.price,
      shortMa,
      recentHigh,
      momentumBps: Math.round(momentumBps),
      longMomentumBps: Math.round(longMomentumBps),
      windowVolume,
      observedThrough: latest.observedAt,
    };
    if (snapshot.hasPosition) {
      return quote.price < shortMa * (1 - config.sellBelowMaBufferBps / 10_000)
        ? { action: "SELL", reasonCodes: ["PRICE_BELOW_INTRADAY_SHORT_MA"], metrics }
        : { action: "HOLD", reasonCodes: ["INTRADAY_EXIT_NOT_MET"], metrics };
    }
    const failures: string[] = [];
    if (quote.price <= recentHigh) failures.push("INTRADAY_HIGH_NOT_BROKEN");
    if (momentumBps < config.entryMomentumBps) failures.push("INTRADAY_MOMENTUM_TOO_LOW");
    if (momentumBps > config.maxExtensionBps) failures.push("INTRADAY_PRICE_EXTENDED");
    if (longMomentumBps < config.minLongMomentumBps) failures.push("INTRADAY_TREND_DECLINING");
    if (windowVolume < config.minWindowVolume) failures.push("INTRADAY_VOLUME_TOO_LOW");
    return failures.length > 0
      ? { action: "HOLD", reasonCodes: failures, metrics }
      : { action: "BUY", reasonCodes: ["INTRADAY_HIGH_BROKEN", "INTRADAY_MOMENTUM_CONFIRMED", "INTRADAY_VOLUME_CONFIRMED"], metrics };
  },
};
