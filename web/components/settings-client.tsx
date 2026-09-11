"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { AlertTriangle, Check, Clock3, KeyRound, Link2, Save, ShieldCheck, Trash2 } from "lucide-react";
import { getJson, koreanErrorMessage } from "@/lib/client-api";
import { autoTradingPresetStrategyId, withAutoTradingPreset } from "../lib/auto-trading-preset";
import type {
  BrokerConnectionReadiness,
  BrokerId,
  BrokerSettings,
  DashboardResponse,
  SaveCredentialsResponse,
  SettingsResponse,
} from "@/lib/api-types";

const brokerNames: Record<BrokerId, string> = { kiwoom: "키움증권", koreainvestment: "한국투자증권" };
type SettingsTab = BrokerId | "common";

const settingsTabs: Array<{ id: SettingsTab; label: string }> = [
  { id: "kiwoom", label: "키움 현물" },
  { id: "koreainvestment", label: "한투 현물" },
  { id: "common", label: "공통 안전" },
];

export function settingsTabFromSearch(search: string): SettingsTab {
  const requested = new URLSearchParams(search).get("tab");
  return requested === "common" || requested === "koreainvestment" || requested === "kiwoom"
    ? requested
    : "kiwoom";
}

interface BrokerMarketView {
  orderable: boolean;
  label: string;
}

function brokerMarketView(
  dashboard: DashboardResponse | null,
  route: BrokerSettings["orderRoute"],
): BrokerMarketView | null {
  if (!dashboard) return null;
  const venueIds = route === "NXT"
    ? ["NXT_EQUITY"]
    : route === "SOR"
      ? ["KRX_EQUITY", "NXT_EQUITY"]
      : ["KRX_EQUITY"];
  const sessions = dashboard.market.sessions?.filter((session) => venueIds.includes(session.id)) ?? [];
  if (sessions.length === 0) {
    const orderable = dashboard.market.session.state === "OPEN";
    return { orderable, label: orderable ? "한국거래소 주문 시간" : "시장 거래 대기" };
  }
  const orderableSessions = sessions.filter((session) => session.orderable);
  if (orderableSessions.length > 0) {
    return {
      orderable: true,
      label: route === "SOR"
        ? `${orderableSessions.map((session) => session.id === "NXT_EQUITY" ? "NXT" : "KRX").join("·")} 주문 시간`
        : `${route} 주문 시간`,
    };
  }
  const states = new Set(sessions.map((session) => session.state));
  const stateLabel = states.has("HOLIDAY")
    ? "휴장일"
    : states.has("PREOPEN")
      ? "장 시작 전"
      : states.has("BREAK")
        ? "잠시 쉬는 시간"
        : "거래 종료";
  return { orderable: false, label: `${route === "SOR" ? "KRX·NXT" : route} ${stateLabel}` };
}

export function SettingsClient() {
  const [payload, setPayload] = useState<SettingsResponse | null>(null);
  const [dashboard, setDashboard] = useState<DashboardResponse | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [presetNotice, setPresetNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [activeTab, setActiveTab] = useState<SettingsTab>("kiwoom");

  const load = useCallback(async () => {
    try {
      const [settings, currentDashboard] = await Promise.all([
        getJson<SettingsResponse>("/api/engine/settings"),
        getJson<DashboardResponse>("/api/engine/dashboard").catch(() => null),
      ]);
      setPayload(settings);
      setPresetNotice(null);
      setDashboard(currentDashboard);
      setError(null);
    } catch (cause) {
      setError(koreanErrorMessage(cause, "자동매매 엔진에서 설정을 불러오지 못했습니다."));
    }
  }, []);
  const refreshDashboard = useCallback(async () => {
    const current = await getJson<DashboardResponse>("/api/engine/dashboard").catch(() => null);
    if (current) setDashboard(current);
  }, []);
  useEffect(() => {
    setActiveTab(settingsTabFromSearch(window.location.search));
  }, []);
  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void refreshDashboard(), 3_000);
    return () => window.clearInterval(timer);
  }, [load, refreshDashboard]);

  function updateBroker(id: BrokerId, updater: (current: BrokerSettings) => BrokerSettings) {
    setPayload((current) => current ? { ...current, settings: { ...current.settings, brokers: { ...current.settings.brokers, [id]: updater(current.settings.brokers[id]) } } } : current);
  }

  async function save(): Promise<void> {
    if (!payload) return;
    setSaving(true);
    setMessage(null);
    try {
      const result = await getJson<SettingsResponse>("/api/engine/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload.settings),
      });
      setPayload(result);
      setPresetNotice(null);
      setMessage("설정을 저장했습니다. 연결 변경은 엔진이 안전하게 재동기화한 뒤 반영합니다.");
      setError(null);
    } catch (cause) {
      setError(koreanErrorMessage(cause, "설정을 저장하지 못했습니다. 입력값과 엔진 연결을 확인해 주세요."));
    } finally {
      setSaving(false);
    }
  }

  async function control(action: "resume-global" | "halt-all" | "resume-new-buys" | "pause-new-buys"): Promise<void> {
    if (
      action === "resume-global" &&
      !window.confirm("전체 안전정지를 해제하고 신규매수도 다시 허용할까요? 자동운용을 켠 계좌는 거래 시간이 되면 조건에 따라 계속 사고팔 수 있습니다.")
    ) return;
    if (
      action === "resume-new-buys" &&
      !window.confirm("신규매수를 허용하면 장중에 모든 안전 조건과 전략 조건을 통과한 종목에 실제 매수 주문이 전송될 수 있습니다. 계속할까요?")
    ) return;
    setMessage(null);
    try {
      await getJson("/api/engine/control", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action }),
      });
      await load();
      setMessage(action === "halt-all"
        ? "모든 자동주문을 즉시 정지했습니다."
        : action === "resume-global"
          ? "전체 안전정지를 해제하고 신규매수를 허용했습니다. 장이 닫혀도 설정은 유지되며 다음 거래 시간에 자동으로 이어집니다."
          : action === "pause-new-buys"
            ? "새 매수 주문만 정지했습니다. 보유종목의 자동매도는 계속될 수 있습니다."
            : "새 매수 주문을 허용했습니다. 실제 주문 전 나머지 안전 조건도 모두 확인합니다.");
    } catch (cause) {
      setError(koreanErrorMessage(cause, "자동주문 상태를 바꾸지 못했습니다. 연결 상태를 확인해 주세요."));
    }
  }

  return (
    <main className="shell">
      <header className="page-header"><div><p className="eyebrow">자동매매 설정</p><h1>자동매매 설정</h1><p className="subtitle">API 연결, 주문 허용 여부, 투자금과 매매 조건을 증권사별로 설정합니다.</p></div><button className="save-button" disabled={!payload || saving} onClick={() => void save()}><Save size={16} />설정 저장</button></header>
      {error ? <div className="notice danger"><AlertTriangle size={17} /><div><strong>설정을 불러오지 못했습니다</strong><p>{error}</p></div></div> : null}
      {message ? <div className="notice success"><Check size={17} /><div><strong>저장 완료</strong><p>{message}</p></div></div> : null}
      {presetNotice ? <div className="notice warning" role="status"><Save size={17} /><div><strong>기본값을 채웠습니다 · 아직 저장 전</strong><p>{presetNotice}</p></div></div> : null}
      {!payload ? <section className="settings-card"><div className="empty"><strong>자동매매 엔진 연결 대기 중</strong><span>잠시 뒤 자동으로 다시 확인합니다.</span></div></section> : (
        <>
          <nav className="settings-tabs" role="tablist" aria-label="설정 종류">
            {settingsTabs.map((tab, index) => <button
              key={tab.id}
              id={`settings-tab-${tab.id}`}
              className={activeTab === tab.id ? "selected" : ""}
              type="button"
              role="tab"
              aria-selected={activeTab === tab.id}
              aria-controls={`settings-panel-${tab.id}`}
              tabIndex={activeTab === tab.id ? 0 : -1}
              onClick={() => setActiveTab(tab.id)}
              onKeyDown={(event) => {
                let nextIndex: number | null = null;
                if (event.key === "ArrowRight") nextIndex = (index + 1) % settingsTabs.length;
                if (event.key === "ArrowLeft") nextIndex = (index - 1 + settingsTabs.length) % settingsTabs.length;
                if (event.key === "Home") nextIndex = 0;
                if (event.key === "End") nextIndex = settingsTabs.length - 1;
                if (nextIndex === null) return;
                event.preventDefault();
                const nextTab = settingsTabs[nextIndex];
                if (!nextTab) return;
                setActiveTab(nextTab.id);
                window.requestAnimationFrame(() => document.getElementById(`settings-tab-${nextTab.id}`)?.focus());
              }}
            >{tab.label}</button>)}
          </nav>

          {activeTab === "common" ? <section id="settings-panel-common" className="settings-tab-panel" role="tabpanel" aria-labelledby="settings-tab-common" tabIndex={0}>
            <section className="settings-card safety-card">
              <div className="safety-copy"><p className="settings-kicker">주문 안전장치</p><h2>모든 계좌에 적용되는 안전 설정</h2><span>전체 정지는 직접 해제하기 전까지 그대로 유지됩니다.</span></div>
              <div className="safety-controls">
                <div className="safety-control"><span>전체 자동주문</span><strong className={payload.settings.emergencyHalt || !payload.settings.globalAutoTradingEnabled ? "negative" : "positive"}>{payload.settings.emergencyHalt || !payload.settings.globalAutoTradingEnabled ? "모든 자동주문 정지" : "자동주문 켜짐"}</strong>{payload.settings.emergencyHalt || !payload.settings.globalAutoTradingEnabled ? <button onClick={() => void control("resume-global")}><ShieldCheck size={15} />전체 자동운용 다시 켜기</button> : <button className="danger-button" onClick={() => void control("halt-all")}><AlertTriangle size={15} />모든 주문 즉시 정지</button>}</div>
                <div className="safety-control"><span>새 종목 매수</span><strong className={payload.settings.newBuysPaused ? "negative" : "positive"}>{payload.settings.newBuysPaused ? "새 매수 정지" : "새 매수 허용"}</strong>{payload.settings.newBuysPaused ? <button onClick={() => void control("resume-new-buys")}><ShieldCheck size={15} />새 종목 매수 켜기</button> : <button className="danger-button" onClick={() => void control("pause-new-buys")}><AlertTriangle size={15} />새 종목 매수 멈추기</button>}</div>
              </div>
            </section>

            <TradeStartGuide payload={payload} dashboard={dashboard} />

            <section className="settings-card form-section">
              <div className="form-heading"><div><p className="settings-kicker">장세 자동 판단</p><h2>장이 나쁘면 새로 사지 않고 기다립니다</h2><p className="form-description">코스피 종목 전체의 실제 확정 가격과 오늘 시세를 함께 봅니다. 약세로 판단하면 신규매수만 자동으로 쉬고, 이미 가진 종목의 매도·익절 감시는 계속합니다. 장이 회복되면 사람이 누르지 않아도 신규매수를 자동 재개합니다.</p></div><div className="toggle-row"><Toggle label="약세장 자동 매수대기" checked={payload.settings.marketRegime.enabled} onChange={(enabled) => setPayload({ ...payload, settings: { ...payload.settings, marketRegime: { ...payload.settings.marketRegime, enabled } } })} /></div></div>
              <div className="form-grid four">
                <NumberField label="긴 흐름을 볼 기간" value={payload.settings.marketRegime.longPeriod} onChange={(longPeriod) => setPayload({ ...payload, settings: { ...payload.settings, marketRegime: { ...payload.settings.marketRegime, longPeriod } } })} suffix="거래일" min={20} max={250} help="각 종목이 이 기간의 평균가격보다 위인지 확인합니다. 기본값은 60일입니다." />
                <PercentField label="평균선 위 종목 최소 비율" valueBps={payload.settings.marketRegime.minimumAboveLongMaBps} onChange={(minimumAboveLongMaBps) => setPayload({ ...payload, settings: { ...payload.settings, marketRegime: { ...payload.settings.marketRegime, minimumAboveLongMaBps } } })} min={0} max={100} help="이 비율보다 적으면 시장 전체 흐름이 약하다고 보고 새 매수를 쉽니다." />
                <PercentField label="오늘 오르는 종목 최소 비율" valueBps={payload.settings.marketRegime.minimumIntradayAdvancingBps} onChange={(minimumIntradayAdvancingBps) => setPayload({ ...payload, settings: { ...payload.settings, marketRegime: { ...payload.settings.marketRegime, minimumIntradayAdvancingBps } } })} min={0} max={100} help="오늘 시가보다 오른 종목 비율이 이 값보다 낮으면 새 매수를 쉽니다." />
                <NumberField label="판단에 필요한 최소 종목" value={payload.settings.marketRegime.minimumSampleSize} onChange={(minimumSampleSize) => setPayload({ ...payload, settings: { ...payload.settings, marketRegime: { ...payload.settings.marketRegime, minimumSampleSize } } })} suffix="개" min={20} max={2500} help="표본이 모자라면 추측하지 않고 신규매수를 기다립니다." />
              </div>
            </section>

            <section className="settings-card trade-guide">
              <div className="trade-guide-heading">
                <div><p className="settings-kicker">종목 안전 필터</p><h2>위험하거나 거래할 수 없는 종목은 자동 제외</h2></div>
                <span className="positive">항상 적용</span>
              </div>
              <p className="trade-guide-intro">거래정지·상장폐지 정리매매·관리종목·투자주의/경고/위험·저유동성·단기과열·공시위반 종목과 ETF·ETN·ELW·인버스·레버리지·스팩을 확인합니다. 후보를 만들 때와 실제 매수 직전에 두 번 검사합니다.</p>
              <div className="trade-guide-note"><ShieldCheck size={15} /><span>현재 목록 기준 새로 살 수 있는 종목 <strong>{dashboard?.market.buyEligibleCount ?? "확인 중"}</strong>개 · 제외 <strong>{dashboard?.market.restrictedInstrumentCount ?? "확인 중"}</strong>개입니다. 이미 가진 종목은 계속 감시하고 매도 조건을 확인합니다.</span></div>
            </section>

            <section className="settings-card form-section"><div className="form-heading"><div><p className="settings-kicker">검사 속도</p><h2>시세와 매매 조건 확인 간격</h2><p className="form-description">너무 짧게 설정하면 증권사 API 호출 제한에 걸릴 수 있습니다. 기본값 사용을 권장합니다.</p></div></div><div className="form-grid three"><SecondsField label="가격이 너무 오래됐다고 보는 시간" valueMs={payload.settings.staleQuoteMs} onChange={(value) => setPayload({ ...payload, settings: { ...payload.settings, staleQuoteMs: value } })} help="이 시간보다 오래된 가격으로는 주문하지 않습니다." min={1} /><SecondsField label="조건을 다시 검사하는 간격" valueMs={payload.settings.scanIntervalMs} onChange={(value) => setPayload({ ...payload, settings: { ...payload.settings, scanIntervalMs: value } })} help="새 가격을 받은 종목의 매매 조건을 다시 확인하는 최소 간격입니다." min={1} /><SecondsField label="전체 종목 가격 확인 간격" valueMs={payload.settings.quoteSweepIntervalMs} onChange={(value) => setPayload({ ...payload, settings: { ...payload.settings, quoteSweepIntervalMs: value } })} help="실시간으로 받지 못하는 코스피 종목 가격을 순서대로 확인하는 간격입니다." min={10} /></div></section>
          </section> : (() => {
            const id = activeTab;
            const broker = payload.settings.brokers[id];
            const status = payload.credentials[id][broker.environment];
            const currentBroker = dashboard?.brokers.find((row) => row.brokerId === id);
            const connection = currentBroker?.environment === broker.environment
              ? currentBroker.connection
              : payload.connections[id];
            return <section id={`settings-panel-${id}`} className="settings-tab-panel broker-settings-stack" role="tabpanel" aria-labelledby={`settings-tab-${id}`} tabIndex={0}>
              <CredentialCard key={`${id}:${broker.environment}`} id={id} environment={broker.environment} status={status} connection={connection.environment === broker.environment ? connection : null} market={brokerMarketView(dashboard, broker.orderRoute)} reload={load} />
              <BrokerSettingsPanel id={id} settings={broker} strategies={payload.strategies} update={(updater) => updateBroker(id, updater)} onPresetFilled={() => { setMessage(null); setPresetNotice(`${brokerNames[id]}의 매수 전략과 자동매도 조건을 화면에 채웠습니다. 위의 ‘설정 저장’을 눌러야 적용됩니다.`); }} />
            </section>;
          })()}
        </>
      )}
    </main>
  );
}

function TradeStartGuide({ payload, dashboard }: {
  payload: SettingsResponse;
  dashboard: DashboardResponse | null;
}) {
  const anyEquityMarketOpen = dashboard
    ? dashboard.market.sessions?.some((session) => session.kind === "equity" && session.orderable) ?? dashboard.market.session.state === "OPEN"
    : false;

  return <section className="settings-card trade-guide">
    <div className="trade-guide-heading">
      <div><p className="settings-kicker">실제 주문 시작 조건</p><h2>계좌에 돈만 넣어서는 자동주문이 나가지 않습니다</h2></div>
      <span className={anyEquityMarketOpen ? "positive" : "trade-waiting"}>{anyEquityMarketOpen ? "현재 거래 가능한 현물 시장 있음" : "시장별 거래시간 자동 확인 중"}</span>
    </div>
    <p className="trade-guide-intro">처음에는 API 키와 예수금만 넣어도 주문이 나가지 않습니다. 전체 자동주문과 새 종목 매수를 직접 켠 뒤 아래 항목과 매매 조건을 모두 통과해야 실제 주문을 보냅니다. 증권사 탭에서 ‘재시작 뒤 자동 복구’를 켜두면 그다음부터는 서버가 다시 켜질 때 마지막 운용 상태를 안전 확인 후 이어갑니다.</p>
    <div className="trade-guide-grid">
      {(["kiwoom", "koreainvestment"] as const).map((id) => {
        const savedBroker = payload.settings.brokers[id];
        const currentBroker = dashboard?.brokers.find((row) => row.brokerId === id);
        const broker = currentBroker ?? savedBroker;
        const orderRoute = currentBroker?.orderRoute ?? savedBroker.orderRoute;
        const selectedMarket = brokerMarketView(dashboard, orderRoute);
        const marketOpen = selectedMarket?.orderable ?? false;
        const marketLabel = selectedMarket?.label ?? "확인 중";
        const connection = currentBroker?.connection ?? payload.connections[id];
        const connectionMatchesAccountType = connection.environment === broker.environment;
        const connectionHealthy =
          connectionMatchesAccountType &&
          connection.brokerAuthenticated &&
          connection.accountSynchronized &&
          connection.marketWebSocketConnected &&
          connection.accountWebSocketConnected;
        const connectionFailed = connection.stage === "ERROR" || connection.stage === "DEGRADED";
        const globalEngineOn = dashboard
          ? !dashboard.engine.emergencyHalt && dashboard.engine.globalAutoTradingEnabled
          : !payload.settings.emergencyHalt && payload.settings.globalAutoTradingEnabled;
        const globalNewBuysAllowed = dashboard
          ? !dashboard.engine.newBuysPaused
          : !payload.settings.newBuysPaused;
        const marketRegime = dashboard?.market.regime;
        const marketRegimeBuyAllowed = marketRegime?.buyAllowed ?? false;
        const marketRegimeStatus = !marketRegime
          ? "확인 중"
          : !marketRegime.enabled
            ? "사용 안 함"
            : marketRegime.buyAllowed
              ? "신규매수 가능"
              : marketRegime.status === "WEAK"
                ? "약세장으로 자동 대기"
                : "판단 자료 확인 중";
        const checks = [
          { label: "전체 자동주문", ready: globalEngineOn, status: globalEngineOn ? "켜짐" : "꺼짐", state: globalEngineOn ? "ready" : "blocked" },
          { label: "새 종목 매수", ready: globalNewBuysAllowed, status: globalNewBuysAllowed ? "허용" : "정지", state: globalNewBuysAllowed ? "ready" : "blocked" },
          { label: `${brokerNames[id]} 계좌 사용`, ready: broker.enabled, status: broker.enabled ? "사용 중" : "사용 안 함", state: broker.enabled ? "ready" : "blocked" },
          { label: "조건 맞으면 자동 주문", ready: broker.autoTradingEnabled, status: broker.autoTradingEnabled ? "사용 중" : "사용 안 함", state: broker.autoTradingEnabled ? "ready" : "blocked" },
          { label: "새 종목도 매수", ready: !broker.newBuysPaused, status: !broker.newBuysPaused ? "허용" : "정지", state: !broker.newBuysPaused ? "ready" : "blocked" },
          { label: "시장 전체 흐름", ready: marketRegimeBuyAllowed, status: marketRegimeStatus, state: marketRegimeBuyAllowed ? "ready" : "waiting" },
          { label: "로그인·잔고·실시간 가격", ready: connectionHealthy, status: connectionHealthy ? "연결 완료" : connectionFailed ? "확인 필요" : broker.enabled ? "연결 중" : "계좌 사용 안 함", state: connectionHealthy ? "ready" : connectionFailed || !broker.enabled ? "blocked" : "waiting" },
          { label: `주문 시장(${orderRoute === "SOR" ? "자동 선택" : orderRoute})`, ready: marketOpen, status: marketLabel, state: marketOpen ? "ready" : "waiting" },
        ];
        const ready = checks.every((check) => check.ready);
        const operatorStopped =
          !globalEngineOn ||
          !globalNewBuysAllowed ||
          !broker.enabled ||
          !broker.autoTradingEnabled ||
          broker.newBuysPaused;
        const marketRegimeWaiting = !marketRegimeBuyAllowed;
        const summary = ready
          ? "신규매수 가능"
          : connectionFailed
            ? "연결 확인 필요"
            : !connectionHealthy && broker.enabled
              ? "연결 중"
              : operatorStopped
                ? "신규매수 정지"
                : !marketOpen
                  ? "장 시작 대기"
                  : marketRegimeWaiting
                    ? marketRegime?.status === "WEAK" ? "약세장 매수 대기" : "장세 자료 확인 중"
                    : "주문 준비 중";
        return <article key={id} className="trade-broker-checks">
          <header><strong>{brokerNames[id]} · {broker.environment === "live" ? "실전투자" : "모의투자"}</strong><b className={ready ? "positive" : operatorStopped || connectionFailed ? "negative" : "trade-waiting"}>{summary}</b></header>
          <ul>{checks.map((check) => <li key={check.label} className={check.state}><span aria-hidden>{check.state === "ready" ? "✓" : check.state === "blocked" ? "×" : "•"}</span>{check.label}<b>{check.status}</b></li>)}</ul>
          <p>마지막으로 이동평균·거래량 조건과 주문금액·손실 한도를 주문 직전에 다시 검사합니다.</p>
        </article>;
      })}
    </div>
    <div className="trade-guide-note"><AlertTriangle size={15} /><span><strong>새 종목 매수 멈춤</strong>은 새 매수만 막습니다. 이미 가진 종목의 자동매도까지 모두 막으려면 위의 <strong>모든 주문 즉시 정지</strong>를 누르세요.</span></div>
  </section>;
}

function CredentialCard({ id, environment, status, connection, market, reload }: {
  id: BrokerId;
  environment: "live" | "paper";
  status: SettingsResponse["credentials"][BrokerId]["live"];
  connection: BrokerConnectionReadiness | null;
  market: BrokerMarketView | null;
  reload: () => Promise<void>;
}) {
  const [appKey, setAppKey] = useState("");
  const [appSecret, setAppSecret] = useState("");
  const [accountId, setAccountId] = useState("");
  const [accountProductCode, setAccountProductCode] = useState("01");
  const [htsId, setHtsId] = useState("");
  const [busy, setBusy] = useState(false);
  const [editingCredentials, setEditingCredentials] = useState(!status.configured);
  const [feedback, setFeedback] = useState<{ kind: "success" | "waiting" | "danger"; text: string } | null>(null);
  const isKis = id === "koreainvestment";
  const environmentManaged = status.source === "environment";

  async function submit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setFeedback(null);
    try {
      const result = await getJson<SaveCredentialsResponse>(`/api/engine/credentials/${id}/${environment}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          appKey: appKey.trim(),
          appSecret: appSecret.trim(),
          accountId: accountId.trim(),
          ...(isKis ? {
            accountProductCode: accountProductCode.trim(),
            htsId: htsId.trim(),
          } : {}),
          connectNow: true,
        }),
      });
      setAppKey("");
      setAppSecret("");
      setAccountId("");
      setHtsId("");
      setEditingCredentials(false);
      const feedbackKind = result.connection.readyForOrders
        ? "success"
        : result.connection.stage === "ERROR" || result.connection.stage === "DEGRADED"
          ? "danger"
          : "waiting";
      setFeedback({
        kind: feedbackKind,
        text: result.message,
      });
      await reload();
    } catch (cause) {
      setFeedback({ kind: "danger", text: koreanErrorMessage(cause, "계좌 연결을 확인하지 못했습니다. 입력한 정보와 증권사 API 상태를 확인해 주세요.") });
    } finally {
      setBusy(false);
    }
  }

  async function remove(): Promise<void> {
    if (environmentManaged || !window.confirm(`${brokerNames[id]} ${environment === "live" ? "실전" : "모의"} 자격증명을 삭제할까요? 연결도 안전하게 중지됩니다.`)) return;
    setBusy(true);
    setFeedback(null);
    try {
      await getJson(`/api/engine/credentials/${id}/${environment}`, { method: "DELETE" });
      setFeedback({ kind: "success", text: "저장된 자격증명을 삭제하고 해당 증권사 연결을 중지했습니다." });
      setEditingCredentials(true);
      await reload();
    } catch (cause) {
      setFeedback({ kind: "danger", text: koreanErrorMessage(cause, "저장된 계좌 정보를 삭제하지 못했습니다.") });
    } finally {
      setBusy(false);
    }
  }

  const storageName = status.source === "os-keychain"
    ? "운영체제 보안 저장소"
    : status.source === "encrypted-file"
      ? "서버 암호화 저장소"
      : status.source === "environment"
        ? "서버 환경변수"
        : "저장 전";
  const credentialFormId = `credential-form-${id}-${environment}`;

  function closeCredentialForm(): void {
    setAppKey("");
    setAppSecret("");
    setAccountId("");
    setAccountProductCode("01");
    setHtsId("");
    setFeedback(null);
    setEditingCredentials(false);
  }

  return <article className="settings-card credential-card">
    <div className="credential-title"><KeyRound size={17} /><div><h2>{brokerNames[id]}</h2><p>{isKis ? "현물 " : ""}{environment === "live" ? "실전투자" : "모의투자"} 계좌 연결</p></div><span className={status.configured ? "configured" : "missing"}>{status.configured ? "저장됨" : "미설정"}</span></div>
    <dl><div><dt>API 정보 보관 위치</dt><dd>{storageName}</dd></div><div><dt>계좌번호</dt><dd>{status.maskedAccountId ?? "—"}</dd></div></dl>
    {environment === "live" ? <div className="credential-warning"><AlertTriangle size={15} /><span>실전투자 계좌입니다. API 키를 저장해도 자동주문과 신규매수는 자동으로 켜지지 않습니다.</span></div> : null}
    {isKis ? <div className="trade-guide-note"><ShieldCheck size={15} /><span>선물·옵션 계좌는 현물 계좌와 따로 등록합니다. 같은 API 정보를 재사용할 수 있습니다. <Link href="/derivatives/settings">선물·옵션 계좌 연결</Link></span></div> : null}
    {status.configured && connection ? <CredentialConnectionStatus connection={connection} market={market} /> : null}
    {status.configured && !connection ? <div className="credential-feedback waiting" role="status"><Clock3 size={15} /><span>계좌 환경 변경을 저장하면 해당 환경의 연결 상태를 확인합니다.</span></div> : null}
    {environmentManaged ? <div className="credential-managed"><ShieldCheck size={15} /><span>이 API 키는 서버 환경설정에서 관리됩니다. 이 화면에서는 바꿀 수 없습니다.</span></div> : status.configured && !editingCredentials ? <div className="credential-collapsed-actions">
      <button className="secondary" type="button" aria-expanded="false" aria-controls={credentialFormId} onClick={() => { setFeedback(null); setEditingCredentials(true); }}><KeyRound size={15} />API 정보 바꾸기</button>
      <button className="secondary danger-text" type="button" disabled={busy} onClick={() => void remove()}><Trash2 size={15} />저장 정보 삭제</button>
    </div> : <form id={credentialFormId} className="credential-form" onSubmit={(event) => void submit(event)}>
      <label className="field"><span>API 키</span><input type="password" value={appKey} onChange={(event) => setAppKey(event.target.value)} autoComplete="new-password" autoCapitalize="none" spellCheck={false} required /><em className="field-help">{brokerNames[id]} 개발자센터에서 발급받은 App Key를 입력합니다.</em></label>
      <label className="field"><span>API 비밀키</span><input type="password" value={appSecret} onChange={(event) => setAppSecret(event.target.value)} autoComplete="new-password" autoCapitalize="none" spellCheck={false} required /><em className="field-help">발급받은 App Secret 또는 Secret Key입니다. 화면이나 데이터베이스에 평문으로 저장하지 않습니다.</em></label>
      <label className="field"><span>계좌번호</span><input type="text" inputMode="numeric" value={accountId} onChange={(event) => setAccountId(event.target.value)} autoComplete="off" placeholder="하이픈 없이 숫자만 입력" required /><em className="field-help">주문과 잔고를 조회할 본인 계좌번호를 입력합니다.</em></label>
      {isKis ? <><label className="field"><span>계좌번호 뒤 2자리(상품번호)</span><input type="text" inputMode="numeric" maxLength={2} value={accountProductCode} onChange={(event) => setAccountProductCode(event.target.value)} autoComplete="off" required /><em className="field-help">일반 주식계좌는 보통 01입니다.</em></label><label className="field"><span>증권사 로그인 ID(HTS ID)</span><input type="text" value={htsId} onChange={(event) => setHtsId(event.target.value)} autoComplete="off" autoCapitalize="none" spellCheck={false} required /><em className="field-help">한국투자증권 주문·체결 알림을 받는 데 쓰는 사용자 ID입니다.</em></label></> : null}
      <div className="credential-actions"><button className="connect-button" type="submit" disabled={busy}><Link2 size={15} />{busy ? "처리 중…" : "저장하고 연결 시작"}</button>{status.configured ? <button className="secondary" type="button" disabled={busy} aria-expanded="true" aria-controls={credentialFormId} onClick={closeCredentialForm}>취소</button> : null}</div>
    </form>}
    {feedback ? <div className={`credential-feedback ${feedback.kind}`} role="status">{feedback.kind === "success" ? <Check size={15} /> : feedback.kind === "waiting" ? <Clock3 size={15} /> : <AlertTriangle size={15} />}<span>{feedback.text}</span></div> : null}
  </article>;
}

function CredentialConnectionStatus({ connection, market }: {
  connection: BrokerConnectionReadiness;
  market: BrokerMarketView | null;
}) {
  const failed = connection.stage === "ERROR" || connection.stage === "DEGRADED";
  const connectionHealthy =
    connection.brokerAuthenticated &&
    connection.accountSynchronized &&
    connection.marketWebSocketConnected &&
    connection.accountWebSocketConnected;
  const marketOpen = market?.orderable ?? false;
  const marketStatus = market?.label ?? "확인 대기";
  const tone = connectionHealthy ? "success" : failed ? "danger" : "waiting";
  const Icon = connectionHealthy ? Check : failed ? AlertTriangle : Clock3;
  const summary = connectionHealthy && market !== null && !marketOpen
    ? `로그인·계좌·실시간 연결이 완료됐습니다. ${marketStatus}이므로 주문만 대기합니다.`
    : connection.message;

  return <section className={`credential-readiness ${tone}`} aria-label="증권사 연결 준비 상태">
    <div className="credential-readiness-summary"><Icon size={15} /><div><strong>{summary}</strong><span>연결 완료와 실제 주문 허용은 서로 다른 상태입니다.</span></div></div>
    <div className="readiness-grid">
      <ReadinessItem label="API 키 저장" complete={connection.credentialsStored} failed={!connection.credentialsStored} pending="미저장" />
      <ReadinessItem label="증권사 로그인" complete={connection.brokerAuthenticated} failed={connection.stage === "ERROR"} pending={connection.stage === "AUTHENTICATING" ? "로그인 중" : "확인 대기"} />
      <ReadinessItem label="잔고·주문 내역 맞추기" complete={connection.accountSynchronized} failed={connection.stage === "ERROR" && connection.brokerAuthenticated} pending={connection.stage === "ACCOUNT_SYNCING" ? "확인 중" : "대기"} />
      <ReadinessItem label="실시간 가격 받기" complete={connection.marketWebSocketConnected} failed={connection.stage === "DEGRADED"} pending="연결 대기" />
      <ReadinessItem label="주문·체결 알림 받기" complete={connection.accountWebSocketConnected} failed={connection.stage === "DEGRADED"} pending="연결 대기" />
      <ReadinessItem label="선택한 시장 주문 시간" complete={marketOpen} failed={false} pending={marketStatus} />
      <ReadinessItem label="증권사 주문 연결" complete={connection.readyForOrders} failed={failed} pending={marketOpen ? "시장 상태 확인 중" : "주문 시간에 확인"} />
    </div>
  </section>;
}

function ReadinessItem({ label, complete, failed, pending }: {
  label: string;
  complete: boolean;
  failed: boolean;
  pending: string;
}) {
  return <div><span>{label}</span><b className={complete ? "complete" : failed ? "failed" : "pending"}>{complete ? "완료" : failed ? "확인 필요" : pending}</b></div>;
}

function BrokerSettingsPanel({ id, settings, strategies, update, onPresetFilled }: { id: BrokerId; settings: BrokerSettings; strategies: SettingsResponse["strategies"]; update: (updater: (value: BrokerSettings) => BrokerSettings) => void; onPresetFilled: () => void }) {
  const set = <K extends keyof BrokerSettings>(key: K, value: BrokerSettings[K]) => update((current) => ({ ...current, [key]: value }));
  const setPolicy = <K extends keyof BrokerSettings["orderPolicy"]>(key: K, value: BrokerSettings["orderPolicy"][K]) => update((current) => ({ ...current, orderPolicy: { ...current.orderPolicy, [key]: value } }));
  const selectedStrategy = strategies.find((strategy) => strategy.id === settings.strategyId) ?? strategies[0];
  const presetAvailable = strategies.some((strategy) => strategy.id === autoTradingPresetStrategyId);
  const fillAutoTradingPreset = () => {
    if (!presetAvailable) return;
    update((current) => withAutoTradingPreset(current, strategies));
    onPresetFilled();
  };
  const setStrategy = (key: string, value: number) => update((current) => ({ ...current, strategyConfig: { ...current.strategyConfig, [key]: value } }));
  const changeStrategy = (strategyId: string) => {
    const strategy = strategies.find((row) => row.id === strategyId);
    update((current) => ({
      ...current,
      strategyId,
      strategyConfig: strategy ? { ...strategy.defaultConfig } : current.strategyConfig,
    }));
  };
  const changeResumeAfterRestart = (value: boolean) => {
    if (
      value && settings.environment === "live" &&
      !window.confirm(`${brokerNames[id]} 실전계좌가 서버 재시작 뒤 마지막 자동운용 상태를 이어가도록 설정합니다. 계좌·주문·잔고 확인이 끝난 뒤에만 재개됩니다. 계속할까요?`)
    ) return;
    set("resumeAfterRestart", value);
  };

  return <section className="settings-card form-section"><div className="form-heading"><div><p className="settings-kicker">계좌별 운용 설정</p><h2>{brokerNames[id]}</h2><p className="form-description">매매 조건과 금액을 저장하는 곳입니다. 실제 자동매매 시작·완전정지는 <Link href="/">자동매매 현황</Link>의 계좌 버튼에서 즉시 바꿉니다.</p></div><div className="toggle-row"><Toggle label="이 계좌 연결 사용" checked={settings.enabled} onChange={(value) => set("enabled", value)} /><Toggle label="재시작 뒤 자동으로 계속" checked={settings.resumeAfterRestart} onChange={changeResumeAfterRestart} /></div></div>
    <div className="toggle-guidance"><span><strong>이 계좌 연결 사용</strong>을 끄면 이 증권사 API에 접속하지 않습니다.</span><span><strong>재시작 뒤 자동으로 계속</strong>을 켜두면 장 마감이나 서버 재시작 뒤에도 마지막 자동운용 상태를 이어갑니다. 안전 확인이 끝나기 전에는 주문하지 않습니다.</span><span><strong>운용 ON/OFF는 설정 저장으로 바뀌지 않습니다.</strong> 오래 열어둔 화면이 자동매매 상태를 되돌리는 일을 막았습니다.</span></div>
    <div className="form-grid four"><SelectField label="사용할 계좌 종류" value={settings.environment} onChange={(value) => set("environment", value as "live" | "paper")} options={[{ value: "paper", label: "모의투자 계좌" }, { value: "live", label: "실전투자 계좌" }]} danger={settings.environment === "live"} help="실전투자는 실제 돈으로 주문합니다. 바꾼 뒤 해당 환경의 API 키를 연결해야 합니다." /><SelectField label="주문을 보낼 시장" value={settings.orderRoute} onChange={(value) => set("orderRoute", value as BrokerSettings["orderRoute"])} options={[{ value: "KRX", label: "한국거래소만(KRX)" }, { value: "NXT", label: "넥스트레이드 직접(NXT 지원종목만)" }, { value: "SOR", label: "증권사가 자동 선택(SOR·추천)" }]} help="자동 선택(SOR)은 증권사가 KRX와 NXT 중 가능한 시장으로 보냅니다. NXT 직접 주문은 NXT 지원종목에만 가능하며, 지원하지 않는 종목은 증권사가 거절합니다. 조건검사는 자동매매가 꺼져 있어도 계속됩니다." /><SelectField label="매매 조건" value={settings.strategyId} onChange={changeStrategy} options={strategies.map((strategy) => ({ value: strategy.id, label: `${strategy.name} (${strategy.version}판)` }))} help="어떤 계산 규칙으로 매수·매도 후보를 찾을지 선택합니다. 선택하면 아래 숫자가 해당 전략의 기본값으로 바뀝니다." /><SelectField label="주문 가격 방식" value={settings.orderPolicy.orderType} onChange={(value) => setPolicy("orderType", value as "market" | "limit")} options={[{ value: "market", label: "시장가: 바로 살 수 있는 가격" }, { value: "limit", label: "지정가: 내가 정한 가격" }]} help="시장가는 체결 가능성이 높지만 가격이 달라질 수 있고, 지정가는 정한 가격에 닿지 않으면 체결되지 않을 수 있습니다." /></div>
    <div className="auto-trading-preset">
      <button className="secondary" type="button" disabled={!presetAvailable} onClick={fillAutoTradingPreset}>자동 매매 기본값 채우기</button>
      <p>눌림 뒤 반등할 때 매수하고, 3% 하락하면 매도합니다. 수익이 3%에 도달하면 고점을 따라가며 최고가에서 1.5% 내려올 때 팔고, 5거래일을 채워도 수익률이 1% 이하이면 매도합니다. 매도 후에는 30분과 새 매수 신호를 기다립니다.</p>
      <small>입력칸에만 채워집니다. ‘설정 저장’을 눌러야 적용됩니다. 투자금·주문방식·계좌·운용 ON/OFF는 그대로 유지합니다.{!presetAvailable ? " 기본 전략을 불러온 뒤 사용할 수 있습니다." : ""}</small>
    </div>
    <h3>투자금·손실·미체결 안전 한도</h3><div className="form-grid four"><NumberField label="한 번 살 금액" value={settings.orderPolicy.perTradeBudget} onChange={(value) => setPolicy("perTradeBudget", value)} suffix="원" min={1} help="매수 신호 한 번에 사용할 목표 금액입니다. 현재가로 살 수 있는 정수 수량만 주문합니다." /><NumberField label="한 종목에 넣을 최대금액" value={settings.orderPolicy.perSymbolLimit} onChange={(value) => setPolicy("perSymbolLimit", value)} suffix="원" min={1} help="이미 보유한 금액과 진행 중인 매수 주문을 합쳐 이 금액을 넘지 않게 합니다." /><NumberField label="이 계좌에서 쓸 최대금액" value={settings.orderPolicy.accountInvestmentLimit} onChange={(value) => setPolicy("accountInvestmentLimit", value)} suffix="원" min={1} help="이 증권사 계좌의 전체 보유금액과 진행 중인 매수 주문 합계 한도입니다." /><NumberField label="하루 동안 새로 살 최대금액" value={settings.orderPolicy.dailyInvestmentLimit} onChange={(value) => setPolicy("dailyInvestmentLimit", value)} suffix="원" min={1} help="오늘 새로 낸 매수 주문의 누적 금액이 이 한도를 넘으면 추가 매수를 막습니다." /><NumberField label="하루 손실 자동정지 기준" value={settings.orderPolicy.dailyMaxLoss} onChange={(value) => setPolicy("dailyMaxLoss", value)} suffix="원" min={1} help="오늘 손익이 이 금액만큼 손실이면 추가 매수를 막습니다." /><NumberField label="동시에 보유할 종목 수" value={settings.orderPolicy.maxPositions} onChange={(value) => setPolicy("maxPositions", value)} suffix="개" min={1} help="보유종목과 아직 체결되지 않은 신규 매수종목을 합친 최대 개수입니다." /><PercentField label="지정가 조정률" valueBps={settings.orderPolicy.limitOffsetBps} onChange={(value) => setPolicy("limitOffsetBps", value)} help="지정가 주문에만 사용합니다. 0%면 현재가 기준이며, 양수는 더 높은 가격으로 조정합니다." /><NumberField label="미체결 주문을 기다릴 시간" value={settings.orderPolicy.unfilledTimeoutSeconds} onChange={(value) => setPolicy("unfilledTimeoutSeconds", value)} suffix="초" min={10} help="이 시간이 지나도 전부 체결되지 않으면 아래 자동취소 설정을 적용합니다." /><Toggle label="시간이 지나면 남은 수량 취소" checked={settings.orderPolicy.cancelRemainderOnTimeout} onChange={(value) => setPolicy("cancelRemainderOnTimeout", value)} help="부분체결된 주문은 체결된 수량을 유지하고 남은 수량만 취소합니다." /></div>
    <h3>보유종목 자동매도·재매수</h3>
    <p className="form-description">매수한 뒤에도 보유종목을 계속 검사합니다. 아래에서 켜둔 매도 조건이나 선택한 전략의 매도 신호가 나오면 팔고, 이후 새로운 매수 기회를 다시 찾습니다.</p>
    <div className="form-grid">
    <div className="form-grid four">
      <Toggle label="손실이 커지면 팔기" checked={settings.orderPolicy.stopLossEnabled ?? false} onChange={(value) => setPolicy("stopLossEnabled", value)} help="평균 매수가보다 손절 기준만큼 내려가면 보유 가능 수량을 매도합니다." />
      <PercentField label="손절 기준 손실률" valueBps={settings.orderPolicy.stopLossBps ?? 300} onChange={(value) => setPolicy("stopLossBps", value)} min={0.01} max={99.99} help="예: 3%면 평균 매수가 대비 수익률이 -3% 이하일 때 매도합니다. 실제 체결가격은 달라질 수 있습니다." />
      <Toggle label="목표수익에 도달하면 자동매도" checked={settings.orderPolicy.takeProfitEnabled} onChange={(value) => setPolicy("takeProfitEnabled", value)} help="수익률이 정한 목표에 도달하면 보유 가능 수량을 매도합니다. 수익을 따라가며 팔기도 켜면 먼저 충족된 조건을 적용합니다." />
      <PercentField label="익절 목표수익률" valueBps={settings.orderPolicy.takeProfitBps} onChange={(value) => setPolicy("takeProfitBps", value)} min={0.01} max={100} help="평균 매수가 대비 현재가 수익률이 이 값 이상이면 보유 가능 수량 전체를 매도 후보로 봅니다. 시장가 체결가격은 달라질 수 있습니다." />
    </div>
    <div className="form-grid four">
      <Toggle label="수익을 따라가며 팔기" checked={settings.orderPolicy.trailingProfitEnabled ?? false} onChange={(value) => setPolicy("trailingProfitEnabled", value)} help="수익이 시작 기준에 도달하면 고점을 기억하고, 그 고점에서 정한 폭만큼 내려왔을 때 매도합니다." />
      <PercentField label="수익 추적을 시작할 수익률" valueBps={settings.orderPolicy.trailingActivationBps ?? 300} onChange={(value) => setPolicy("trailingActivationBps", value)} min={0.01} max={1000} help="예: 3%면 평균 매수가보다 3% 이상 오른 뒤부터 고점 대비 하락을 감시합니다." />
      <PercentField label="고점에서 내려오면 팔 하락률" valueBps={settings.orderPolicy.trailingDrawdownBps ?? 150} onChange={(value) => setPolicy("trailingDrawdownBps", value)} min={0.01} max={99.99} help="예: 1.5%면 수익 추적 중 기록한 고점보다 1.5% 내려왔을 때 매도합니다." />
    </div>
    <div className="form-grid four">
      <Toggle label="오래 제자리면 팔기" checked={settings.orderPolicy.stagnationExitEnabled ?? false} onChange={(value) => setPolicy("stagnationExitEnabled", value)} help="정한 거래일이 지나도 수익률이 아래 기준 이하이면 보유 가능 수량을 매도합니다. 기준보다 잘 오르는 종목은 기간만으로 팔지 않습니다." />
      <NumberField label="제자리인 종목을 기다릴 기간" value={settings.orderPolicy.stagnationTradingDays ?? 5} onChange={(value) => setPolicy("stagnationTradingDays", value)} suffix="거래일" min={1} max={250} step={1} help="매수일과 아직 끝나지 않은 오늘을 제외한 거래일을 셉니다. 주말·휴장일은 빼며, 매수 시점을 확인할 수 있는 보유분에 적용합니다." />
      <PercentField label="제자리로 보는 최대 수익률" valueBps={settings.orderPolicy.stagnationMaxReturnBps ?? 100} onChange={(value) => setPolicy("stagnationMaxReturnBps", value)} min={-100} max={100} help="예: 1%면 기다릴 기간이 지난 뒤 수익률이 1% 이하인 종목을 매도합니다." />
      <NumberField label="매도 후 재매수 대기" value={settings.orderPolicy.reentryCooldownMinutes ?? 30} onChange={(value) => setPolicy("reentryCooldownMinutes", value)} suffix="분" min={0} max={10080} step={1} help="매도가 체결된 뒤 이 시간 동안 같은 종목을 다시 사지 않습니다. 시간이 지나도 이전 매수 신호가 끝나고 새 매수 신호가 나와야 다시 삽니다." />
    </div>
    </div>
    <h3>{selectedStrategy?.name ?? "매매 전략"} 세부 조건</h3>
    <p className="form-description">{selectedStrategy?.description ?? "선택한 전략의 계산 조건입니다."} 숫자를 바꿔도 위의 ‘설정 저장’을 눌러야 엔진에 반영됩니다.</p>
    <div className="form-grid four">{selectedStrategy?.configFields.map((field) => {
      const currentValue = settings.strategyConfig[field.key];
      const value = typeof currentValue === "number" ? currentValue : field.defaultValue;
      return field.kind === "percent"
        ? <PercentField key={field.key} label={field.label} valueBps={value} onChange={(next) => setStrategy(field.key, next)} help={field.help} min={field.min} max={field.max} />
        : <NumberField key={field.key} label={field.label} value={value} onChange={(next) => setStrategy(field.key, next)} suffix={field.suffix} help={field.help} min={field.min} max={field.max} step={field.step} />;
    })}</div>
  </section>;
}

function Toggle({ label, checked, onChange, help }: { label: string; checked: boolean; onChange: (value: boolean) => void; help?: string }) { return <label className={`toggle ${help ? "with-help" : ""}`}><input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} /><span /><b>{label}</b>{help ? <em>{help}</em> : null}</label>; }
function NumberField({ label, value, onChange, suffix, help, min, max, step }: { label: string; value: number; onChange: (value: number) => void; suffix?: string; help?: string; min?: number; max?: number; step?: number }) { return <label className="field"><span>{label}</span><div><input type="number" value={value} min={min} max={max} step={step} onChange={(event) => onChange(Number(event.target.value))} />{suffix ? <small>{suffix}</small> : null}</div>{help ? <em className="field-help">{help}</em> : null}</label>; }
function PercentField({ label, valueBps, onChange, help, min, max }: { label: string; valueBps: number; onChange: (value: number) => void; help: string; min?: number; max?: number }) { return <NumberField label={label} value={valueBps / 100} onChange={(value) => onChange(Math.round(value * 100))} suffix="%" help={help} min={min} max={max} step={0.01} />; }
function SecondsField({ label, valueMs, onChange, help, min }: { label: string; valueMs: number; onChange: (value: number) => void; help: string; min: number }) { return <NumberField label={label} value={valueMs / 1_000} onChange={(value) => onChange(Math.round(value * 1_000))} suffix="초" help={help} min={min} step={1} />; }
function SelectField({ label, value, onChange, options, danger, help }: { label: string; value: string; onChange: (value: string) => void; options: Array<{ value: string; label: string }>; danger?: boolean; help?: string }) { return <label className={`field ${danger ? "danger-field" : ""}`}><span>{label}</span><select value={value} onChange={(event) => onChange(event.target.value)}>{options.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}</select>{help ? <em className="field-help">{help}</em> : null}</label>; }
