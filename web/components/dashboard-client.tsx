"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { AlertCircle, Ban, CirclePause, Play, RefreshCw, ShieldAlert } from "lucide-react";
import { formatDateTime, formatNumber, formatWon, getJson } from "@/lib/client-api";
import { tradeReasonSummary } from "../lib/trade-reasons";
import type {
  BrokerConnectionStage,
  BrokerDashboard,
  BrokerId,
  DashboardResponse,
  MarketSessionId,
  MarketSessionState,
  MarketVenueSession,
} from "@/lib/api-types";

type Filter = "all" | BrokerId;
const brokerLabel: Record<BrokerId, string> = { kiwoom: "키움증권", koreainvestment: "한국투자증권" };
const marketLabel: Record<MarketSessionState, string> = {
  CLOSED: "장 종료",
  PREOPEN: "장 시작 대기",
  OPEN: "거래 시간",
  AFTER_HOURS: "시간외 거래",
  BREAK: "휴장 구간",
  HOLIDAY: "휴장일",
};
const sessionDefinitions: ReadonlyArray<{
  id: MarketSessionId;
  label: string;
  kind: MarketVenueSession["kind"];
}> = [
  { id: "KRX_EQUITY", label: "KRX 현물", kind: "equity" },
  { id: "NXT_EQUITY", label: "NXT 현물", kind: "equity" },
];
const connectionLabel: Record<BrokerConnectionStage, string> = {
  DISABLED: "연결 꺼짐",
  CREDENTIALS_REQUIRED: "API 키 필요",
  CONNECTING: "연결 중",
  AUTHENTICATING: "인증 중",
  ACCOUNT_SYNCING: "계좌 동기화 중",
  WAITING_MARKET_STATUS: "인증·계좌 연결 완료",
  READY: "주문 연결 준비 완료",
  DEGRADED: "실시간 연결 확인 필요",
  ERROR: "연결 실패",
};
const engineLabel: Record<DashboardResponse["engine"]["state"], string> = {
  STARTING: "엔진 시작 중",
  RUNNING: "엔진 정상",
  BUY_PAUSED: "신규매수 정지",
  HALTED: "자동주문 정지",
  DEGRADED: "연결 점검 필요",
  ERROR: "엔진 오류",
};

function engineWatchLabel(state: DashboardResponse["engine"]["state"]): string {
  if (state === "STARTING") return "감시 엔진 시작 중";
  if (state === "ERROR") return "감시 엔진 확인 필요";
  return "감시 엔진 계속 실행 중";
}

function orderedSessions(data: DashboardResponse | null): Array<{
  id: MarketSessionId;
  label: string;
  kind: MarketVenueSession["kind"];
  session: MarketVenueSession | null;
}> {
  const byId = new Map((data?.market.sessions ?? []).map((session) => [session.id, session]));
  return sessionDefinitions.map((definition) => ({
    ...definition,
    session: byId.get(definition.id) ?? null,
  }));
}

function routedEquitySessions(
  data: DashboardResponse,
  broker: BrokerDashboard,
): MarketVenueSession[] {
  const sessions = data.market.sessions ?? [];
  if (sessions.length === 0) return [];
  if (broker.orderRoute === "NXT") {
    return sessions.filter((session) => session.id === "NXT_EQUITY");
  }
  if (broker.orderRoute === "SOR") {
    return sessions.filter(
      (session) => session.id === "KRX_EQUITY" || session.id === "NXT_EQUITY",
    );
  }
  return sessions.filter((session) => session.id === "KRX_EQUITY");
}

function isBrokerMarketOrderable(data: DashboardResponse, broker: BrokerDashboard): boolean {
  const sessions = routedEquitySessions(data, broker);
  if (sessions.length > 0) return sessions.some((session) => session.orderable);
  return data.market.session.state === "OPEN";
}

function brokerRouteLabel(broker: BrokerDashboard): string {
  if (broker.orderRoute === "NXT") return "NXT";
  if (broker.orderRoute === "SOR") return "자동 선택";
  return "KRX";
}

function strategyLabel(strategyId: string): string {
  if (strategyId === "moving-average") return "이동평균선 전략";
  if (strategyId === "breakout-volume") return "고점 돌파·거래량 전략";
  if (strategyId === "rsi-bollinger-rebound") return "RSI·볼린저 반등 전략";
  if (strategyId === "pullback-rebound") return "눌림 후 반등 매매";
  if (strategyId === "intraday-momentum") return "실시간 짧은 매매";
  return strategyId;
}

export function intradayReadinessText(broker: BrokerDashboard): string | null {
  const intraday = broker.intraday;
  if (!intraday) return broker.strategyId === "intraday-momentum" ? "짧은 매매 시세 준비 상태를 확인하고 있습니다." : null;
  if (!intraday.enabled) return null;
  const progress = `관측 ${intraday.observedSymbols}종목 · 신호 검사 준비 ${intraday.readySymbols}종목`;
  return `${progress}. 종목마다 최소 ${intraday.requiredSeconds}초의 실제 시세가 필요합니다.${intraday.readySymbols === 0 ? " 시세가 쌓이면 자동으로 검사합니다." : " 준비 완료는 매수 신호나 주문 체결을 뜻하지 않습니다."}`;
}

function candidateActionLabel(action: string): string {
  const normalized = action.toLowerCase();
  if (normalized === "buy") return "매수";
  if (normalized === "sell") return "매도";
  return "조건 감지";
}

function breadthPercent(value: number | null): string {
  return value === null ? "확인 중" : `${(value / 100).toFixed(1)}%`;
}

function signedValue(value: number, fractionDigits: number): string {
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toLocaleString("ko-KR", {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  })}`;
}

function kospiIndexDescription(data: DashboardResponse): string | null {
  const index = data.market.regime.kospiIndex;
  if (!index) return null;
  const source = index.source === "kiwoom" ? "키움증권" : "한국투자증권";
  return `${source} 공식 코스피 ${index.currentValue.toLocaleString("ko-KR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} · 전일 대비 ${signedValue(index.change, 2)} (${signedValue(index.changeRateBps / 100, 2)}%)`;
}

export function marketRegimeTitle(data: DashboardResponse): string {
  const regime = data.market.regime;
  if (!regime.enabled) return "장세 자동 판단을 사용하지 않습니다";
  if (regime.reasonCode === "KOSPI_INDEX_NOT_READY") return "코스피 자료 확인 중 · 신규매수 대기";
  if (regime.reasonCode === "KOSPI_INDEX_DOWN") return "코스피 파란색 · 신규매수 자동 대기";
  if (regime.status === "NORMAL") {
    const index = regime.kospiIndex;
    return index && index.direction !== "DOWN" && index.changeRateBps >= 0
      ? "코스피 보합 이상 · 신규매수 가능"
      : "장세 조건 통과 · 신규매수 가능";
  }
  if (regime.status === "WEAK") return "약세장 감지: 신규매수 자동 대기";
  return "장세 자료 확인 중: 신규매수 자동 대기";
}

export function marketRegimeDescription(data: DashboardResponse): string {
  const regime = data.market.regime;
  if (!regime.enabled) return "선택한 종목 전략과 계좌 안전한도만 적용합니다.";
  if (regime.reasonCode === "KOSPI_INDEX_NOT_READY") {
    return "증권사에서 코스피 전일 대비 값을 받는 중이거나 최근 값인지 확인하고 있습니다. 확인 전에는 새로 사지 않습니다.";
  }
  if (regime.reasonCode === "KOSPI_INDEX_DOWN") {
    const index = kospiIndexDescription(data);
    return `${index ?? "증권사 공식 코스피"}로 파란색입니다. 새 종목 매수만 쉽니다.`;
  }
  if (regime.reasonCode === "DAILY_BREADTH_NOT_READY") {
    return `긴 시장 흐름을 판단할 종목이 ${formatNumber(regime.dailySampleCount)}개라 자료가 더 필요합니다.`;
  }
  if (regime.reasonCode === "DAILY_BREADTH_WEAK") {
    return `장기 평균가격 위에 있는 종목이 ${breadthPercent(regime.dailyAboveLongMaBps)}뿐이라 새 매수를 쉽니다.`;
  }
  if (regime.reasonCode === "INTRADAY_BREADTH_NOT_READY") {
    return `오늘 장세를 판단할 실시간 종목이 ${formatNumber(regime.intradaySampleCount)}개라 조금 더 확인합니다.`;
  }
  if (regime.reasonCode === "INTRADAY_BREADTH_WEAK") {
    return `오늘 시가보다 오른 종목이 ${breadthPercent(regime.intradayAdvancingBps)}뿐이라 새 매수를 쉽니다.`;
  }
  const index = kospiIndexDescription(data);
  const indexSnapshot = regime.kospiIndex;
  const indexStatus = index && indexSnapshot && indexSnapshot.direction !== "DOWN" && indexSnapshot.changeRateBps >= 0
    ? `${index}로 보합 이상입니다. `
    : index
      ? `${index}입니다. 코스피 하락만으로 새 매수를 막는 상태는 아닙니다. `
      : "";
  return `${indexStatus}장기 평균가격 위 종목 ${breadthPercent(regime.dailyAboveLongMaBps)} · 오늘 상승 종목 ${breadthPercent(regime.intradayAdvancingBps)}입니다.`;
}

function conditionScanHint(data: DashboardResponse | null): string {
  if (!data) return "조건 검사 상태 확인 중";
  const intraday = data.brokers.filter((broker) => broker.intraday?.enabled);
  if (intraday.length > 0) {
    const ready = intraday.reduce((sum, broker) => sum + (broker.intraday?.readySymbols ?? 0), 0);
    return ready > 0 ? `초단타 ${ready}종목 실시간 검사 중 · 조건이 맞으면 후보 표시`
      : "초단타 실제 시세 수집 대기 · 저장된 종가만으로 매수 판단하지 않습니다";
  }
  if (data.market.scanMode === "LAST_SAVED") {
    return `자동매매와 별개로 검사 완료 · 마지막 가격 ${formatDateTime(data.market.lastScanQuoteAt)} 기준`;
  }
  if (data.market.scanMode === "LIVE") {
    return `실시간 조건 검사 ${data.market.scanProgressPercent}% 진행 · 자동매매 정지 중에도 계속 검사`;
  }
  if (data.market.dailyBarBackfill.completed < data.market.dailyBarBackfill.total) {
    return `과거 가격 준비 ${formatNumber(data.market.dailyBarBackfill.completed)}/${formatNumber(data.market.dailyBarBackfill.total)}`;
  }
  return "저장된 가격으로 조건 검사 준비 중";
}

function candidateEmptyCopy(data: DashboardResponse | null): { title: string; detail: string } {
  if (data?.brokers.some((broker) => broker.intraday?.enabled && broker.intraday.readySymbols === 0)) {
    return { title: "초단타 실시간 시세를 기다리고 있습니다",
      detail: "거래 시간이 되면 실제 시세를 모아 자동 검사합니다. 시세 준비 전에는 ‘조건 불충족’으로 처리하지 않습니다." };
  }
  if (!data || data.market.scanMode === "WAITING_FOR_DATA") {
    return {
      title: "조건 검사를 준비하고 있습니다",
      detail: "과거 가격 준비가 끝나면 자동매매 시작 여부와 상관없이 결과가 표시됩니다.",
    };
  }
  return {
    title: "검사 결과 조건을 통과한 종목이 없습니다",
    detail:
      data.market.scanMode === "LAST_SAVED"
        ? "마지막 저장 가격까지 검사한 결과입니다. 다음 장이 열리면 실시간 가격으로 자동 갱신됩니다."
        : "전략 조건을 만족하는 매수 또는 매도 후보가 생기면 바로 표시됩니다.",
  };
}

export function isBrokerAutomationArmed(data: DashboardResponse, broker: BrokerDashboard): boolean {
  return (
    !data.engine.emergencyHalt &&
    data.engine.globalAutoTradingEnabled &&
    broker.enabled &&
    broker.autoTradingEnabled
  );
}

export function isBrokerNewBuyPaused(data: DashboardResponse, broker: BrokerDashboard): boolean {
  return data.engine.newBuysPaused || broker.newBuysPaused;
}

export function brokerAutomationLabel(data: DashboardResponse, broker: BrokerDashboard): string {
  if (!isBrokerAutomationArmed(data, broker)) return "자동매매 완전 정지";
  return isBrokerNewBuyPaused(data, broker)
    ? "자동매매 중 · 신규매수 일시정지"
    : "계속 자동매매 중";
}

export function brokerAutomationButtonLabel(
  enabled: boolean,
  automationArmed: boolean,
  newBuysPaused = false,
): string {
  if (!enabled) return "설정에서 연결 사용 켜기";
  if (!automationArmed) return "이 계좌 계속 자동매매 시작";
  return newBuysPaused ? "신규매수도 다시 시작" : "이 계좌 자동매매 완전 정지";
}

export function brokerMarketStatusLabel(
  data: DashboardResponse,
  broker: BrokerDashboard,
): string {
  if (isBrokerMarketOrderable(data, broker)) {
    return broker.connection.marketStatusConfirmed
      ? `${brokerRouteLabel(broker)} 거래 시간 · 확인 완료`
      : `${brokerRouteLabel(broker)} 거래 시간 · 확인 중`;
  }
  return "시장 대기 · 가격 감시는 계속";
}

export function brokerOrderReadiness(data: DashboardResponse, broker: BrokerDashboard): string {
  if (!broker.enabled) return "연결 사용 안 함";
  if (data.engine.emergencyHalt || !data.engine.globalAutoTradingEnabled) return "전체 자동주문 정지";
  if (!broker.autoTradingEnabled) return "이 계좌 자동매매 꺼짐";
  if (data.engine.newBuysPaused) return "전체 신규매수 정지";
  if (broker.newBuysPaused) return "이 계좌 신규매수 정지";
  if (
    !broker.connection.brokerAuthenticated ||
    !broker.connection.accountSynchronized ||
    (!broker.connection.accountWebSocketConnected && broker.connection.stage !== "WAITING_MARKET_STATUS")
  ) {
    return "증권사·계좌 연결 준비 중";
  }
  if (!isBrokerMarketOrderable(data, broker)) return "시장 대기 · 조건 감시는 계속";
  if (!broker.connection.readyForOrders) return "거래 시간 · 주문 연결 확인 중";
  if (!data.market.regime.buyAllowed) {
    if (data.market.regime.reasonCode === "KOSPI_INDEX_DOWN") {
      return "자동매도 감시 중 · 코스피 파란색이라 신규매수 대기";
    }
    if (data.market.regime.reasonCode === "KOSPI_INDEX_NOT_READY") {
      return "자동매도 감시 중 · 코스피 자료 확인 중";
    }
    return data.market.regime.status === "WEAK"
      ? "자동매도 감시 중 · 신규매수 약세장 대기"
      : "자동매도 감시 중 · 신규매수 자료 확인 중";
  }
  return "현재 주문 가능 · 조건 감시 중";
}

export function DashboardClient() {
  const [data, setData] = useState<DashboardResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await getJson<DashboardResponse>("/api/engine/dashboard"));
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 3_000);
    return () => window.clearInterval(timer);
  }, [load]);

  const filtered = useMemo(() => {
    const includes = (brokerId: BrokerId) => filter === "all" || brokerId === filter;
    return {
      brokers: data?.brokers.filter((row) => includes(row.brokerId)) ?? [],
      candidates: data?.candidates.filter((row) => includes(row.brokerId)) ?? [],
      positions: data?.positions.filter((row) => includes(row.brokerId)) ?? [],
      orders: data?.orders.filter((row) => includes(row.brokerId)) ?? [],
      executions: data?.executions.filter((row) => includes(row.brokerId)) ?? [],
    };
  }, [data, filter]);

  async function control(
    action: string,
    brokerId?: BrokerId,
    environment?: BrokerDashboard["environment"],
  ): Promise<void> {
    const destructive = action === "halt-all";
    if (destructive && !window.confirm("모든 계좌의 자동매수와 자동매도를 즉시 정지합니다. 계속할까요?")) return;
    if (
      action === "start-broker" &&
      environment === "live" &&
      !window.confirm(
        "실전투자 계좌의 자동운용 설정을 켭니다. 오늘만 시작하는 버튼이 아니며, 재시작 후 자동복구가 켜져 있으면 다음 실행에도 이 설정이 유지됩니다. 해당 시장의 거래 시간에 조건과 안전한도를 통과하면 실제 주문이 전송될 수 있습니다. 정말 켤까요?",
      )
    ) return;
    setBusy(true);
    try {
      await getJson<{ ok: true }>("/api/engine/control", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, brokerId }),
      });
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  const engineState = data?.engine.state ?? "STARTING";
  const emptyCandidateCopy = candidateEmptyCopy(data);
  const sessions = orderedSessions(data);
  const selectedMetrics = data === null || filter === "all"
    ? {
        pnl: data?.pnl ?? { realized: 0, unrealized: 0, total: 0 },
        today: data?.today ?? { orders: 0, buys: 0, sells: 0 },
      }
    : data.brokerMetrics?.[filter] ?? {
        pnl: { realized: 0, unrealized: 0, total: 0 },
        today: { orders: 0, buys: 0, sells: 0 },
      };
  const nextSessionTransition = sessions
    .map(({ session }) => session?.nextTransitionAt)
    .filter((value): value is string => typeof value === "string")
    .filter((value) => Number.isFinite(new Date(value).getTime()))
    .sort()[0] ?? data?.market.session.nextTransitionAt;
  return (
    <main className="shell">
      <header className="page-header dashboard-header">
        <div><p className="eyebrow">실시간 운용 현황</p><h1>자동매매 운용 현황</h1><p className="subtitle">양쪽 계좌의 종목 감시·주문·손익을 한곳에서 확인합니다.</p></div>
        <div className="header-actions">
          <span className={`engine-state state-${engineState.toLowerCase()}`} title={engineLabel[engineState]}><i />{engineWatchLabel(engineState)}</span>
          <button className="icon-button" onClick={() => void load()} aria-label="새로고침"><RefreshCw size={16} /></button>
          <button className="danger-button" disabled={busy} onClick={() => void control("halt-all")}><Ban size={16} />전체 즉시 정지</button>
        </div>
        <section className="market-session-strip" aria-label="현물시장별 거래 시간 상태">
          <div className="market-session-heading"><strong>현물시장 운영 시간</strong><span>시장이 닫혀 있어도 가격 준비와 조건 검사는 계속됩니다.</span></div>
          <div className="market-session-chips">
            {sessions.map(({ id, label, session }) => (
              <div
                className={`market-session-chip ${session?.orderable ? "is-orderable" : session ? "is-waiting" : "is-unknown"}`}
                key={id}
                title={`${label} 시장 시간표`}
              >
                <strong>{label}</strong>
                <span><i />{session ? (session.orderable ? "거래 시간" : marketLabel[session.state]) : "확인 중"}</span>
              </div>
            ))}
          </div>
          <p>‘거래 시간’은 현물시장 시간표 기준입니다. 계좌 연결과 실제 주문 가능 여부는 아래 증권사 계좌에서 따로 확인하세요.</p>
        </section>
      </header>

      {error ? <section className="notice danger"><AlertCircle size={17} /><div><strong>엔진에 연결할 수 없습니다</strong><p>잠시 후 자동으로 다시 연결합니다. 계속 보이면 프로그램을 다시 실행해 주세요.</p></div></section> : null}
      {data?.engine.emergencyHalt ? (
        <section className="notice warning"><ShieldAlert size={18} /><div><strong>안전 정지 상태</strong><p>계좌에 돈이 있어도 주문되지 않습니다. 연결·잔고·설정을 확인한 뒤 설정 화면에서 직접 해제하세요.</p></div><Link href="/settings">설정 확인</Link></section>
      ) : null}
      {data ? (
        <section className="notice"><ShieldAlert size={18} /><div><strong>자동운용 설정은 매일 다시 누를 필요가 없습니다</strong><p>한 번 켜고 ‘재시작 후 자동복구’를 사용하면 시장이 닫힌 동안에도 감시를 계속하고 다음 거래 시간에 자동으로 주문 준비를 확인합니다. 입금만으로 설정이 임의로 켜지지는 않습니다.</p></div><Link href="/settings?tab=common">자동운용 설정</Link></section>
      ) : null}
      {data ? (
        <section className={`notice ${data.market.regime.enabled && !data.market.regime.buyAllowed ? "warning" : ""}`}>
          <ShieldAlert size={18} />
          <div><strong>{marketRegimeTitle(data)}</strong><p>{marketRegimeDescription(data)} 기존 보유종목의 매도·익절 감시는 장세와 관계없이 계속합니다.</p></div>
          <Link href="/settings?tab=common">장세 기준 설정</Link>
        </section>
      ) : null}

      <div className="filter-tabs" role="group" aria-label="증권사별 화면 필터">
        {(["all", "kiwoom", "koreainvestment"] as const).map((value) => <button type="button" aria-pressed={filter === value} className={filter === value ? "selected" : ""} onClick={() => setFilter(value)} key={value}>{value === "all" ? "통합" : brokerLabel[value]}</button>)}
      </div>

      <section className="metrics" aria-label="오늘 운용 현황">
        <Metric label="코스피 전체 감시" value={formatNumber(data?.market.universeCount)} hint={`신규매수 가능 ${formatNumber(data?.market.buyEligibleCount)} · 위험·거래제한 제외 ${formatNumber(data?.market.restrictedInstrumentCount)} · 과거 가격 준비 ${formatNumber(data?.market.dailyBarBackfill.completed)}/${formatNumber(data?.market.dailyBarBackfill.total)}`} />
        <Metric label="현재 조건에 맞는 종목" value={formatNumber(filtered.candidates.length)} hint={conditionScanHint(data)} />
        <Metric label="오늘 주문" value={formatNumber(selectedMetrics.today.orders)} hint={`매수 ${formatNumber(selectedMetrics.today.buys)} · 매도 ${formatNumber(selectedMetrics.today.sells)}`} />
        <Metric label="오늘 총손익" value={formatWon(selectedMetrics.pnl.total, true)} hint={`확정 ${formatWon(selectedMetrics.pnl.realized, true)} · 평가 ${formatWon(selectedMetrics.pnl.unrealized, true)}`} tone={selectedMetrics.pnl.total > 0 ? "positive" : selectedMetrics.pnl.total < 0 ? "negative" : undefined} />
      </section>

      <section className="broker-grid">
        {filtered.brokers.length === 0 ? <EmptyCard title="연결된 증권사가 없습니다" detail="설정 화면에서 증권사와 계좌 환경을 구성하세요." /> : filtered.brokers.map((broker) => {
          const automationArmed = data ? isBrokerAutomationArmed(data, broker) : false;
          const newBuysPaused = data ? isBrokerNewBuyPaused(data, broker) : true;
          return <article className="broker-card" key={broker.brokerId}>
            <div className="card-head"><div><p>증권사 계좌</p><h2>{broker.name}</h2></div><span className={`status ${!automationArmed ? "off" : newBuysPaused ? "paused" : "on"}`}>{data ? brokerAutomationLabel(data, broker) : "설정 확인 중"}</span></div>
            <div className={`mode-strip ${broker.environment}`}>{broker.environment === "live" ? "실전투자" : "모의투자"}<span>{broker.maskedAccountId ?? "계좌 미설정"}</span></div>
            {intradayReadinessText(broker) ? <p className="inline-status">{intradayReadinessText(broker)}</p> : null}
            <dl><div><dt>연결 상태</dt><dd>{connectionLabel[broker.connection.stage]}</dd></div><div><dt>증권사 로그인</dt><dd>{broker.connection.brokerAuthenticated ? "완료" : "대기"}</dd></div><div><dt>계좌잔고 불러오기</dt><dd>{broker.connection.accountSynchronized ? "완료" : "대기"}</dd></div><div><dt>현재 시장 시간</dt><dd>{data ? brokerMarketStatusLabel(data, broker) : "상태 확인 중"}</dd></div><div><dt>실제 주문 상태</dt><dd>{data ? brokerOrderReadiness(data, broker) : "엔진 상태 확인 중"}</dd></div><div><dt>사용 전략</dt><dd>{strategyLabel(broker.strategyId)}</dd></div><div><dt>실시간 가격 감시</dt><dd>{formatNumber(broker.liveSubscriptions)}종목</dd></div></dl>
            <div className="broker-actions">
              <button className="secondary-button" disabled={busy || !broker.enabled} onClick={() => void control(!automationArmed || newBuysPaused ? "start-broker" : "pause-broker", broker.brokerId, broker.environment)}>{!automationArmed || newBuysPaused ? <Play size={15} /> : <CirclePause size={15} />}{brokerAutomationButtonLabel(broker.enabled, automationArmed, newBuysPaused)}</button>
              {automationArmed && newBuysPaused ? <button className="danger-button" disabled={busy} onClick={() => void control("pause-broker", broker.brokerId, broker.environment)}><CirclePause size={15} />매수·매도 모두 정지</button> : null}
            </div>
            {data && !broker.connection.readyForOrders && !broker.connection.lastError ? <p className="inline-status">{isBrokerMarketOrderable(data, broker) ? `거래 시간이지만 아직 실제 주문을 보낼 수 없습니다. 현재 단계: ${connectionLabel[broker.connection.stage]}` : "현재 주문 가능한 시장 시간이 아닙니다. 감시 엔진은 멈추지 않고 다음 거래 시간을 자동 확인합니다."}</p> : null}
            {broker.lastError ? <p className="inline-error">증권사 연결에 문제가 있습니다. 시스템 기록에서 원인을 확인하세요.</p> : null}
          </article>
        })}
      </section>

      <section className="split-grid">
        <DataCard title="현재 매수·매도 후보" kicker="조건 검사 결과" href="/orders">
          {filtered.candidates.length === 0 ? <Empty title={emptyCandidateCopy.title} detail={emptyCandidateCopy.detail} /> : <div className="compact-list">{filtered.candidates.slice(0, 8).map((row) => <div key={row.id}><span className={`side ${row.action.toLowerCase()}`}>{candidateActionLabel(row.action)}</span><strong>{row.name || row.symbol}<small>{brokerLabel[row.brokerId]} · {row.symbol} · {row.source === "LIVE" ? "실시간 가격" : "마지막 저장 가격"}</small>{tradeReasonSummary(row.reasonCodes) ? <small>{tradeReasonSummary(row.reasonCodes)}</small> : null}</strong><b>{formatWon(row.price)}</b></div>)}</div>}
        </DataCard>
        <DataCard title="최근 체결" kicker="실제 체결 내역" href="/orders">
          {filtered.executions.length === 0 ? <Empty title="오늘 체결 내역이 없습니다" /> : <div className="compact-list">{filtered.executions.slice(0, 8).map((row) => <div key={row.id}><span className={`side ${row.side}`}>{row.side === "buy" ? "매수" : "매도"}</span><strong>{row.name || row.symbol}<small>{formatDateTime(row.executedAt)} · {row.quantity}주</small></strong><b>{formatWon(row.price)}</b></div>)}</div>}
        </DataCard>
      </section>

      <DataCard title="현재 보유종목" kicker="현물 계좌 보유 현황" href="/positions" wide>
        {filtered.positions.length === 0 ? <Empty title="동기화된 보유종목이 없습니다" detail="증권사 연결 후 실제 현물 계좌 잔고만 표시됩니다." /> : <div className="table-wrap"><table><thead><tr><th>증권사</th><th>종목</th><th>수량</th><th>매수가</th><th>현재가</th><th>수익률</th><th>평가손익</th></tr></thead><tbody>{filtered.positions.map((row) => <tr key={`${row.brokerId}-${row.symbol}`}><td>{brokerLabel[row.brokerId]}</td><td><strong>{row.name || row.symbol}</strong><small>{row.symbol}</small></td><td>{formatNumber(row.quantity)}</td><td>{formatWon(row.averagePrice)}</td><td>{formatWon(row.currentPrice)}</td><td className={row.unrealizedPnlBps > 0 ? "positive" : row.unrealizedPnlBps < 0 ? "negative" : ""}>{(row.unrealizedPnlBps / 100).toFixed(2)}%</td><td className={row.unrealizedPnl > 0 ? "positive" : row.unrealizedPnl < 0 ? "negative" : ""}>{formatWon(row.unrealizedPnl, true)}</td></tr>)}</tbody></table></div>}
      </DataCard>
      <footer className="data-footer">감시 엔진은 시장 종료 중에도 실행 · 다음 현물시장 상태 변경 {formatDateTime(nextSessionTransition)} · 최근 코스피 종목 목록 갱신 {formatDateTime(data?.market.lastUniverseSyncAt)} · 화면은 3초마다 실제 엔진 상태를 갱신합니다.</footer>
    </main>
  );
}

function Metric({ label, value, hint, tone }: { label: string; value: string; hint: string; tone?: string }) { return <article className="metric"><span>{label}</span><strong className={tone}>{value}</strong><small>{hint}</small></article>; }
function Empty({ title, detail }: { title: string; detail?: string }) { return <div className="empty"><strong>{title}</strong>{detail ? <span>{detail}</span> : null}</div>; }
function EmptyCard({ title, detail }: { title: string; detail: string }) { return <article className="broker-card empty-broker"><Empty title={title} detail={detail} /><Link href="/settings" className="text-link">설정 열기</Link></article>; }
function DataCard({ title, kicker, href, wide, children }: { title: string; kicker: string; href: string; wide?: boolean; children: React.ReactNode }) { return <section className={`table-card ${wide ? "wide" : ""}`}><div className="section-head"><div><p>{kicker}</p><h2>{title}</h2></div><Link href={href}>전체 보기</Link></div>{children}</section>; }
