import {
  MovingAverageSettingsSchema,
  type MovingAverageSettings,
  type StrategyDecision,
  type StrategyDefinition,
  type StrategyMarketSnapshot,
  type StrategyRequirements,
} from "@kstock/shared";

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function basisPointChange(current: number, previous: number): number {
  if (previous === 0) return 0;
  return Math.round(((current - previous) / previous) * 10_000);
}

function hold(reasonCodes: string[], metrics: StrategyDecision["metrics"]): StrategyDecision {
  return { action: "HOLD", reasonCodes, metrics };
}

export const movingAverageStrategy: StrategyDefinition<MovingAverageSettings> = {
  id: "moving-average",
  version: "1.0.0",
  name: "21/60일 이동평균",
  description:
    "단기 이동평균의 상승세, 현재가 위치, 장기 흐름과 거래량을 함께 확인하는 추세 전략입니다.",
  defaultConfig: () => MovingAverageSettingsSchema.parse({}),
  configFields: [
    { key: "shortPeriod", label: "단기 이동평균 기간", kind: "number", defaultValue: 21, suffix: "일", min: 2, max: 120, help: "최근 며칠의 종가 평균을 단기 흐름으로 볼지 정합니다." },
    { key: "longPeriod", label: "장기 이동평균 기간", kind: "number", defaultValue: 60, suffix: "일", min: 3, max: 250, help: "장기 흐름을 볼 기간입니다. 단기 기간보다 길어야 합니다." },
    { key: "slopeLookbackDays", label: "오르내림 비교 기간", kind: "number", defaultValue: 3, suffix: "일", min: 1, max: 20, help: "현재 이동평균을 며칠 전 이동평균과 비교할지 정합니다." },
    { key: "minShortSlopeBps", label: "단기선 최소 상승률", kind: "percent", defaultValue: 1, help: "비교기간 동안 단기선이 이 비율 이상 올라야 매수 조건을 통과합니다." },
    { key: "minLongSlopeBps", label: "장기선 최소 변화율", kind: "percent", defaultValue: -100, help: "장기선의 허용 하락폭입니다. -1%면 그보다 더 하락할 때 매수하지 않습니다." },
    { key: "volumeLookbackDays", label: "평균 거래량 확인 기간", kind: "number", defaultValue: 20, suffix: "일", min: 1, max: 120, help: "최근 며칠의 거래량 평균을 사용할지 정합니다." },
    { key: "minAverageVolume", label: "필요한 하루 평균 거래량", kind: "number", defaultValue: 100_000, suffix: "주", min: 0, help: "평균 거래량이 이 수량보다 적으면 매수하지 않습니다." },
    { key: "minCurrentVolume", label: "오늘 필요한 최소 거래량", kind: "number", defaultValue: 0, suffix: "주", min: 0, help: "오늘 누적 거래량 기준입니다. 0이면 이 조건을 사용하지 않습니다." },
    { key: "sellOnShortSlopeBps", label: "단기선 하락 매도 기준", kind: "percent", defaultValue: -1, help: "단기선 변화율이 이 값 이하가 되면 보유종목을 매도 후보로 봅니다." },
    { key: "sellBelowMaBufferBps", label: "가격 이탈 매도 여유폭", kind: "percent", defaultValue: 0, min: 0, help: "0%면 현재가가 단기선 아래로 내려가는 즉시 매도 후보가 됩니다." },
  ],

  requirements(config): StrategyRequirements {
    const parsed = MovingAverageSettingsSchema.parse(config);
    return {
      minimumDailyBars:
        Math.max(parsed.longPeriod, parsed.shortPeriod, parsed.volumeLookbackDays) +
        parsed.slopeLookbackDays,
      needsCurrentPrice: true,
      needsCumulativeVolume: true,
    };
  },

  validateConfig(input): MovingAverageSettings {
    return MovingAverageSettingsSchema.parse(input);
  },

  evaluate(snapshot: StrategyMarketSnapshot, rawConfig: MovingAverageSettings): StrategyDecision {
    const config = MovingAverageSettingsSchema.parse(rawConfig);
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

    const closes = bars.map((bar) => bar.close);
    const volumes = bars.map((bar) => bar.volume);
    const shortNow = average(closes.slice(-config.shortPeriod));
    const shortPrevious = average(
      closes.slice(
        -(config.shortPeriod + config.slopeLookbackDays),
        -config.slopeLookbackDays,
      ),
    );
    const longNow = average(closes.slice(-config.longPeriod));
    const longPrevious = average(
      closes.slice(
        -(config.longPeriod + config.slopeLookbackDays),
        -config.slopeLookbackDays,
      ),
    );
    const averageVolume = Math.round(average(volumes.slice(-config.volumeLookbackDays)));
    const shortSlopeBps = basisPointChange(shortNow, shortPrevious);
    const longSlopeBps = basisPointChange(longNow, longPrevious);
    const priceVsShortMaBps = basisPointChange(snapshot.quote.price, shortNow);
    const metrics = {
      currentPrice: snapshot.quote.price,
      shortMa: Math.round(shortNow * 100) / 100,
      longMa: Math.round(longNow * 100) / 100,
      shortSlopeBps,
      longSlopeBps,
      priceVsShortMaBps,
      averageVolume,
      currentVolume: snapshot.quote.cumulativeVolume,
    };

    if (snapshot.hasPosition) {
      const shortTurnedDown = shortSlopeBps <= config.sellOnShortSlopeBps;
      const priceBelowShort = priceVsShortMaBps < -config.sellBelowMaBufferBps;
      if (shortTurnedDown || priceBelowShort) {
        return {
          action: "SELL",
          reasonCodes: [
            ...(shortTurnedDown ? ["SHORT_MA_TURNED_DOWN"] : []),
            ...(priceBelowShort ? ["PRICE_BELOW_SHORT_MA"] : []),
          ],
          metrics,
        };
      }
      return hold(["SELL_CONDITIONS_NOT_MET"], metrics);
    }

    const failures: string[] = [];
    if (shortSlopeBps < config.minShortSlopeBps) failures.push("SHORT_MA_NOT_RISING");
    if (priceVsShortMaBps <= 0) failures.push("PRICE_NOT_ABOVE_SHORT_MA");
    if (longSlopeBps < config.minLongSlopeBps) failures.push("LONG_MA_DECLINING");
    if (averageVolume < config.minAverageVolume) failures.push("AVERAGE_VOLUME_TOO_LOW");
    if (snapshot.quote.cumulativeVolume < config.minCurrentVolume) {
      failures.push("CURRENT_VOLUME_TOO_LOW");
    }

    if (failures.length > 0) return hold(failures, metrics);
    return {
      action: "BUY",
      reasonCodes: ["SHORT_MA_RISING", "PRICE_ABOVE_SHORT_MA", "LONG_MA_ACCEPTABLE", "VOLUME_ACCEPTABLE"],
      metrics,
    };
  },
};
