import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/client-api", () => ({
  getJson: vi.fn(),
  koreanErrorMessage: (_cause: unknown, fallback: string) => fallback,
}));

import {
  strategyModeFor,
  withStrategyEnabled,
} from "../components/derivatives-automation-settings-card";
import type { DerivativesAutomationSettings } from "../lib/api-types";

const settings: DerivativesAutomationSettings = {
  schemaVersion: 1,
  connectionEnabled: true,
  environment: "live",
  autoTradingEnabled: false,
  resumeAfterRestart: true,
  emergencyHalt: false,
  newPositionsPaused: true,
  mode: "HEDGE",
  contractSelection: "AUTO_MINI_KOSPI200",
  manualContractCode: "",
  allowNightSession: true,
  orderType: "MARKET",
  limitOffsetTicks: 0,
  unfilledTimeoutSeconds: 60,
  maxContracts: 2,
  maxDailyLossKrw: 100_000,
  maxMarginUsageBps: 5_000,
  hedge: { enabled: false, hedgeRatioBps: 10_000, minRebalanceContracts: 1 },
  directional: {
    enabled: false,
    sideMode: "BOTH",
    fastPeriod: 5,
    slowPeriod: 20,
    minimumGapBps: 15,
    targetContracts: 1,
  },
};

describe("선물·옵션 운용 설정", () => {
  it("현물 방어와 흐름 매매를 함께 켜면 두 방식을 함께 쓰도록 저장한다", () => {
    const withHedge = withStrategyEnabled(settings, "hedge", true);
    const withBoth = withStrategyEnabled(withHedge, "directional", true);

    expect(withBoth.mode).toBe("HEDGE_AND_DIRECTIONAL");
    expect(withBoth.hedge.enabled).toBe(true);
    expect(withBoth.directional.enabled).toBe(true);
  });

  it("한 가지 방식만 켠 경우 해당 운용 방식으로 맞춘다", () => {
    expect(strategyModeFor(true, false)).toBe("HEDGE");
    expect(strategyModeFor(false, true)).toBe("DIRECTIONAL");
  });

  it("운용 방식 토글은 실제 자동주문 시작 상태를 임의로 바꾸지 않는다", () => {
    const armed = { ...settings, autoTradingEnabled: true };
    const next = withStrategyEnabled(armed, "hedge", true);

    expect(next.autoTradingEnabled).toBe(true);
    expect(next.newPositionsPaused).toBe(true);
  });
});
