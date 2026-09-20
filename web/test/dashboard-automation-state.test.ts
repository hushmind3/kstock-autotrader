import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/client-api", () => ({
  formatDateTime: () => "",
  formatNumber: () => "0",
  formatWon: () => "0원",
  getJson: vi.fn(),
}));

import {
  brokerAutomationButtonLabel,
  brokerAutomationLabel,
  brokerMarketStatusLabel,
  brokerOrderReadiness,
  isBrokerAutomationArmed,
  isBrokerNewBuyPaused,
  intradayReadinessText,
  marketRegimeDescription,
  marketRegimeTitle,
} from "../components/dashboard-client";
import type { BrokerDashboard, DashboardResponse } from "../lib/api-types";

describe("실시간 짧은 매매 준비 표시", () => {
  it("기존 계좌에는 새 준비 상태를 만들어 표시하지 않는다", () => {
    expect(intradayReadinessText(broker())).toBeNull();
  });

  it("초기 시세 수집과 준비된 종목 수를 구분한다", () => {
    const observing = { ...broker(), strategyId: "intraday-momentum", intraday: { enabled: true, observedSymbols: 12, readySymbols: 0, requiredSeconds: 60 } };
    expect(intradayReadinessText(observing)).toContain("관측 12종목 · 신호 검사 준비 0종목");
    expect(intradayReadinessText(observing)).toContain("최소 60초");
    expect(intradayReadinessText(observing)).toContain("시세가 쌓이면 자동으로 검사");
    expect(intradayReadinessText({ ...observing, intraday: { ...observing.intraday, readySymbols: 4 } })).toContain("준비 완료는 매수 신호나 주문 체결을 뜻하지 않습니다");
  });
});

function dashboard(
  state: DashboardResponse["market"]["session"]["state"] = "OPEN",
): DashboardResponse {
  return {
    engine: {
      state: "RUNNING",
      startedAt: "2026-09-03T00:00:00.000Z",
      emergencyHalt: false,
      globalAutoTradingEnabled: true,
      newBuysPaused: false,
    },
    market: {
      universeCount: 0,
      buyEligibleCount: 0,
      restrictedInstrumentCount: 0,
      restrictionCounts: {},
      liveSubscriptionCount: 0,
      rotatingScanCount: 0,
      scanProgressPercent: 0,
      scanMode: "WAITING_FOR_DATA",
      lastScanCompletedAt: null,
      lastScanQuoteAt: null,
      candidatesCount: 0,
      lastUniverseSyncAt: null,
      sessions: [
        {
          id: "KRX_EQUITY",
          label: "KRX 현물",
          kind: "equity",
          state,
          phase: state,
          orderable: state === "OPEN",
          tradingDate: "2026-09-03",
          nextTransitionAt: "2026-09-03T00:00:00.000Z",
          checkedAt: "2026-09-03T00:00:00.000Z",
        },
        {
          id: "NXT_EQUITY",
          label: "NXT 현물",
          kind: "equity",
          state: "CLOSED",
          phase: "CLOSED",
          orderable: false,
          tradingDate: "2026-09-03",
          nextTransitionAt: "2026-09-03T00:00:00.000Z",
          checkedAt: "2026-09-03T00:00:00.000Z",
        },
      ],
      session: {
        state,
        tradingDate: "2026-09-03",
        isTradingDay: true,
        nextTransitionAt: "2026-09-03T00:00:00.000Z",
        checkedAt: "2026-09-03T00:00:00.000Z",
      },
      dailyBarBackfill: { completed: 0, total: 0 },
      regime: {
        enabled: true,
        status: "NORMAL",
        buyAllowed: true,
        reasonCode: "MARKET_HEALTHY",
        dailySampleCount: 500,
        dailyAboveLongMaBps: 5_200,
        intradaySampleCount: 300,
        intradayAdvancingBps: 5_100,
        kospiIndex: {
          indexCode: "KOSPI",
          currentValue: 3_407.31,
          change: 10.25,
          changeRateBps: 30,
          direction: "UP",
          tradingDate: "2026-09-03",
          observedAt: "2026-09-03T00:00:00.000Z",
          source: "kiwoom",
        },
        checkedAt: "2026-09-03T00:00:00.000Z",
      },
    },
    pnl: { realized: 0, unrealized: 0, total: 0 },
    brokerMetrics: {
      kiwoom: { pnl: { realized: 0, unrealized: 0, total: 0 }, today: { orders: 0, buys: 0, sells: 0 } },
      koreainvestment: { pnl: { realized: 0, unrealized: 0, total: 0 }, today: { orders: 0, buys: 0, sells: 0 } },
    },
    today: { orders: 0, buys: 0, sells: 0 },
    brokers: [],
    candidates: [],
    positions: [],
    orders: [],
    executions: [],
    errors: [],
  };
}

function broker(): BrokerDashboard {
  return {
    brokerId: "kiwoom",
    name: "키움증권",
    environment: "live",
    enabled: true,
    autoTradingEnabled: true,
    newBuysPaused: false,
    orderRoute: "KRX",
    resumeAfterRestart: true,
    credentialsConfigured: true,
    maskedAccountId: "****1234",
    strategyId: "moving-average",
    connectionState: "CONNECTED",
    connection: {
      environment: "live",
      stage: "READY",
      credentialsStored: true,
      brokerAuthenticated: true,
      accountSynchronized: true,
      marketWebSocketConnected: true,
      accountWebSocketConnected: true,
    marketStatusConfirmed: true,
    orderWindowOpen: true,
    readyForOrders: true,
      runtimeState: "CONNECTED",
      message: "연결 완료",
      lastError: null,
    },
    liveSubscriptions: 0,
    marketStatusConfirmed: true,
    orderWindowOpen: true,
    lastError: null,
  };
}

describe("대시보드 자동매매 상태", () => {
  it("전체 안전 정지 중인 키움 계좌를 시작 가능한 정지 상태로 표시한다", () => {
    const data = dashboard();
    data.engine.emergencyHalt = true;
    const kiwoom = broker();

    expect(isBrokerAutomationArmed(data, kiwoom)).toBe(false);
    expect(brokerAutomationLabel(data, kiwoom)).toBe("자동매매 완전 정지");
    expect(brokerAutomationButtonLabel(kiwoom.enabled, false)).toBe("이 계좌 계속 자동매매 시작");
  });

  it("자동운용 설정과 현재 시장 상태를 섞어 표시하지 않는다", () => {
    const data = dashboard("CLOSED");
    const kiwoom = broker();

    expect(brokerAutomationLabel(data, kiwoom)).toBe("계속 자동매매 중");
    expect(brokerMarketStatusLabel(data, kiwoom)).toBe("시장 대기 · 가격 감시는 계속");
  });

  it("거래 시간 중 공식 시장 상태 확인 대기를 구분한다", () => {
    const kiwoom = broker();
    kiwoom.connection.marketStatusConfirmed = false;

    expect(brokerAutomationLabel(dashboard("OPEN"), kiwoom)).toBe("계속 자동매매 중");
    expect(brokerMarketStatusLabel(dashboard("OPEN"), kiwoom)).toBe("KRX 거래 시간 · 확인 중");
  });

  it("연결 사용이 꺼진 계좌는 설정 안내 문구를 표시한다", () => {
    expect(brokerAutomationButtonLabel(false, false)).toBe("설정에서 연결 사용 켜기");
  });

  it("신규매수 일시정지를 자동매매 완전 정지로 오표시하지 않는다", () => {
    const data = dashboard();
    data.engine.newBuysPaused = true;
    const kiwoom = broker();

    expect(isBrokerAutomationArmed(data, kiwoom)).toBe(true);
    expect(isBrokerNewBuyPaused(data, kiwoom)).toBe(true);
    expect(brokerAutomationLabel(data, kiwoom)).toBe("자동매매 중 · 신규매수 일시정지");
    expect(brokerAutomationButtonLabel(true, true, true)).toBe("신규매수도 다시 시작");
  });

  it("장 종료 중에는 연결 실패처럼 표시하지 않는다", () => {
    const data = dashboard("CLOSED");
    const kiwoom = broker();
    kiwoom.connection.marketStatusConfirmed = false;

    expect(brokerMarketStatusLabel(data, kiwoom)).toBe("시장 대기 · 가격 감시는 계속");
  });

  it("약세장에서는 매도 감시와 신규매수 대기를 구분해 표시한다", () => {
    const data = dashboard("OPEN");
    data.market.regime = {
      ...data.market.regime,
      status: "WEAK",
      buyAllowed: false,
      reasonCode: "INTRADAY_BREADTH_WEAK",
    };

    expect(brokerOrderReadiness(data, broker())).toBe(
      "자동매도 감시 중 · 신규매수 약세장 대기",
    );
  });

  it("코스피가 파란색이면 신규매수만 대기하고 공식 지수 값을 설명한다", () => {
    const data = dashboard("OPEN");
    data.market.regime = {
      ...data.market.regime,
      status: "WEAK",
      buyAllowed: false,
      reasonCode: "KOSPI_INDEX_DOWN",
      kospiIndex: {
        ...data.market.regime.kospiIndex!,
        currentValue: 3_350.1,
        change: -47.2,
        changeRateBps: -139,
        direction: "DOWN",
        source: "koreainvestment",
      },
    };

    expect(marketRegimeTitle(data)).toBe("코스피 파란색 · 신규매수 자동 대기");
    expect(marketRegimeDescription(data)).toContain("한국투자증권 공식 코스피");
    expect(marketRegimeDescription(data)).toContain("-1.39%");
    expect(marketRegimeDescription(data)).toContain("새 종목 매수만 쉽니다");
    expect(brokerOrderReadiness(data, broker())).toBe(
      "자동매도 감시 중 · 코스피 파란색이라 신규매수 대기",
    );
  });

  it("코스피 공식 값이 없거나 오래되면 추측하지 않고 신규매수를 기다린다", () => {
    const data = dashboard("OPEN");
    data.market.regime = {
      ...data.market.regime,
      status: "WAITING_FOR_DATA",
      buyAllowed: false,
      reasonCode: "KOSPI_INDEX_NOT_READY",
      kospiIndex: null,
    };

    expect(marketRegimeTitle(data)).toBe("코스피 자료 확인 중 · 신규매수 대기");
    expect(marketRegimeDescription(data)).toContain("최근 값인지 확인");
    expect(brokerOrderReadiness(data, broker())).toBe(
      "자동매도 감시 중 · 코스피 자료 확인 중",
    );
  });

  it("코스피가 보합 이상이고 다른 장세 조건도 통과하면 신규매수 가능으로 표시한다", () => {
    const data = dashboard("OPEN");
    data.market.regime.kospiIndex = {
      ...data.market.regime.kospiIndex!,
      change: 0,
      changeRateBps: 0,
      direction: "FLAT",
    };

    expect(marketRegimeTitle(data)).toBe("코스피 보합 이상 · 신규매수 가능");
    expect(marketRegimeDescription(data)).toContain("0.00%");
    expect(marketRegimeDescription(data)).toContain("보합 이상");
    expect(brokerOrderReadiness(data, broker())).toBe("현재 주문 가능 · 조건 감시 중");
  });

  it("KRX 거래 시간에는 증권사 확인 여부를 그대로 표시한다", () => {
    const data = dashboard("OPEN");
    const kiwoom = broker();
    kiwoom.connection.marketStatusConfirmed = false;

    expect(brokerMarketStatusLabel(data, kiwoom)).toBe("KRX 거래 시간 · 확인 중");
  });

  it("NXT 주문 경로는 KRX 종료와 별개로 NXT 거래 시간을 사용한다", () => {
    const data = dashboard("CLOSED");
    const nxt = data.market.sessions.find((session) => session.id === "NXT_EQUITY");
    if (!nxt) throw new Error("NXT fixture missing");
    nxt.state = "AFTER_HOURS";
    nxt.orderable = true;
    const kiwoom = broker();
    kiwoom.orderRoute = "NXT";

    expect(brokerMarketStatusLabel(data, kiwoom)).toBe("NXT 거래 시간 · 확인 완료");
  });
});
