"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Check, RefreshCw, Save, ShieldCheck } from "lucide-react";
import { getJson, koreanErrorMessage } from "@/lib/client-api";
import type {
  DerivativesAutomationSettings,
  DerivativesSettingsResponse,
} from "@/lib/api-types";

export function strategyModeFor(
  hedgeEnabled: boolean,
  directionalEnabled: boolean,
): DerivativesAutomationSettings["mode"] {
  if (hedgeEnabled && directionalEnabled) return "HEDGE_AND_DIRECTIONAL";
  if (directionalEnabled) return "DIRECTIONAL";
  return "HEDGE";
}

export function withStrategyEnabled(
  settings: DerivativesAutomationSettings,
  strategy: "hedge" | "directional",
  enabled: boolean,
): DerivativesAutomationSettings {
  const hedgeEnabled = strategy === "hedge" ? enabled : settings.hedge.enabled;
  const directionalEnabled = strategy === "directional" ? enabled : settings.directional.enabled;
  return {
    ...settings,
    mode: strategyModeFor(hedgeEnabled, directionalEnabled),
    hedge: { ...settings.hedge, enabled: hedgeEnabled },
    directional: { ...settings.directional, enabled: directionalEnabled },
  };
}

export function DerivativesAutomationSettingsCard() {
  const [payload, setPayload] = useState<DerivativesSettingsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const result = await getJson<DerivativesSettingsResponse>("/api/engine/derivatives/settings");
      setPayload(result);
      setError(null);
    } catch (cause) {
      setError(koreanErrorMessage(cause, "선물·옵션 운용 설정을 불러오지 못했습니다."));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function update(updater: (current: DerivativesAutomationSettings) => DerivativesAutomationSettings): void {
    setPayload((current) => current
      ? { ...current, settings: updater(current.settings) }
      : current);
    setMessage(null);
  }

  async function save(): Promise<void> {
    if (!payload) return;
    if (
      payload.settings.autoTradingEnabled &&
      !payload.settings.hedge.enabled &&
      !payload.settings.directional.enabled
    ) {
      setError("자동운용 중에는 두 매매 방식을 모두 끌 수 없습니다. 선물·옵션 현황에서 자동운용을 먼저 멈춰 주세요.");
      return;
    }
    if (payload.settings.directional.slowPeriod <= payload.settings.directional.fastPeriod) {
      setError("긴 흐름을 보는 기간은 짧은 흐름을 보는 기간보다 길어야 합니다.");
      return;
    }
    setSaving(true);
    setMessage(null);
    setError(null);
    try {
      const result = await getJson<DerivativesSettingsResponse>("/api/engine/derivatives/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload.settings),
      });
      setPayload(result);
      setMessage("운용 설정을 저장했습니다. 저장만으로 실제 주문은 시작되지 않습니다.");
    } catch (cause) {
      setError(koreanErrorMessage(cause, "운용 설정을 저장하지 못했습니다. 입력값을 확인해 주세요."));
    } finally {
      setSaving(false);
    }
  }

  if (loading && !payload) {
    return <section className="settings-card derivatives-automation-card">
      <div className="empty"><strong>선물·옵션 운용 설정을 불러오는 중</strong><span>주문은 시작하지 않습니다.</span></div>
    </section>;
  }

  if (!payload) {
    return <section className="settings-card derivatives-automation-card">
      <div className="derivatives-automation-heading">
        <div><p className="settings-kicker">자동운용 방식</p><h2>설정을 불러오지 못했습니다</h2></div>
        <button type="button" className="secondary" onClick={() => void load()}><RefreshCw size={15} />다시 불러오기</button>
      </div>
      {error ? <div className="credential-feedback danger" role="alert"><AlertTriangle size={15} /><span>{error}</span></div> : null}
    </section>;
  }

  const settings = payload.settings;
  const runtime = payload.runtime;
  const armed = runtime.safety.armed;

  return <section className="settings-card derivatives-automation-card">
    <div className="derivatives-automation-heading">
      <div>
        <p className="settings-kicker">자동운용 방식</p>
        <h2>선물·옵션을 어떻게 운용할지 설정</h2>
        <p>현물 손실을 줄이는 숏 헤지와, 흐름에 따라 롱·숏을 바꾸는 매매를 따로 또는 함께 쓸 수 있습니다.</p>
      </div>
      <div className="derivatives-automation-actions">
        <span className={armed ? "is-armed" : "is-stopped"}>{armed ? "실제 자동운용 중" : "실제 주문 정지"}</span>
        <button type="button" className="save-button" disabled={saving} onClick={() => void save()}><Save size={15} />{saving ? "저장 중…" : "운용 설정 저장"}</button>
      </div>
    </div>

    <div className="derivatives-start-separation">
      <ShieldCheck size={17} />
      <div><strong>설정 저장과 실제 주문 시작은 서로 다릅니다</strong><p>여기서 저장해도 주문이 나가지 않습니다. 실제 운용은 <Link href="/derivatives">선물·옵션 자동매매 현황</Link>에서 ‘자동운용 시작’을 눌러야 시작됩니다.</p></div>
    </div>
    <p className="derivatives-daily-note"><strong>자동운용 설정은 매일 다시 누를 필요가 없습니다.</strong> 재시작 뒤 이어가기를 켜면 서버가 다시 켜져도 계좌·시세·주문 상태를 먼저 확인한 다음 마지막 운용 상태를 이어갑니다.</p>

    {error ? <div className="credential-feedback danger" role="alert"><AlertTriangle size={15} /><span>{error}</span></div> : null}
    {message ? <div className="credential-feedback success" role="status"><Check size={15} /><span>{message}</span></div> : null}
    {armed ? <div className="credential-feedback waiting" role="status"><AlertTriangle size={15} /><span>현재 실제 자동운용 중입니다. 저장한 값은 다음 조건 확인부터 적용될 수 있습니다. 큰 변경 전에는 현황 화면에서 자동운용을 먼저 멈추는 것이 안전합니다.</span></div> : null}

    <div className="derivatives-settings-section">
      <div className="derivatives-settings-section-title"><h3>기본 운용</h3><p>계좌 종류와 거래할 시간, 주문 방식을 정합니다.</p></div>
      <div className="derivatives-settings-switches">
        <SimpleToggle
          checked={settings.connectionEnabled}
          label="증권사 연결 유지"
          help="주문을 꺼둔 동안에도 잔고와 시세를 확인합니다."
          onChange={(checked) => update((current) => ({ ...current, connectionEnabled: checked }))}
        />
        <SimpleToggle
          checked={settings.resumeAfterRestart}
          label="서버 재시작 뒤 운용 이어가기"
          help="마지막에 자동운용 중이었을 때만 안전 확인 후 다시 이어갑니다."
          onChange={(checked) => update((current) => ({ ...current, resumeAfterRestart: checked }))}
        />
        <SimpleToggle
          checked={settings.allowNightSession}
          label="야간 거래시간에도 주문 허용"
          help="거래소 야간장이 열리고 모든 안전 조건이 맞을 때만 주문합니다."
          onChange={(checked) => update((current) => ({ ...current, allowNightSession: checked }))}
        />
      </div>
      <div className="form-grid three derivatives-basic-fields">
        <label className="field"><span>사용할 계좌</span><select value={settings.environment} onChange={(event) => update((current) => ({ ...current, environment: event.target.value as "live" | "paper" }))}><option value="live">실전투자 계좌</option><option value="paper">모의투자 계좌</option></select><em className="field-help">계좌를 바꾸면 새 계좌의 잔고와 주문을 다시 확인합니다.</em></label>
        <label className="field"><span>주문 가격 방식</span><select value={settings.orderType} onChange={(event) => update((current) => ({ ...current, orderType: event.target.value as "MARKET" | "LIMIT" }))}><option value="MARKET">시장가(가격보다 체결 우선)</option><option value="LIMIT">지정가(정한 가격까지만)</option></select><em className="field-help">시장가는 급변할 때 예상보다 불리한 가격에 체결될 수 있습니다.</em></label>
        <NumberField label="미체결 주문 취소 대기시간" value={settings.unfilledTimeoutSeconds} min={10} max={3600} step={10} suffix="초" help="이 시간이 지나도 체결되지 않은 엔진 주문은 실제 증권사 상태를 확인한 뒤 취소합니다." onChange={(value) => update((current) => ({ ...current, unfilledTimeoutSeconds: value }))} />
        {settings.orderType === "LIMIT" ? <NumberField label="현재 가격에서 조정할 호가 수" value={settings.limitOffsetTicks} min={-20} max={20} step={1} suffix="칸" help="0은 현재 호가, 양수·음수는 주문 방향에 맞춰 가격을 조정합니다." onChange={(value) => update((current) => ({ ...current, limitOffsetTicks: value }))} /> : null}
      </div>
    </div>

    <div className="derivatives-settings-section">
      <div className="derivatives-settings-section-title"><h3>무엇을 거래할지</h3><p>기본은 만기가 가까운 미니 코스피200 선물을 자동으로 선택합니다.</p></div>
      <div className="form-grid three">
        <label className="field"><span>거래할 선물</span><select value={settings.contractSelection} onChange={(event) => update((current) => ({ ...current, contractSelection: event.target.value as "AUTO_MINI_KOSPI200" | "MANUAL" }))}><option value="AUTO_MINI_KOSPI200">미니 코스피200 최근월물 자동 선택</option><option value="MANUAL">종목코드 직접 입력</option></select><em className="field-help">자동 선택은 만기와 거래 가능 상태를 확인해 현재 종목을 고릅니다.</em></label>
        {settings.contractSelection === "MANUAL" ? <label className="field"><span>선물 종목코드</span><input value={settings.manualContractCode} maxLength={16} autoCapitalize="characters" spellCheck={false} onChange={(event) => update((current) => ({ ...current, manualContractCode: event.target.value.trim().toUpperCase() }))} placeholder="예: 선물 종목코드" /><em className="field-help">한투 API에서 사용하는 6~16자리 실제 종목코드를 입력합니다.</em></label> : null}
      </div>
    </div>

    <div className="derivatives-strategy-grid">
      <article className={`derivatives-strategy-card ${settings.hedge.enabled ? "enabled" : ""}`}>
        <div className="derivatives-strategy-head"><div><h3>현물 손실 방어(숏 헤지)</h3><p>프로그램이 읽은 현물 평가금액에 맞춰 코스피200 선물을 숏으로 보유해 급락 충격을 줄입니다.</p></div><SimpleToggle checked={settings.hedge.enabled} label={settings.hedge.enabled ? "사용 중" : "사용 안 함"} onChange={(checked) => update((current) => withStrategyEnabled(current, "hedge", checked))} /></div>
        <div className="form-grid two">
          <NumberField label="현물 금액 중 방어할 비율" value={settings.hedge.hedgeRatioBps / 100} min={0.01} max={100} step={1} suffix="%" help="100%면 읽어 온 현물 평가금액 전체를 기준으로 숏 수량을 계산합니다." onChange={(value) => update((current) => ({ ...current, hedge: { ...current.hedge, hedgeRatioBps: Math.round(value * 100) } }))} />
          <NumberField label="수량을 바꾸는 최소 차이" value={settings.hedge.minRebalanceContracts} min={1} max={20} step={1} suffix="계약" help="계산값과 현재 헤지 수량 차이가 이보다 작으면 잦은 주문을 피합니다." onChange={(value) => update((current) => ({ ...current, hedge: { ...current.hedge, minRebalanceContracts: value } }))} />
        </div>
      </article>

      <article className={`derivatives-strategy-card ${settings.directional.enabled ? "enabled" : ""}`}>
        <div className="derivatives-strategy-head"><div><h3>상승·하락 흐름 매매</h3><p>짧은 평균이 긴 평균보다 높으면 롱, 낮으면 숏을 잡습니다. 같은 선물의 롱·숏은 계좌에서 순수량으로 합쳐집니다.</p></div><SimpleToggle checked={settings.directional.enabled} label={settings.directional.enabled ? "사용 중" : "사용 안 함"} onChange={(checked) => update((current) => withStrategyEnabled(current, "directional", checked))} /></div>
        <div className="form-grid two">
          <label className="field"><span>허용할 방향</span><select value={settings.directional.sideMode} onChange={(event) => update((current) => ({ ...current, directional: { ...current.directional, sideMode: event.target.value as "BOTH" | "LONG_ONLY" | "SHORT_ONLY" } }))}><option value="BOTH">상승 롱 + 하락 숏 모두</option><option value="LONG_ONLY">상승 롱만</option><option value="SHORT_ONLY">하락 숏만</option></select><em className="field-help">‘모두’는 신호에 따라 방향을 바꾼다는 뜻이며 같은 종목을 양쪽에 따로 쌓지는 않습니다.</em></label>
          <NumberField label="한 번에 목표로 할 수량" value={settings.directional.targetContracts} min={1} max={100} step={1} suffix="계약" help="추세 신호가 났을 때 목표로 맞출 계약 수입니다." onChange={(value) => update((current) => ({ ...current, directional: { ...current.directional, targetContracts: value } }))} />
          <NumberField label="짧은 흐름을 보는 기간" value={settings.directional.fastPeriod} min={2} max={60} step={1} suffix="일" help="최근 가격 변화에 빠르게 반응하는 이동평균 기간입니다." onChange={(value) => update((current) => ({ ...current, directional: { ...current.directional, fastPeriod: value } }))} />
          <NumberField label="긴 흐름을 보는 기간" value={settings.directional.slowPeriod} min={3} max={120} step={1} suffix="일" help="짧은 기간보다 길게 설정해야 합니다." onChange={(value) => update((current) => ({ ...current, directional: { ...current.directional, slowPeriod: value } }))} />
          <NumberField label="신호로 인정할 최소 차이" value={settings.directional.minimumGapBps / 100} min={0} max={20} step={0.01} suffix="%" help="두 평균의 차이가 이 값보다 작으면 애매한 흐름으로 보고 주문하지 않습니다." onChange={(value) => update((current) => ({ ...current, directional: { ...current.directional, minimumGapBps: Math.round(value * 100) } }))} />
        </div>
      </article>
    </div>

    <div className="derivatives-settings-section derivatives-risk-section">
      <div className="derivatives-settings-section-title"><h3>손실·수량 안전 한도</h3><p>전략 신호가 나도 아래 한도를 넘는 주문은 보내지 않습니다.</p></div>
      <div className="form-grid three">
        <NumberField label="전체 최대 보유 수량" value={settings.maxContracts} min={1} max={100} step={1} suffix="계약" help="헤지와 흐름 매매를 합친 실제 계좌의 최대 계약 수입니다." onChange={(value) => update((current) => ({ ...current, maxContracts: value }))} />
        <NumberField label="하루 최대 손실 한도" value={settings.maxDailyLossKrw} min={10000} max={1000000000} step={10000} suffix="원" help="확인된 당일 손익이 이 손실 금액에 닿으면 새 포지션을 막습니다." onChange={(value) => update((current) => ({ ...current, maxDailyLossKrw: value }))} />
        <NumberField label="예수금 중 증거금 최대 비율" value={settings.maxMarginUsageBps / 100} min={1} max={100} step={1} suffix="%" help="선물 보유에 묶이는 증거금이 예수금의 이 비율을 넘지 않게 제한합니다." onChange={(value) => update((current) => ({ ...current, maxMarginUsageBps: Math.round(value * 100) }))} />
      </div>
    </div>
  </section>;
}

function SimpleToggle({ checked, label, help, onChange }: {
  checked: boolean;
  label: string;
  help?: string;
  onChange: (checked: boolean) => void;
}) {
  return <label className={`derivatives-simple-toggle ${help ? "with-copy" : ""}`}>
    <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
    <span aria-hidden="true" />
    <b>{label}</b>
    {help ? <em>{help}</em> : null}
  </label>;
}

function NumberField({ label, value, min, max, step, suffix, help, onChange }: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  suffix: string;
  help: string;
  onChange: (value: number) => void;
}) {
  return <label className="field"><span>{label}</span><div><input type="number" value={value} min={min} max={max} step={step} onChange={(event) => { const next = Number(event.target.value); if (Number.isFinite(next)) onChange(next); }} /><small>{suffix}</small></div><em className="field-help">{help}</em></label>;
}
