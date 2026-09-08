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
} from "../components/dashboard-client";
import type { BrokerDashboard, DashboardResponse } from "../lib/api-types";

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
