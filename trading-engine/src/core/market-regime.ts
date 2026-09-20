import type { KospiIndexSnapshot, MarketRegimeSettings } from "@kstock/shared";

export type MarketRegimeStatus = "DISABLED" | "WAITING_FOR_DATA" | "NORMAL" | "WEAK";

export type MarketRegimeReasonCode =
  | "FILTER_DISABLED"
  | "DAILY_BREADTH_NOT_READY"
  | "DAILY_BREADTH_WEAK"
  | "KOSPI_INDEX_NOT_READY"
  | "KOSPI_INDEX_DOWN"
  | "INTRADAY_BREADTH_NOT_READY"
  | "INTRADAY_BREADTH_WEAK"
  | "MARKET_HEALTHY";

export interface MarketRegimeSnapshot {
  enabled: boolean;
  status: MarketRegimeStatus;
  buyAllowed: boolean;
  reasonCode: MarketRegimeReasonCode;
  dailySampleCount: number;
  dailyAboveLongMaBps: number | null;
  intradaySampleCount: number;
  intradayAdvancingBps: number | null;
  kospiIndex: KospiIndexSnapshot | null;
  checkedAt: string;
}

export interface MarketRegimeEvaluationInput {
  settings: MarketRegimeSettings;
  dailySampleCount: number;
  dailyAboveLongMaCount: number;
  intradaySampleCount: number;
  intradayAdvancingCount: number;
  kospiIndex: KospiIndexSnapshot | null;
  requireIntradayEvidence: boolean;
  checkedAt: string;
}

function breadthBps(count: number, sampleCount: number): number | null {
  if (sampleCount <= 0) return null;
  return Math.max(0, Math.min(10_000, Math.round((count / sampleCount) * 10_000)));
}

/**
 * A deterministic market-wide buy gate. It never blocks risk-reducing sells;
 * callers apply this result only to new buy orders.
 */
export function evaluateMarketRegime(
  input: MarketRegimeEvaluationInput,
): MarketRegimeSnapshot {
  const dailyAboveLongMaBps = breadthBps(
    input.dailyAboveLongMaCount,
    input.dailySampleCount,
  );
  const intradayAdvancingBps = breadthBps(
    input.intradayAdvancingCount,
    input.intradaySampleCount,
  );
  const base = {
    enabled: input.settings.enabled,
    dailySampleCount: input.dailySampleCount,
    dailyAboveLongMaBps,
    intradaySampleCount: input.intradaySampleCount,
    intradayAdvancingBps,
    kospiIndex: input.kospiIndex,
    checkedAt: input.checkedAt,
  };

  if (!input.settings.enabled) {
    return {
      ...base,
      status: "DISABLED",
      buyAllowed: true,
      reasonCode: "FILTER_DISABLED",
    };
  }
  if (input.requireIntradayEvidence && input.settings.blockWhenKospiDown) {
    if (input.kospiIndex === null) {
      return {
        ...base,
        status: "WAITING_FOR_DATA",
        buyAllowed: false,
        reasonCode: "KOSPI_INDEX_NOT_READY",
      };
    }
    if (input.kospiIndex.direction === "DOWN" || input.kospiIndex.changeRateBps < 0) {
      return {
        ...base,
        status: "WEAK",
        buyAllowed: false,
        reasonCode: "KOSPI_INDEX_DOWN",
      };
    }
  }
  if (
    input.dailySampleCount < input.settings.minimumSampleSize ||
    dailyAboveLongMaBps === null
  ) {
    return {
      ...base,
      status: "WAITING_FOR_DATA",
      buyAllowed: false,
      reasonCode: "DAILY_BREADTH_NOT_READY",
    };
  }
  if (dailyAboveLongMaBps < input.settings.minimumAboveLongMaBps) {
    return {
      ...base,
      status: "WEAK",
      buyAllowed: false,
      reasonCode: "DAILY_BREADTH_WEAK",
    };
  }
  if (input.requireIntradayEvidence) {
    if (
      input.intradaySampleCount < input.settings.minimumSampleSize ||
      intradayAdvancingBps === null
    ) {
      return {
        ...base,
        status: "WAITING_FOR_DATA",
        buyAllowed: false,
        reasonCode: "INTRADAY_BREADTH_NOT_READY",
      };
    }
    if (intradayAdvancingBps < input.settings.minimumIntradayAdvancingBps) {
      return {
        ...base,
        status: "WEAK",
        buyAllowed: false,
        reasonCode: "INTRADAY_BREADTH_WEAK",
      };
    }
  }
  return {
    ...base,
    status: "NORMAL",
    buyAllowed: true,
    reasonCode: "MARKET_HEALTHY",
  };
}
