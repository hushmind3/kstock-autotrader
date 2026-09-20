"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { FormEvent, KeyboardEvent } from "react";
import {
  AlertCircle,
  AlertTriangle,
  Check,
  Clock3,
  KeyRound,
  Link2,
  RefreshCw,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { DerivativesAutomationSettingsCard } from "./derivatives-automation-settings-card";
import { formatDateTime, getJson } from "../lib/client-api";
import type {
  DashboardResponse,
  DerivativesCredentialConnectionState,
  DerivativesCredentialResponse,
  MarketSessionState,
  MarketVenueSession,
  SettingsResponse,
} from "../lib/api-types";

type DerivativesBrokerTab = "kiwoom" | "koreainvestment";
type TradingEnvironment = "live" | "paper";
type DerivativesStatusByEnvironment = Record<TradingEnvironment, DerivativesCredentialResponse | null>;
type DerivativesErrorsByEnvironment = Record<TradingEnvironment, boolean>;

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
    ...(values.reuseCashCredentials ? {} : {
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
    return authenticated
      ? "API 로그인 완료 · 선물계좌 연결 필요"
      : "API 로그인 확인 필요";
  }
  if (state === "VERIFYING") return "로그인·선물 계좌 확인 중";
  if (state === "VERIFIED" && authenticated && accountSynchronized) return "실제 선물 계좌 조회 확인 완료";
  if (state === "VERIFIED" && authenticated) return "로그인 완료 · 계좌 확인 대기";
  return "저장됨 · 연결 확인 전";
}

const sessionStateLabel: Record<MarketSessionState, string> = {
  CLOSED: "장 종료",
  PREOPEN: "장 시작 대기",
  OPEN: "거래 시간",
  AFTER_HOURS: "시간외 거래",
  BREAK: "휴장 구간",
  HOLIDAY: "휴장일",
};

const sessionDefinitions = [
  { id: "KRX_DERIVATIVES_DAY", label: "선물·옵션 주간" },
  { id: "KRX_DERIVATIVES_NIGHT", label: "선물·옵션 야간" },
] as const;

const emptyDerivativeStatuses: DerivativesStatusByEnvironment = { live: null, paper: null };
const emptyDerivativeErrors: DerivativesErrorsByEnvironment = { live: false, paper: false };

export function DerivativesSettingsPanel({ embedded = false }: { embedded?: boolean } = {}) {
  const [brokerTab, setBrokerTab] = useState<DerivativesBrokerTab>("koreainvestment");
  const [dashboard, setDashboard] = useState<DashboardResponse | null>(null);
  const [cashSettings, setCashSettings] = useState<SettingsResponse | null>(null);
  const [cashSettingsChecked, setCashSettingsChecked] = useState(false);
  const [derivativesStatuses, setDerivativesStatuses] = useState<DerivativesStatusByEnvironment>(emptyDerivativeStatuses);
  const [dashboardError, setDashboardError] = useState(false);
  const [derivativesStatusErrors, setDerivativesStatusErrors] = useState<DerivativesErrorsByEnvironment>(emptyDerivativeErrors);

  const load = useCallback(async () => {
    const [dashboardResult, settingsResult, liveResult, paperResult] = await Promise.allSettled([
      getJson<DashboardResponse>("/api/engine/dashboard"),
      getJson<SettingsResponse>("/api/engine/settings"),
      getJson<DerivativesCredentialResponse>("/api/engine/derivatives/credentials/koreainvestment/live"),
      getJson<DerivativesCredentialResponse>("/api/engine/derivatives/credentials/koreainvestment/paper"),
    ]);

    if (dashboardResult.status === "fulfilled") {
      setDashboard(dashboardResult.value);
      setDashboardError(false);
    } else {
      setDashboardError(true);
    }
    if (settingsResult.status === "fulfilled") setCashSettings(settingsResult.value);
    setCashSettingsChecked(true);
    setDerivativesStatuses((current) => ({
      live: liveResult.status === "fulfilled" ? liveResult.value : current.live,
      paper: paperResult.status === "fulfilled" ? paperResult.value : current.paper,
    }));
    setDerivativesStatusErrors({
      live: liveResult.status === "rejected",
      paper: paperResult.status === "rejected",
    });
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 3_000);
    return () => window.clearInterval(timer);
  }, [load]);

  const sessions = useMemo(() => {
    const byId = new Map((dashboard?.market.sessions ?? []).map((session) => [session.id, session]));
    return sessionDefinitions.map((definition) => ({
      ...definition,
      session: byId.get(definition.id) ?? null,
    }));
  }, [dashboard]);

  const selectBrokerTab = (next: DerivativesBrokerTab) => {
    setBrokerTab(next);
    window.requestAnimationFrame(() => document.getElementById(`derivatives-tab-${next}`)?.focus());
  };

  const handleBrokerTabKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === "Home" || event.key === "ArrowLeft" ? "kiwoom" : "koreainvestment";
    selectBrokerTab(next);
  };

  return <>
    {!embedded ? <header className="page-header"><div><p className="eyebrow">선물·옵션 자동매매 설정</p><h1>선물·옵션 자동매매 설정</h1><p className="subtitle">계좌 연결과 운용 방식을 설정합니다.</p></div><button className="icon-button" onClick={() => void load()} aria-label="새로고침"><RefreshCw size={16} /></button></header> : null}
    {dashboardError ? <section className="notice danger"><AlertCircle size={17} /><div><strong>시장 시간표를 불러오지 못했습니다</strong><p>잠시 후 자동으로 다시 확인합니다. 지금 다시 시도하려면 새로고침을 눌러 주세요.</p></div></section> : null}
    <DerivativesAutomationSettingsCard />
    <section className="derivatives-session-grid" aria-label="선물 옵션 시장 시간">
      {sessions.map(({ id, label, session }) => <SessionCard key={id} label={label} session={session} />)}
      <p>시장 시간표만 표시합니다. ‘거래소 거래 시간’이어도 선물 계좌가 연결됐거나 주문이 가능하다는 뜻은 아닙니다.</p>
    </section>
    <div className="filter-tabs derivatives-broker-tabs" role="tablist" aria-label="선물·옵션 증권사">
      <button id="derivatives-tab-kiwoom" type="button" role="tab" aria-controls="derivatives-panel" aria-selected={brokerTab === "kiwoom"} tabIndex={brokerTab === "kiwoom" ? 0 : -1} className={brokerTab === "kiwoom" ? "selected" : ""} onKeyDown={handleBrokerTabKey} onClick={() => selectBrokerTab("kiwoom")}>키움증권</button>
      <button id="derivatives-tab-koreainvestment" type="button" role="tab" aria-controls="derivatives-panel" aria-selected={brokerTab === "koreainvestment"} tabIndex={brokerTab === "koreainvestment" ? 0 : -1} className={brokerTab === "koreainvestment" ? "selected" : ""} onKeyDown={handleBrokerTabKey} onClick={() => selectBrokerTab("koreainvestment")}>한국투자증권</button>
    </div>
    <section id="derivatives-panel" aria-labelledby={`derivatives-tab-${brokerTab}`} className="derivatives-tab-panel" role="tabpanel" tabIndex={0}>
      {brokerTab === "koreainvestment" ? <KisDerivativesAccountCard
        cashSettings={cashSettings}
        cashSettingsChecked={cashSettingsChecked}
        statuses={derivativesStatuses}
        statusErrors={derivativesStatusErrors}
        reload={load}
      /> : <KiwoomUnavailableCard />}
    </section>
  </>;
}

export function DerivativesSettingsClient() {
  return <main className="shell">
    <DerivativesSettingsPanel />
  </main>;
}

function KisDerivativesAccountCard({ cashSettings, cashSettingsChecked, statuses, statusErrors, reload }: {
  cashSettings: SettingsResponse | null;
  cashSettingsChecked: boolean;
  statuses: DerivativesStatusByEnvironment;
  statusErrors: DerivativesErrorsByEnvironment;
  reload: () => Promise<void>;
}) {
  const [environment, setEnvironment] = useState<TradingEnvironment>("live");
  const [editingCredentials, setEditingCredentials] = useState(false);
  // A KIS App Key is tied to the account selected during the Open API
  // application.  Reuse therefore has to be an explicit choice, especially
  // when cash and derivatives have different eight-digit CANOs.
  const [reuseCashCredentials, setReuseCashCredentials] = useState(false);
  const [accountId, setAccountId] = useState("");
  const [appKey, setAppKey] = useState("");
  const [appSecret, setAppSecret] = useState("");
  const [htsId, setHtsId] = useState("");
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ kind: "success" | "waiting" | "danger"; text: string } | null>(null);
  const status = statuses[environment];
  const statusUnavailable = statusErrors[environment];
  const cashCredentialsAvailable = cashSettings?.credentials.koreainvestment[environment].configured ?? false;
  const environmentManaged = status?.credentials.source === "environment";
  const showForm = editingCredentials || (status !== null && !status.credentials.configured);

  useEffect(() => {
    if (cashSettingsChecked && !cashCredentialsAvailable) setReuseCashCredentials(false);
  }, [cashCredentialsAvailable, cashSettingsChecked]);

  useEffect(() => {
    if (status?.connection.state !== "FAILED") return;
    setEditingCredentials(true);
    setReuseCashCredentials(false);
  }, [status?.connection.state]);

  function clearInputs(): void {
    setAccountId("");
    setAppKey("");
    setAppSecret("");
    setHtsId("");
  }

  function changeEnvironment(next: TradingEnvironment): void {
    setEnvironment(next);
    setEditingCredentials(false);
    setFeedback(null);
    clearInputs();
    setReuseCashCredentials(false);
  }

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setFeedback(null);
    try {
      const payload = buildDerivativesCredentialPayload({
        reuseCashCredentials,
        accountId,
        appKey,
        appSecret,
        htsId,
      });
      const result = await getJson<DerivativesCredentialResponse>(
        `/api/engine/derivatives/credentials/koreainvestment/${environment}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        },
      );
      clearInputs();
      setEditingCredentials(false);
      setFeedback({
        kind: result.connection.state === "FAILED" ? "danger" : result.connection.state === "VERIFIED" ? "success" : "waiting",
        text: result.connection.state === "VERIFIED"
          ? "선물 계좌를 확인했습니다. 저장만으로 선물 자동매매가 켜지지는 않습니다."
          : result.connection.state === "FAILED"
            ? result.connection.message
            : "선물 계좌를 저장했습니다. 증권사 로그인과 계좌 확인을 진행합니다.",
      });
      await reload();
    } catch (cause) {
      setFeedback({ kind: "danger", text: readableCredentialError(cause) });
    } finally {
      setBusy(false);
    }
  }

  async function remove(): Promise<void> {
    if (environmentManaged || !window.confirm(`한국투자증권 ${environment === "live" ? "실전" : "모의"} 선물 계좌 정보를 삭제할까요? 현물 계좌 정보는 삭제되지 않습니다.`)) return;
    setBusy(true);
    setFeedback(null);
    try {
      await getJson(`/api/engine/derivatives/credentials/koreainvestment/${environment}`, { method: "DELETE" });
      setFeedback({ kind: "success", text: "선물 계좌 정보만 삭제했습니다. 현물 계좌와 현물 자동매매 설정은 그대로입니다." });
      setEditingCredentials(true);
      await reload();
    } catch (cause) {
      setFeedback({ kind: "danger", text: readableCredentialError(cause) });
    } finally {
      setBusy(false);
    }
  }

  async function verify(): Promise<void> {
    setBusy(true);
    setFeedback({ kind: "waiting", text: "한국투자증권 API로 실제 선물 계좌를 조회하고 있습니다." });
    try {
      const result = await getJson<DerivativesCredentialResponse>(
        `/api/engine/derivatives/credentials/koreainvestment/${environment}/verify`,
        { method: "POST" },
      );
      setFeedback({
        kind: result.connection.state === "VERIFIED" ? "success" : "danger",
        text: result.connection.state === "VERIFIED"
          ? "실제 선물 계좌의 잔고와 미체결 주문을 확인했습니다."
          : result.connection.message,
      });
      await reload();
    } catch (cause) {
      setFeedback({ kind: "danger", text: readableCredentialError(cause) });
    } finally {
      setBusy(false);
    }
  }

  return <article className="settings-card credential-card derivatives-account-card">
    <div className="credential-title"><KeyRound size={17} /><div><h2>한국투자증권 선물·옵션 계좌</h2><p>현물 계좌와 별도로 주문·잔고·체결을 관리합니다.</p></div><span className={status?.credentials.configured ? "configured" : "missing"}>{status?.credentials.configured ? "저장됨" : "미설정"}</span></div>
    <div className="filter-tabs derivatives-environment-tabs" role="group" aria-label="선물 계좌 종류">
      <button type="button" aria-pressed={environment === "live"} disabled={busy} className={environment === "live" ? "selected" : ""} onClick={() => changeEnvironment("live")}>실전투자</button>
      <button type="button" aria-pressed={environment === "paper"} disabled={busy} className={environment === "paper" ? "selected" : ""} onClick={() => changeEnvironment("paper")}>모의투자</button>
    </div>
    {environment === "live" ? <div className="credential-warning"><AlertTriangle size={15} /><span>실제 돈이 움직이는 선물 계좌입니다. 저장하고 연결하는 것만으로 주문은 나가지 않으며, 운용 방식을 저장한 뒤 현황 화면에서 자동운용을 직접 시작해야 합니다.</span></div> : null}
    {statusUnavailable ? <div className="credential-feedback waiting" role="status"><Clock3 size={15} /><span>선물 계좌 연결 기능을 준비하고 있습니다. 잠시 후 자동으로 다시 확인합니다.</span></div> : null}
    {status?.credentials.configured ? <DerivativeAccountStatus status={status} /> : !status && !statusUnavailable ? <div className="credential-feedback waiting" role="status"><Clock3 size={15} /><span>선물 계좌 저장 상태를 확인하고 있습니다.</span></div> : null}
    {environmentManaged ? <div className="credential-managed"><ShieldCheck size={15} /><span>이 선물 계좌 정보는 서버 환경설정에서 관리됩니다. 이 화면에서는 바꿀 수 없습니다.</span></div> : status?.credentials.configured && !showForm ? <div className="credential-collapsed-actions">
      <button className="secondary" type="button" aria-expanded="false" aria-controls="derivatives-credential-form" onClick={() => { setFeedback(null); setEditingCredentials(true); }}><KeyRound size={15} />선물 계좌 정보 바꾸기</button>
      <button className="secondary danger-text" type="button" disabled={busy} onClick={() => void remove()}><Trash2 size={15} />선물 계좌 정보 삭제</button>
    </div> : showForm ? <DerivativesCredentialForm
      accountId={accountId}
      setAccountId={setAccountId}
      appKey={appKey}
      setAppKey={setAppKey}
      appSecret={appSecret}
      setAppSecret={setAppSecret}
      htsId={htsId}
      setHtsId={setHtsId}
      reuseCashCredentials={reuseCashCredentials}
      setReuseCashCredentials={setReuseCashCredentials}
      cashCredentialsAvailable={cashCredentialsAvailable}
      cashMaskedAccountId={cashSettings?.credentials.koreainvestment[environment].maskedAccountId ?? null}
      cashCredentialsCheckPending={!cashSettingsChecked}
      busy={busy}
      configured={status?.credentials.configured ?? false}
      submit={submit}
      cancel={() => { clearInputs(); setFeedback(null); setEditingCredentials(false); }}
    /> : null}
    {status?.credentials.configured ? <div className="credential-actions"><button className="secondary" type="button" disabled={busy} onClick={() => void verify()}><RefreshCw size={15} />실제 선물 계좌 다시 확인</button></div> : null}
    {feedback ? <div className={`credential-feedback ${feedback.kind}`} role="status">{feedback.kind === "success" ? <Check size={15} /> : feedback.kind === "waiting" ? <Clock3 size={15} /> : <AlertTriangle size={15} />}<span>{feedback.text}</span></div> : null}
    <div className="derivatives-safety-note"><ShieldCheck size={15} /><span>이곳에서 저장·삭제하는 것은 선물 계좌 정보뿐입니다. 현물 계좌와 현물 자동매매 설정은 바뀌지 않습니다.</span></div>
  </article>;
}

function DerivativesCredentialForm({
  accountId,
  setAccountId,
  appKey,
  setAppKey,
  appSecret,
  setAppSecret,
  htsId,
  setHtsId,
  reuseCashCredentials,
  setReuseCashCredentials,
  cashCredentialsAvailable,
  cashMaskedAccountId,
  cashCredentialsCheckPending,
  busy,
  configured,
  submit,
  cancel,
}: {
  accountId: string;
  setAccountId: (value: string) => void;
  appKey: string;
  setAppKey: (value: string) => void;
  appSecret: string;
  setAppSecret: (value: string) => void;
  htsId: string;
  setHtsId: (value: string) => void;
  reuseCashCredentials: boolean;
  setReuseCashCredentials: (value: boolean) => void;
  cashCredentialsAvailable: boolean;
  cashMaskedAccountId: string | null;
  cashCredentialsCheckPending: boolean;
  busy: boolean;
  configured: boolean;
  submit: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  cancel: () => void;
}) {
  return <form id="derivatives-credential-form" className="credential-form derivatives-credential-form" onSubmit={(event) => void submit(event)}>
    <label className="field derivatives-account-number-field"><span>여기에 선물·옵션 계좌번호 입력</span><input type="text" inputMode="numeric" value={accountId} onChange={(event) => setAccountId(event.target.value)} autoComplete="off" placeholder="선물계좌 앞 8자리 숫자" pattern="[0-9-]+" required /><em className="field-help">현물 계좌가 아니라 선물·옵션 주문에 사용할 계좌번호 앞 8자리를 직접 입력합니다.</em></label>
    <label className="field"><span>선물 계좌 상품번호</span><input type="text" value="03" readOnly aria-readonly="true" /><em className="field-help">한국투자증권 선물·옵션 계좌는 03으로 고정됩니다.</em></label>
    <div className="derivatives-account-binding-note"><AlertTriangle size={15} /><div><strong>앞 8자리가 다른 별도 계좌는 그 계좌에 발급된 API 키가 필요합니다.</strong><span>{cashMaskedAccountId ? `현재 현물 API 키의 계좌는 ${cashMaskedAccountId}입니다. ` : ""}한투 Open API 신청정보의 ‘추가신청하기’에서 선물계좌를 신청하고, 그 계좌에 표시된 키를 아래에 입력하세요. 계좌 비밀번호는 입력하지 않습니다.</span></div></div>
    <label className="derivatives-reuse-choice"><input type="checkbox" checked={reuseCashCredentials} disabled={cashCredentialsCheckPending || !cashCredentialsAvailable} onChange={(event) => setReuseCashCredentials(event.target.checked)} /><span><strong>현물계좌용 한투 API 키 재사용(선택)</strong><small>{cashCredentialsCheckPending ? "현물 API 저장 여부를 확인하고 있습니다." : cashCredentialsAvailable ? `현물 API 계좌 ${cashMaskedAccountId ?? "확인됨"}와 앞 8자리가 같거나, 이 선물계좌가 같은 API 신청에 등록된 경우에만 선택하세요.` : "현물 API 정보를 불러오지 못했거나 저장된 정보가 없습니다. 아래에 선물계좌용 API 정보를 입력해 주세요."}</small></span></label>
    {!reuseCashCredentials ? <details className="derivatives-separate-api" open>
      <summary>선물계좌에 발급된 API 키 입력</summary>
      <div className="derivatives-separate-api-grid">
        <label className="field"><span>API 키(App Key)</span><input type="password" value={appKey} onChange={(event) => setAppKey(event.target.value)} autoComplete="new-password" autoCapitalize="none" spellCheck={false} required /><em className="field-help">한투 Open API 신청정보에서 이 선물계좌에 표시되는 키입니다.</em></label>
        <label className="field"><span>API 비밀키(App Secret)</span><input type="password" value={appSecret} onChange={(event) => setAppSecret(event.target.value)} autoComplete="new-password" autoCapitalize="none" spellCheck={false} required /><em className="field-help">입력값은 화면에 다시 표시하지 않으며 보안 저장소에 저장합니다.</em></label>
      </div>
    </details> : null}
    <label className="field"><span>한국투자증권 로그인 ID</span><input type="text" value={htsId} onChange={(event) => setHtsId(event.target.value)} autoComplete="off" autoCapitalize="none" spellCheck={false} required /><em className="field-help">API 키를 재사용해도 반드시 필요합니다. 주문 접수·체결 알림을 실시간으로 받는 데 쓰며 계좌 비밀번호는 아닙니다.</em></label>
    <div className="credential-actions"><button className="connect-button" type="submit" disabled={busy || (reuseCashCredentials && !cashCredentialsAvailable)}><Link2 size={15} />{busy ? "확인 중…" : "선물 계좌 저장하고 확인"}</button>{configured ? <button className="secondary" type="button" disabled={busy} aria-expanded="true" aria-controls="derivatives-credential-form" onClick={cancel}>취소</button> : null}</div>
  </form>;
}

function DerivativeAccountStatus({ status }: { status: DerivativesCredentialResponse }) {
  const { credentials, connection, account } = status;
  const failed = connection.state === "FAILED";
  const verified = connection.state === "VERIFIED" && connection.authenticated && connection.accountSynchronized;
  const tone = verified ? "success" : failed ? "danger" : "waiting";
  const Icon = verified ? Check : failed ? AlertTriangle : Clock3;
  const storageName = credentials.source === "os-keychain"
    ? "운영체제 보안 저장소"
    : credentials.source === "encrypted-file"
      ? "서버 암호화 저장소"
      : credentials.source === "environment"
        ? "서버 환경설정"
        : "저장 전";

  return <>
    <dl className="derivatives-account-summary">
      <div><dt>선물 계좌번호</dt><dd>{credentials.maskedAccountId ?? "—"}</dd></div>
      <div><dt>상품번호</dt><dd>03 (선물·옵션)</dd></div>
      <div><dt>보관 위치</dt><dd>{storageName}</dd></div>
    </dl>
    {credentials.configured ? <section className={`credential-readiness ${tone}`} aria-label="선물 계좌 연결 상태">
      <div className="credential-readiness-summary"><Icon size={15} /><div><strong>{derivativesConnectionLabel(connection.state, connection.authenticated, connection.accountSynchronized)}</strong><span>{connection.message || "증권사에서 선물 계좌를 확인합니다."}</span></div></div>
      <div className="readiness-grid">
        <ReadinessItem label="선물 계좌 정보 저장" complete={credentials.configured} failed={false} pending="미저장" />
        <ReadinessItem label="API 로그인" complete={connection.authenticated} failed={failed && !connection.authenticated} pending={connection.state === "VERIFYING" ? "확인 중" : "확인 대기"} />
        <ReadinessItem label="선물 잔고·주문 확인" complete={connection.accountSynchronized} failed={failed && connection.authenticated} pending={connection.state === "VERIFYING" ? "확인 중" : "확인 대기"} />
        <ReadinessItem label="실제 자동운용" complete={false} failed={false} pending="현황 화면에서 별도 시작" />
      </div>
      {account ? <p className="derivatives-account-observation">실제 계좌 최근 조회: 보유 {account.positionCount}건 · 미체결 {account.openOrderCount}건 · {formatDateTime(account.observedAt)}</p> : connection.checkedAt ? <p className="derivatives-account-observation">마지막 확인 시도: {formatDateTime(connection.checkedAt)}</p> : null}
    </section> : null}
  </>;
}

function ReadinessItem({ label, complete, failed, pending }: {
  label: string;
  complete: boolean;
  failed: boolean;
  pending: string;
}) {
  return <div><span>{label}</span><b className={complete ? "complete" : failed ? "failed" : "pending"}>{complete ? "완료" : failed ? "확인 필요" : pending}</b></div>;
}

function readableCredentialError(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause);
  return /[가-힣]/.test(message) ? message : "선물 계좌를 저장하거나 확인하지 못했습니다. 입력값과 증권사 연결 상태를 확인해 주세요.";
}

function KiwoomUnavailableCard() {
  return <article className="settings-card derivatives-placeholder">
    <div><p className="settings-kicker">키움증권</p><h2>키움 선물 계좌는 현재 연결할 수 없음</h2><p className="derivatives-description">현재 키움이 공개한 새 방식의 공식 API에는 국내 선물·옵션 시세와 주문 기능이 없습니다. Windows에서만 동작하는 구형 방식은 쓰지 않기 때문에 가짜 계좌 입력칸이나 가짜 주문 기능을 만들지 않았습니다. 키움이 공식 기능을 추가하면 이 탭에 연결할 수 있는 구조입니다.</p><div className="derivatives-safety-note"><ShieldCheck size={15} /><span>키움 현물 계좌와 현물 자동매매는 이 안내 때문에 바뀌지 않습니다.</span></div></div>
    <strong className="trade-waiting"><AlertTriangle size={13} />현재 연결 불가</strong>
  </article>;
}

function SessionCard({ label, session }: { label: string; session: MarketVenueSession | null }) {
  return <article className={`derivatives-session-card ${session?.orderable ? "is-orderable" : ""}`}>
    <Clock3 size={17} />
    <div><span>{label}</span><strong>{session ? (session.orderable ? "거래소 거래 시간" : sessionStateLabel[session.state]) : "시간표 확인 중"}</strong><small>다음 상태 변경 {formatDateTime(session?.nextTransitionAt)}</small></div>
  </article>;
}
