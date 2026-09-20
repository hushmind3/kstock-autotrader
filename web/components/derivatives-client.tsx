"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import {
  AlertCircle,
  CheckCircle2,
  Clock3,
  PauseCircle,
  Play,
  RefreshCw,
  Settings,
  ShieldAlert,
  ShieldCheck,
  Square,
  TrendingDown,
  TrendingUp,
  WalletCards,
} from "lucide-react";
import {
  formatDateTime,
  formatNumber,
  formatWon,
  getJson,
  koreanErrorMessage,
} from "@/lib/client-api";
import type {
  DerivativesCredentialConnectionState,
  DerivativesDashboardResponse,
  MarketVenueSession,
} from "@/lib/api-types";

/* Kept exported because the credential form and its regression tests share the
 * exact same request-shaping rules. */
export interface DerivativesCredentialFormValues {
  reuseCashCredentials: boolean;
  accountId: string;
  appKey: string;
  appSecret: string;
  htsId: string;
}

export function buildDerivativesCredentialPayload(values: DerivativesCredentialFormValues) {
  return {
    reuseCashCredentials: values.reuseCashCredentials,
    accountId: values.accountId.trim(),
    accountProductCode: "03" as const,
    htsId: values.htsId.trim(),
    ...(values.reuseCashCredentials
      ? {}
      : {
          appKey: values.appKey.trim(),
          appSecret: values.appSecret.trim(),
        }),
  };
}

export function derivativesConnectionLabel(
  state: DerivativesCredentialConnectionState,
  authenticated: boolean,
  accountSynchronized: boolean,
): string {
  if (state === "FAILED") {
    return authenticated ? "API 로그인 완료 · 선물계좌 연결 필요" : "API 로그인 확인 필요";
  }
  if (state === "VERIFYING") return "로그인·선물 계좌 확인 중";
  if (state === "VERIFIED" && authenticated && accountSynchronized) return "실제 선물 계좌 조회 확인 완료";
  if (state === "VERIFIED" && authenticated) return "로그인 완료 · 계좌 확인 대기";
  return "저장됨 · 연결 확인 전";
}

type DerivativesControlAction = "start" | "halt" | "pause-new" | "resume-new";

const sessionStateLabel: Record<string, string> = {
  CLOSED: "장 종료",
  PREOPEN: "장 시작 대기",
  OPEN: "거래 시간",
  AFTER_HOURS: "시간외 거래",
  BREAK: "휴장 구간",
  HOLIDAY: "휴장일",
};

const sessionPhaseLabel: Record<string, string> = {
  CLOSED: "주문시간 아님",
  OPENING_AUCTION: "장 시작 전 주문 접수",
  DAY_SESSION: "주간 정규거래",
  NIGHT_SESSION: "야간 정규거래",
};

const signalLabel: Record<string, string> = {
  LONG: "상승 판단 · 롱",
  SHORT: "하락 판단 · 숏",
  FLAT: "방향 없음 · 쉬는 중",
  WAITING_FOR_HISTORY: "가격 기록을 모으는 중",
  DISABLED: "사용 안 함",
};

const hedgeStatusLabel: Record<string, string> = {
  DISABLED: "사용 안 함",
  WAITING: "계좌·시세 확인 중",
  READY: "보호 수량 계산 완료",
  BALANCED: "현재 보호 수량 적정",
  BELOW_REBALANCE_THRESHOLD: "조정할 만큼 차이 나지 않음",
  ORDER_REQUIRED: "보호 수량 조정 필요",
  BLOCKED: "안전장치로 중지",
};

export function DerivativesClient() {
  const [data, setData] = useState<DerivativesDashboardResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<DerivativesControlAction | "reconcile" | null>(null);
  const [feedback, setFeedback] = useState<{ kind: "success" | "danger"; text: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const next = await getJson<DerivativesDashboardResponse>("/api/engine/derivatives/dashboard");
      setData(next);
      setFeedback((current) => current?.kind === "danger" ? null : current);
    } catch (cause) {
      setFeedback({
        kind: "danger",
        text: koreanErrorMessage(cause, "선물 자동매매 엔진 상태를 불러오지 못했습니다."),
      });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 3_000);
    return () => window.clearInterval(timer);
  }, [load]);

  async function control(action: DerivativesControlAction): Promise<void> {
    if (action === "start") {
      const environment = data?.settings.environment === "live" ? "실전투자" : "모의투자";
      const accepted = window.confirm(
        `${environment} 선물 자동운용을 시작할까요?\n\n조건과 안전 확인을 모두 통과하면 실제 선물 주문이 전송됩니다.`,
      );
      if (!accepted) return;
    }
    if (action === "halt" && !window.confirm("선물 자동운용을 완전히 정지할까요? 신규 주문은 즉시 막힙니다.")) return;
    setBusy(action);
    setFeedback(null);
    try {
      const next = await getJson<DerivativesDashboardResponse>("/api/engine/derivatives/control", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action }),
      });
      setData(next);
      setFeedback({
        kind: "success",
        text: action === "start"
          ? "선물 자동운용을 시작했습니다. 조건과 안전 확인을 통과할 때만 실제 주문합니다."
          : action === "halt"
            ? "선물 자동운용을 완전히 정지했습니다."
            : action === "pause-new"
              ? "새 선물 진입만 멈췄습니다. 보유 포지션과 청산 조건은 계속 확인합니다."
              : "새 선물 진입을 다시 허용했습니다.",
      });
    } catch (cause) {
      setFeedback({ kind: "danger", text: koreanErrorMessage(cause, "선물 자동운용 상태를 바꾸지 못했습니다.") });
    } finally {
      setBusy(null);
    }
  }

  async function reconcile(): Promise<void> {
    setBusy("reconcile");
    setFeedback(null);
    try {
      const next = await getJson<DerivativesDashboardResponse>("/api/engine/derivatives/reconcile", { method: "POST" });
      setData(next);
      setFeedback({ kind: "success", text: "실제 계좌·잔고·미체결·체결 내역을 다시 확인했습니다." });
    } catch (cause) {
      setFeedback({ kind: "danger", text: koreanErrorMessage(cause, "실제 선물 계좌를 다시 확인하지 못했습니다.") });
    } finally {
      setBusy(null);
    }
  }

  const armed = data?.safety.armed === true;
  const session = useMemo(() => {
    const wanted = data?.market.activeSession === "NIGHT" ? "KRX_DERIVATIVES_NIGHT" : "KRX_DERIVATIVES_DAY";
    return data?.market.sessions.find((item) => item.id === wanted) ?? null;
  }, [data]);

  return <main className="shell">
    <header className="page-header dashboard-header">
      <div>
        <p className="eyebrow">선물·옵션 자동매매</p>
        <h1>선물 자동운용 현황</h1>
        <p className="subtitle">현물 하락 방어와 코스피200 선물 롱·숏 운용을 한 화면에서 확인합니다.</p>
      </div>
      <div className="header-actions">
        <span className={`engine-state ${armed ? "state-running" : "state-halted"}`}><i />{armed ? "실제 주문 켜짐" : "실제 주문 꺼짐"}</span>
        <button className="icon-button" disabled={busy !== null} onClick={() => void load()} aria-label="새로고침"><RefreshCw size={16} /></button>
        <Link className="derivatives-settings-link" href="/settings?tab=derivatives"><Settings size={15} />운용 설정</Link>
      </div>
    </header>

    {feedback ? <section className={`notice ${feedback.kind}`} role="status">
      {feedback.kind === "danger" ? <AlertCircle size={17} /> : <CheckCircle2 size={17} />}
      <div><strong>{feedback.kind === "danger" ? "확인이 필요합니다" : "처리 완료"}</strong><p>{feedback.text}</p></div>
    </section> : null}

    <section className={`notice ${armed ? "danger" : "warning"}`}>
      <ShieldAlert size={18} />
      <div>
        <strong>{armed ? "실전 선물 자동주문이 켜져 있습니다" : "입금하거나 계좌를 연결하는 것만으로는 주문하지 않습니다"}</strong>
        <p>{armed
          ? "설정한 조건과 모든 안전 확인을 통과하면 별도 클릭 없이 실제 주문이 나갑니다."
          : "운용 설정을 저장한 뒤 아래 ‘자동운용 시작’을 직접 눌러야 실제 주문이 가능해집니다."}</p>
      </div>
      <Link href="/settings?tab=derivatives">설정 확인</Link>
    </section>

    <section className="derivatives-control-card">
      <div className="derivatives-control-copy">
        <p className="settings-kicker">실제 주문 스위치</p>
        <h2>{armed ? "선물 자동운용 중" : "선물 자동운용 정지"}</h2>
        <p>자동운용 설정은 매일 다시 누를 필요가 없습니다. 재시작 자동복구를 켜면 서버가 재부팅돼도 저장된 운용 상태를 복구합니다.</p>
      </div>
      <div className="derivatives-control-actions">
        {armed
          ? <button className="danger-button" disabled={busy !== null} onClick={() => void control("halt")}><Square size={15} />자동운용 완전 정지</button>
          : <button className="derivatives-start-button" disabled={busy !== null || loading} onClick={() => void control("start")}><Play size={15} />자동운용 시작</button>}
        {armed ? <button className="secondary-button" disabled={busy !== null} onClick={() => void control(data?.safety.newPositionsPaused ? "resume-new" : "pause-new")}>
          {data?.safety.newPositionsPaused ? <Play size={14} /> : <PauseCircle size={14} />}
          {data?.safety.newPositionsPaused ? "새 진입 다시 허용" : "새 진입만 멈춤"}
        </button> : null}
        <button className="secondary-button" disabled={busy !== null || loading} onClick={() => void reconcile()}><RefreshCw size={14} />실제 계좌 다시 확인</button>
      </div>
    </section>

    <section className="metrics derivatives-metrics">
      <Metric label="선물 계좌 연결" value={connectionLabel(data)} help={data?.connection.message ?? "엔진 확인 중"} />
      <Metric label="지금 거래 가능 여부" value={session ? (session.orderable ? "거래 가능" : sessionStateLabel[session.state] ?? session.state) : "확인 중"} help={session ? `${sessionPhaseLabel[session.phase] ?? "거래시간 확인"} · ${data?.market.activeSession === "NIGHT" ? "야간장" : "주간장"}` : "거래소 시간 확인 중"} tone={session?.orderable ? "positive" : undefined} />
      <Metric label="자동 선택 선물" value={data?.contract?.name || "확인 중"} help={data?.contract ? `${data.contract.symbol} · 현재 ${formatFuturePrice(data.contract.currentPrice)}` : "미니 코스피200 최근 월물 조회 중"} />
      <Metric
        label="오늘 선물 총손익"
        value={formatWon(data?.profitLoss.totalPnlKrw, true)}
        help={`확정 ${formatWon(data?.profitLoss.realizedPnlKrw, true)} · 평가 ${formatWon(data?.profitLoss.unrealizedPnlKrw, true)}`}
        tone={(data?.profitLoss.totalPnlKrw ?? 0) > 0 ? "positive" : (data?.profitLoss.totalPnlKrw ?? 0) < 0 ? "negative" : undefined}
      />
    </section>

    <section className="split-grid">
      <StrategyCard
        icon={<ShieldCheck size={18} />}
        title="코스피200 선물 숏 헤지"
        enabled={data?.settings.hedge.enabled === true}
        status={data ? (hedgeStatusLabel[data.hedge.status] ?? data.hedge.status) : "확인 중"}
        description="키움·한투 현물 보유액이 커지면 미니 코스피200 선물을 숏으로 잡아 폭락 때 손실을 일부 줄입니다. 현물을 팔지 않고 시장 전체 하락 위험만 낮추는 기능입니다."
        rows={[
          ["보호할 현물 금액", formatWon(data?.hedge.sourceEquityExposureKrw)],
          ["목표 헤지 수량", data?.hedge.targetQuantity === null || data?.hedge.targetQuantity === undefined ? "—" : signedContracts(data.hedge.targetQuantity)],
          ["현재 헤지 수량", data?.account ? signedContracts(data.hedge.currentQuantity) : "—"],
        ]}
      />
      <StrategyCard
        icon={data?.directional.signal === "SHORT" ? <TrendingDown size={18} /> : <TrendingUp size={18} />}
        title="추세에 따른 롱·숏"
        enabled={data?.settings.directional.enabled === true}
        status={data ? (signalLabel[data.directional.signal] ?? data.directional.signal) : "확인 중"}
        description="실제 선물 일봉의 빠른 평균과 느린 평균을 비교합니다. 상승 추세면 롱, 하락 추세면 숏, 방향이 약하면 포지션을 정리합니다. LLM이나 임의 점수는 쓰지 않습니다."
        rows={[
          ["모은 일봉", data ? `${formatNumber(data.directional.historyCount)}일` : "—"],
          ["평균선 차이", data?.directional.gapBps === null || data?.directional.gapBps === undefined ? "—" : `${(data.directional.gapBps / 100).toFixed(2)}%`],
          ["목표 추세 수량", data?.directional.targetQuantity === null || data?.directional.targetQuantity === undefined ? "—" : signedContracts(data.directional.targetQuantity)],
        ]}
      />
    </section>

    <section className="split-grid">
      <section className="table-card derivatives-safety-card">
        <div className="section-head"><div><p>주문 전 안전 확인</p><h2>{data?.safety.readyForOrders ? "실제 주문 준비 완료" : "현재 주문 차단 중"}</h2></div>{data?.safety.readyForOrders ? <CheckCircle2 className="positive" size={20} /> : <ShieldAlert className="negative" size={20} />}</div>
        {data?.safety.blockers.length
          ? <ul className="derivatives-blocker-list">{data.safety.blockers.map((blocker) => <li key={blocker}><AlertCircle size={13} /><span>{blocker}</span></li>)}</ul>
          : <p className="derivatives-ready"><CheckCircle2 size={14} />계좌·시세·체결 연결, 거래 시간, 수량 기록을 모두 확인했습니다.</p>}
        {data?.safety.ledgerBlockReason ? <p className="inline-error">{data.safety.ledgerBlockReason}</p> : null}
      </section>
      <section className="table-card">
        <div className="section-head"><div><p>실제 선물 계좌</p><h2>예수금·증거금</h2></div><WalletCards size={19} /></div>
        <dl className="derivatives-account-values">
          <div><dt>계좌</dt><dd>{data?.account ? `${data.account.maskedAccountId}-03` : "—"}</dd></div>
          <div><dt>선물계좌 예수금</dt><dd>{formatWon(data?.account?.depositCash)}</dd></div>
          <div><dt>새 주문 가능 금액</dt><dd>{formatWon(data?.account?.orderableCash)}</dd></div>
          <div><dt>사용 중인 증거금</dt><dd>{formatWon(data?.account?.initialMargin)}</dd></div>
          <div><dt>오늘 확정손익</dt><dd>{formatWon(data?.profitLoss.realizedPnlKrw, true)}</dd></div>
          <div><dt>현재 평가손익</dt><dd>{formatWon(data?.profitLoss.unrealizedPnlKrw, true)}</dd></div>
        </dl>
        <p className="data-footer">마지막 실제 계좌 확인 {formatDateTime(data?.account?.observedAt ?? data?.lastSyncAt)}</p>
      </section>
    </section>

    <PositionsTable data={data} />
    <section className="split-grid derivatives-record-grid">
      <OrdersTable data={data} />
      <ExecutionsTable data={data} />
    </section>
  </main>;
}

function Metric({ label, value, help, tone }: { label: string; value: string; help: string; tone?: string }) {
  return <article className="metric"><span>{label}</span><strong className={tone}>{value}</strong><small>{help}</small></article>;
}

function StrategyCard({ icon, title, enabled, status, description, rows }: {
  icon: ReactNode;
  title: string;
  enabled: boolean;
  status: string;
  description: string;
  rows: Array<[string, string]>;
}) {
  return <article className="broker-card derivatives-strategy-card">
    <div className="card-head"><div><p>{enabled ? "자동 계산 사용 중" : "설정에서 꺼짐"}</p><h2>{title}</h2></div><span className={`status ${enabled ? "on" : "off"}`}>{status}</span></div>
    <p className="derivatives-plain-help">{description}</p>
    <dl>{rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
  </article>;
}

function PositionsTable({ data }: { data: DerivativesDashboardResponse | null }) {
  return <section className="table-card derivatives-record-card">
    <div className="section-head"><div><p>한국투자증권 실제 계좌</p><h2>현재 선물 포지션</h2></div><span>{data?.positions.length ?? 0}건</span></div>
    {!data?.positions.length ? <Empty title="보유 중인 선물 포지션이 없습니다" text="계좌 조회 결과를 그대로 표시합니다." /> : <div className="table-wrap"><table><thead><tr><th>종목</th><th>방향</th><th>수량</th><th>평균 진입가</th><th>현재가</th><th>평가손익</th></tr></thead><tbody>{data.positions.map((row) => <tr key={`${row.symbol}-${row.direction}`}><td><strong>{row.name || row.symbol}</strong><small>{row.symbol}</small></td><td><span className={`side ${row.direction === "LONG" ? "buy" : "sell"}`}>{row.direction === "LONG" ? "롱" : "숏"}</span></td><td>{row.quantity}계약</td><td>{formatFuturePrice(row.averagePrice)}</td><td>{formatFuturePrice(row.currentPrice)}</td><td className={(row.evaluationProfitLoss ?? 0) > 0 ? "positive" : (row.evaluationProfitLoss ?? 0) < 0 ? "negative" : ""}>{formatWon(row.evaluationProfitLoss, true)}</td></tr>)}</tbody></table></div>}
  </section>;
}

function OrdersTable({ data }: { data: DerivativesDashboardResponse | null }) {
  const rows = data?.orders ?? [];
  const brokerRows = data?.brokerOpenOrders ?? [];
  return <section className="table-card derivatives-record-card">
    <div className="section-head"><div><p>증권사와 엔진 주문</p><h2>미체결·최근 주문</h2></div><span>{brokerRows.length + rows.length}건</span></div>
    {brokerRows.length ? <>
      <p className="derivatives-table-subtitle">한국투자증권 실제 미체결</p>
      <div className="table-wrap"><table><thead><tr><th>종목</th><th>매수·매도</th><th>주문</th><th>체결</th><th>남음</th><th>상태</th></tr></thead><tbody>{brokerRows.map((row) => <tr key={`${row.brokerOrderId}-${row.symbol}`}><td><strong>{row.symbol}</strong><small>{formatDateTime(row.orderedAt)}</small></td><td><span className={`side ${row.side === "BUY" ? "buy" : "sell"}`}>{row.side === "BUY" ? "매수" : "매도"}</span></td><td>{row.requestedQuantity}계약</td><td>{row.filledQuantity}계약</td><td>{row.remainingQuantity}계약</td><td>{koreanOrderStatus(row.status)}</td></tr>)}</tbody></table></div>
    </> : null}
    {rows.length ? <>
      {brokerRows.length ? <p className="derivatives-table-subtitle">자동매매 엔진 기록</p> : null}
      <div className="table-wrap"><table><thead><tr><th>종목</th><th>용도</th><th>주문</th><th>수량</th><th>체결</th><th>상태</th></tr></thead><tbody>{rows.map((row) => <tr key={row.id}><td><strong>{row.symbol}</strong><small>{formatDateTime(row.orderedAt)}</small></td><td>{row.purpose === "HEDGE" ? "현물 보호" : "추세매매"}</td><td>{orderDescription(row.action, row.direction)}</td><td>{row.quantity}계약</td><td>{row.filledQuantity}계약</td><td>{koreanOrderStatus(row.status)}</td></tr>)}</tbody></table></div>
    </> : null}
    {!brokerRows.length && !rows.length ? <Empty title="조회된 선물 주문이 없습니다" text="연결 확인만으로는 주문 기록이 생기지 않습니다." /> : null}
  </section>;
}

function ExecutionsTable({ data }: { data: DerivativesDashboardResponse | null }) {
  const rows = data?.executions ?? [];
  return <section className="table-card derivatives-record-card">
    <div className="section-head"><div><p>증권사 체결 조회</p><h2>최근 실제 체결</h2></div><span>{rows.length}건</span></div>
    {!rows.length ? <Empty title="조회된 선물 체결이 없습니다" text="한국투자증권 계좌에서 받은 결과를 표시합니다." /> : <div className="table-wrap"><table><thead><tr><th>종목</th><th>매수·매도</th><th>수량</th><th>체결가</th><th>시간</th></tr></thead><tbody>{rows.map((row) => <tr key={row.executionId}><td>{row.symbol}</td><td><span className={`side ${row.side === "BUY" ? "buy" : "sell"}`}>{row.side === "BUY" ? "매수" : "매도"}</span></td><td>{row.quantity}계약</td><td>{formatFuturePrice(row.price)}</td><td>{formatDateTime(row.executedAt)}</td></tr>)}</tbody></table></div>}
  </section>;
}

function Empty({ title, text }: { title: string; text: string }) {
  return <div className="empty"><Clock3 size={18} /><strong>{title}</strong><span>{text}</span></div>;
}

function connectionLabel(data: DerivativesDashboardResponse | null): string {
  if (!data) return "확인 중";
  if (data.connection.authenticated && data.connection.accountSynchronized) return "계좌 조회 완료";
  if (data.connection.authenticated) return "API 로그인 완료";
  if (data.connection.state === "CREDENTIALS_REQUIRED") return "계좌 설정 필요";
  if (data.connection.state === "CONNECTING") return "연결 중";
  return "연결 확인 필요";
}

function formatFuturePrice(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return new Intl.NumberFormat("ko-KR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
}

function signedContracts(value: number): string {
  if (value === 0) return "없음";
  return `${value > 0 ? `롱 ${value}` : `숏 ${Math.abs(value)}`}계약`;
}

function orderDescription(action: "OPEN" | "CLOSE", direction: "LONG" | "SHORT"): string {
  const actionText = action === "OPEN" ? "진입" : "청산";
  return `${direction === "LONG" ? "롱" : "숏"} ${actionText}`;
}

function koreanOrderStatus(status: string): string {
  return ({
    QUEUED: "주문 대기",
    SENDING: "증권사 전송 중",
    ACKED: "접수 완료",
    PARTIALLY_FILLED: "일부 체결",
    FILLED: "전량 체결",
    CANCEL_REQUESTED: "취소 요청",
    CANCELED: "취소 완료",
    REJECTED: "거절됨",
    UNKNOWN: "상태 재확인 필요",
  } as Record<string, string>)[status] ?? status;
}
