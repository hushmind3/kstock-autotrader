"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertCircle, RefreshCw } from "lucide-react";
import { formatDateTime, formatNumber, formatWon, getJson } from "../lib/client-api";
import type { DashboardResponse, ExecutionRow } from "../lib/api-types";
import {
  executionMarketLabel,
  filterExecutions,
  summarizeExecutionTrades,
  summarizeExecutions,
  type ExecutionTradeLeg,
  type ExecutionTradePair,
  type ExecutionSideFilter,
} from "../lib/execution-records";
import { tradeReasonSummary } from "../lib/trade-reasons";
import {
  formatOrderStatus,
  insufficientDailyBars,
  presentError,
} from "../lib/error-presentation";

const brokerLabel = {
  kiwoom: "키움증권",
  koreainvestment: "한국투자증권",
} as const;

export function RecordsClient({ type }: { type: "orders" | "positions" | "errors" }) {
  const [data, setData] = useState<DashboardResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
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
    if (type !== "orders") return;
    const timer = window.setInterval(() => void load(), 5_000);
    return () => window.clearInterval(timer);
  }, [load, type]);

  const title = type === "orders" ? "주문·체결" : type === "positions" ? "보유종목" : "시스템 기록";
  const eyebrow = type === "orders" ? "거래 내역" : type === "positions" ? "보유 현황" : "오류와 안내";
  const subtitle = type === "errors"
    ? "실제 주문 오류뿐 아니라 연결 재시도와 시세 자료 안내도 함께 표시합니다."
    : type === "orders"
      ? "실제 체결, 주문 처리 상태, 조건검색 후보를 서로 구분해 표시합니다."
      : "키움증권과 한국투자증권 기록을 한곳에 표시합니다.";

  return <main className="shell">
    <header className="page-header">
      <div>
        <p className="eyebrow">{eyebrow}</p>
        <h1>{title}</h1>
        <p className="subtitle">{subtitle}</p>
      </div>
      <button className="icon-button" onClick={() => void load()} aria-label="새로고침">
        <RefreshCw size={16} />
      </button>
    </header>

    {error ? <div className="notice danger">
      <AlertCircle size={17} />
      <div>
        <strong>데이터를 불러오지 못했습니다</strong>
        <p>트레이딩 엔진 연결 상태를 확인한 뒤 다시 시도해 주세요.</p>
        <details><summary>기술 정보</summary><p>{error}</p></details>
      </div>
    </div> : null}

    {type === "orders" ? <div className="notice execution-guide">
      <AlertCircle size={17} />
      <div>
        <strong>매수 시각과 매도 시각은 첫 번째 ‘매수·매도 한눈에 보기’에서 함께 확인하세요</strong>
        <p>같은 계좌·종목의 실제 체결만 시간순으로 연결합니다. 주문에는 미체결·취소가 포함될 수 있고, 조건검색 후보는 주문이나 체결이 아닙니다.</p>
      </div>
    </div> : null}

    {type === "errors" ? <div className="notice warning">
      <AlertCircle size={17} />
      <div>
        <strong>‘자료 부족’은 주문 실패가 아닙니다</strong>
        <p>이동평균선을 계산할 과거 거래일이 부족한 신규 종목은 자동으로 건너뛰며, 자료가 쌓이면 다시 검사합니다.</p>
      </div>
    </div> : null}

    {type === "orders" ? <>
      <ExecutionTrades data={data} />
      <ExecutionAudit data={data} />
      <section className="table-card records-card order-history-card">
        <div className="section-head">
          <div>
            <p>증권사 주문 처리 기록</p>
            <h2>오늘 주문 내역</h2>
            <span className="section-description">미체결, 부분체결, 취소, 거절 주문도 모두 포함합니다.</span>
          </div>
          <span>{formatNumber(data?.orders.length)}건</span>
        </div>
        <Orders data={data} />
      </section>
      <section className="table-card records-card candidate-history-card">
        <div className="section-head">
          <div>
            <p>조건 검사 결과 · 실제 거래 아님</p>
            <h2>현재 매수·매도 후보</h2>
            <span className="section-description">자동매매 시작 여부와 관계없이 생성되는 검사 결과입니다.</span>
          </div>
          <span>{formatNumber(data?.candidates.length)}종목</span>
        </div>
        <Candidates data={data} />
      </section>
    </> : <section className="table-card records-card">
      {type === "positions" ? <Positions data={data} /> : <Errors data={data} />}
    </section>}
  </main>;
}

function ExecutionTrades({ data }: { data: DashboardResponse | null }) {
  const executions = data?.recentExecutions ?? data?.executions ?? [];
  const pairs: ExecutionTradePair[] = data?.executionTrades ?? [];
  const coverage = data?.executionTradeCoverage;
  const summary = summarizeExecutionTrades(pairs);

  return <section className="table-card records-card execution-trades-card">
    <div className="section-head execution-section-head">
      <div>
        <p>저장된 실제 체결 · 시간순 연결</p>
        <h2>매수·매도 한눈에 보기</h2>
        <span className="section-description">같은 증권사·계좌·종목에서 먼저 산 수량부터 실제 매도 수량만큼 연결합니다. 분할 체결과 부분매도는 수량별로 나눠 표시합니다.</span>
      </div>
      <strong className="execution-count">{data ? `표시 ${formatNumber(pairs.length)}묶음` : "불러오는 중"}</strong>
    </div>

    {data && executions.length > 0 ? <div className="trade-match-summary" aria-label="매수 매도 연결 요약">
      <article className="matched">
        <span>매수 → 매도 완료</span>
        <strong>{formatNumber(summary.matchedQuantity)}주</strong>
        <small>{formatNumber(summary.matchedLotCount)}개 연결</small>
      </article>
      <article className="open-buy">
        <span>아직 매도 없음</span>
        <strong>{formatNumber(summary.openBuyQuantity)}주</strong>
        <small>{formatNumber(summary.openBuyLotCount)}개 매수 잔량</small>
      </article>
      <article className="unmatched-sell">
        <span>선행 매수 미확인</span>
        <strong>{formatNumber(summary.unmatchedSellQuantity)}주</strong>
        <small>{formatNumber(summary.unmatchedSellLotCount)}개 매도 잔량</small>
      </article>
    </div> : null}

    {coverage && coverage.unavailableAccountCount > 0 ? <p className="trade-pair-coverage-warning">
      저장 기록이 매우 많은 {formatNumber(coverage.unavailableAccountCount)}개 계좌는 오래된 매수를 잘못 붙이지 않도록 묶음 표시에서 제외했습니다. 최근 개별 체결은 아래 원본 기록에서 확인할 수 있습니다.
    </p> : null}

    {!data ? <Empty label="실제 매매 연결을 불러오는 중입니다" />
      : pairs.length === 0 ? <Empty label={executions.length > 0 && coverage?.unavailableAccountCount
        ? "안전하게 연결할 수 있는 매수·매도 묶음이 없습니다"
        : "연결할 실제 체결이 없습니다"} />
      : <ExecutionTradeCards pairs={pairs} />}

    <p className="trade-pair-disclaimer">
      엔진이 실제 계좌번호별 DB 체결 흐름을 시간순으로 확인한 뒤 시각과 수량만 연결합니다. 오래된 기록이 잘려 정확히 연결할 수 없는 계좌는 추정하지 않고 제외하며, 공식 개별 실현손익이 없어 손익도 계산하지 않습니다.
      {coverage && coverage.returnedPairCount < coverage.totalPairCount
        ? ` 화면에는 최신 ${formatNumber(coverage.returnedPairCount)}묶음만 표시합니다.`
        : ""}
    </p>
  </section>;
}

export function ExecutionTradeCards({ pairs }: { pairs: ExecutionTradePair[] }) {
  return <div className="trade-pair-list">
    {pairs.map((pair) => <article key={pair.id} className={`trade-pair-card ${pair.status}`}>
      <header>
        <div>
          <h3>{pair.name || pair.symbol}</h3>
          <small>
            {pair.symbol} · {brokerLabel[pair.brokerId]} · {pair.environment === "live" ? "실전" : "모의"} {pair.accountIdMasked}
          </small>
        </div>
        <span className={`trade-pair-status ${pair.status}`}>{tradePairStatusLabel(pair)}</span>
      </header>
      <div className="trade-pair-flow">
        <ExecutionTradeLegCard side="buy" leg={pair.buy} />
        <div className="trade-pair-quantity" aria-label={`연결 수량 ${formatNumber(pair.quantity)}주`}>
          <span>{pair.status === "matched" ? "서로 연결된 수량" : pair.status === "open-buy" ? "남은 매수 수량" : "미연결 매도 수량"}</span>
          <strong>{formatNumber(pair.quantity)}주</strong>
        </div>
        <ExecutionTradeLegCard side="sell" leg={pair.sell} />
      </div>
      <p>{tradePairExplanation(pair)}</p>
    </article>)}
  </div>;
}

function ExecutionTradeLegCard({
  side,
  leg,
}: {
  side: "buy" | "sell";
  leg: ExecutionTradeLeg | null;
}) {
  if (!leg) return <div className={`trade-pair-leg ${side} missing`}>
    <span className={`side ${side}`}>{side === "buy" ? "매수" : "매도"}</span>
    <strong>{side === "buy" ? "조회 범위 내 매수 없음" : "아직 매도 체결 없음"}</strong>
    <small>{side === "buy" ? "이전 체결을 임의로 붙이지 않았습니다." : "실제 매도 체결을 기다리는 수량입니다."}</small>
  </div>;

  const execution = leg.execution;
  const isSplit = leg.quantity !== execution.quantity;
  return <div className={`trade-pair-leg ${side}`}>
    <span className={`side ${side}`}>{side === "buy" ? "매수" : "매도"}</span>
    <time dateTime={execution.executedAt}>{formatDateTime(execution.executedAt)}</time>
    <strong>{formatWon(execution.price)} · {formatNumber(leg.quantity)}주</strong>
    <small>{isSplit ? `전체 체결 ${formatNumber(execution.quantity)}주 중 연결된 수량` : `체결 식별값 ${execution.brokerExecutionId}`}</small>
  </div>;
}

function tradePairStatusLabel(pair: ExecutionTradePair): string {
  if (pair.status === "matched") return "매수·매도 연결";
  if (pair.status === "open-buy") return "매수만 체결";
  return "선행 매수 미확인";
}

function tradePairExplanation(pair: ExecutionTradePair): string {
  if (pair.status === "matched") return "실제 체결시각 순서대로 먼저 산 수량부터 연결했습니다. 실현손익은 임의 계산하지 않습니다.";
  if (pair.status === "open-buy") return "현재 표시된 실제 체결 중에는 이 수량을 판 매도 체결이 없습니다.";
  return "현재 표시 범위보다 앞선 매수가 있을 수 있어, 확인되지 않은 매수 체결을 만들어 연결하지 않았습니다.";
}

function ExecutionAudit({ data }: { data: DashboardResponse | null }) {
  const [filter, setFilter] = useState<ExecutionSideFilter>("all");
  const allRows = data?.recentExecutions ?? data?.executions ?? [];
  const rows = filterExecutions(allRows, filter);
  const summary = summarizeExecutions(allRows);

  return <section className="table-card records-card execution-history-card execution-audit-card">
    <div className="section-head execution-section-head">
      <div>
        <p>최근 원본 기록 · 증권사에서 수신·저장</p>
        <h2>실제 체결 원본 기록</h2>
        <span className="section-description">최근 조회 범위의 개별 체결과 주문번호·체결 식별값을 그대로 표시합니다.</span>
      </div>
      <strong className="execution-count">최근 {formatNumber(data ? summary.totalCount : null)}건</strong>
    </div>

    {data && allRows.length > 0 ? <div className="execution-summary" aria-label="최근 체결 요약">
      <article>
        <span>최근 체결</span>
        <strong>{formatNumber(summary.totalCount)}건</strong>
        <small>매수와 매도 합계</small>
      </article>
      <article className="buy">
        <span>실제 매수</span>
        <strong>{formatNumber(summary.buyCount)}건</strong>
        <small>{formatWon(summary.buyAmount)}</small>
      </article>
      <article className="sell">
        <span>실제 매도</span>
        <strong>{formatNumber(summary.sellCount)}건</strong>
        <small>{formatWon(summary.sellAmount)}</small>
      </article>
      <article>
        <span>저장된 거래 비용</span>
        <strong>{formatWon(summary.fee + summary.tax)}</strong>
        <small>수수료 {formatWon(summary.fee)} · 세금 {formatWon(summary.tax)}</small>
      </article>
    </div> : null}

    <div className="execution-toolbar">
      <div className="filter-tabs execution-filters" role="group" aria-label="체결 구분 필터">
        <ExecutionFilterButton filter="all" selected={filter} count={summary.totalCount} onSelect={setFilter}>전체</ExecutionFilterButton>
        <ExecutionFilterButton filter="buy" selected={filter} count={summary.buyCount} onSelect={setFilter}>매수</ExecutionFilterButton>
        <ExecutionFilterButton filter="sell" selected={filter} count={summary.sellCount} onSelect={setFilter}>매도</ExecutionFilterButton>
      </div>
      {data && allRows.length > 0 ? <span>{rows.length === allRows.length ? `최근 ${formatNumber(rows.length)}건 표시` : `최근 ${filter === "buy" ? "매수" : "매도"} ${formatNumber(rows.length)}건 표시`}</span> : null}
    </div>

    {!data ? <Empty label="실제 체결 원본 기록을 불러오는 중입니다" />
      : rows.length === 0 ? <Empty label={allRows.length === 0 ? "저장된 실제 체결이 없습니다" : `최근 ${filter === "buy" ? "매수" : "매도"} 체결이 없습니다`} />
      : <ExecutionTable rows={rows} />}

    <p className="execution-disclaimer">
      체결금액은 저장된 체결수량 × 실제 체결가입니다. 수수료·세금은 DB 저장값이며, 증권사 응답에 비용 항목이 없으면 0원일 수 있습니다. 개별 매도 실현손익은 공식 저장값이 없어 임의 계산하지 않고 ‘—’로 표시합니다.
    </p>
  </section>;
}

function ExecutionFilterButton({
  children,
  count,
  filter,
  selected,
  onSelect,
}: {
  children: string;
  count: number;
  filter: ExecutionSideFilter;
  selected: ExecutionSideFilter;
  onSelect: (filter: ExecutionSideFilter) => void;
}) {
  const active = filter === selected;
  return <button
    type="button"
    className={active ? "selected" : ""}
    aria-pressed={active}
    onClick={() => onSelect(filter)}
  >
    {children} <span>{formatNumber(count)}</span>
  </button>;
}

export function ExecutionTable({ rows }: { rows: ExecutionRow[] }) {
  return <div className="table-wrap execution-table">
    <table>
      <thead>
        <tr>
          <th>체결시각</th>
          <th>증권사·계좌</th>
          <th>종목</th>
          <th>매수·매도</th>
          <th>체결수량</th>
          <th>실제 체결가</th>
          <th>체결금액</th>
          <th>수수료</th>
          <th>세금</th>
          <th>매도 실현손익</th>
          <th>주문시장</th>
        </tr>
      </thead>
      <tbody>{rows.map((row) => <tr key={row.id} className={`execution-row ${row.side}`}>
        <td data-label="체결시각">
          <strong>{formatDateTime(row.executedAt)}</strong>
          <small>주문번호 {row.brokerOrderId}</small>
          <small>체결 식별값 {row.brokerExecutionId}</small>
        </td>
        <td data-label="증권사·계좌">
          <strong>{brokerLabel[row.brokerId]}</strong>
          <small>{row.environment === "live" ? "실전" : "모의"} · {row.accountIdMasked}</small>
        </td>
        <td data-label="종목">
          <strong>{row.name || row.symbol}</strong>
          <small>{row.symbol}</small>
        </td>
        <td data-label="매수·매도"><span className={`side ${row.side}`}>{row.side === "buy" ? "매수" : "매도"}</span></td>
        <td data-label="체결수량"><strong>{formatNumber(row.quantity)}주</strong></td>
        <td data-label="실제 체결가"><strong>{formatWon(row.price)}</strong></td>
        <td data-label="체결금액"><strong>{formatWon(row.grossAmount)}</strong></td>
        <td data-label="수수료">{formatWon(row.fee)}</td>
        <td data-label="세금">{formatWon(row.tax)}</td>
        <td data-label="매도 실현손익" className={row.realizedPnl !== null ? (row.realizedPnl > 0 ? "positive" : row.realizedPnl < 0 ? "negative" : "") : "unavailable-value"}>
          {row.side === "sell" && row.realizedPnl !== null ? formatWon(row.realizedPnl, true) : "—"}
        </td>
        <td data-label="주문시장">{executionMarketLabel(row.exchange)}</td>
      </tr>)}</tbody>
    </table>
  </div>;
}

function Candidates({ data }: { data: DashboardResponse | null }) {
  if (!data) return <Empty label="조건 검사 결과를 불러오는 중입니다" />;
  const rows = data.candidates;
  return rows.length === 0
    ? <Empty label={data.market.scanMode === "WAITING_FOR_DATA" ? "조건 검사를 준비하고 있습니다" : "조건을 통과한 종목이 없습니다"} />
    : <div className="table-wrap"><table><thead><tr><th>기준 시각</th><th>증권사</th><th>종목</th><th>판정</th><th>기준 가격</th><th>가격 기준</th></tr></thead><tbody>{rows.map((row) => <tr key={row.id}><td>{formatDateTime(row.generatedAt)}</td><td>{brokerLabel[row.brokerId]}</td><td><strong>{row.name || row.symbol}</strong><small>{row.symbol}</small></td><td><span className={`side ${row.action.toLowerCase()}`}>{row.action === "BUY" ? "매수 후보" : row.action === "SELL" ? "매도 후보" : "조건 감지"}</span>{tradeReasonSummary(row.reasonCodes) ? <small>{tradeReasonSummary(row.reasonCodes)}</small> : null}</td><td>{formatWon(row.price)}</td><td>{row.source === "LIVE" ? "실시간 가격" : "마지막 저장 가격"}</td></tr>)}</tbody></table></div>;
}

function Orders({ data }: { data: DashboardResponse | null }) {
  if (!data) return <Empty label="주문 내역을 불러오는 중입니다" />;
  const rows = data.orders;
  return rows.length === 0
    ? <Empty label="오늘 저장된 주문이 없습니다" />
    : <div className="table-wrap"><table><thead><tr><th>주문시각</th><th>증권사</th><th>주문시장</th><th>종목</th><th>구분</th><th>주문수량</th><th>체결수량</th><th>주문가격</th><th>처리상태</th></tr></thead><tbody>{rows.map((row) => <tr key={row.id}><td>{formatDateTime(row.orderedAt)}</td><td><strong>{brokerLabel[row.brokerId]}</strong><small>{row.environment === "live" ? "실전" : "모의"}</small></td><td>{executionMarketLabel(row.exchange ?? null)}</td><td><strong>{row.name || row.symbol}</strong><small>{row.symbol}</small></td><td><span className={`side ${row.side}`}>{row.side === "buy" ? "매수" : "매도"}</span></td><td>{formatNumber(row.quantity)}주</td><td>{formatNumber(row.filledQuantity)}주</td><td>{row.orderType === "market" ? "시장가" : formatWon(row.limitPrice)}</td><td>{formatOrderStatus(row.status)}</td></tr>)}</tbody></table></div>;
}

function Positions({ data }: { data: DashboardResponse | null }) {
  if (!data) return <Empty label="보유종목을 불러오는 중입니다" />;
  const rows = data.positions;
  return rows.length === 0
    ? <Empty label="동기화된 실제 보유종목이 없습니다" />
    : <div className="table-wrap"><table><thead><tr><th>증권사</th><th>종목</th><th>보유 수량</th><th>평균 매수가</th><th>현재가</th><th>수익률</th><th>평가손익</th></tr></thead><tbody>{rows.map((row) => <tr key={`${row.brokerId}-${row.symbol}`}><td>{brokerLabel[row.brokerId]}</td><td><strong>{row.name || row.symbol}</strong><small>{row.symbol}</small></td><td>{formatNumber(row.quantity)}</td><td>{formatWon(row.averagePrice)}</td><td>{formatWon(row.currentPrice)}</td><td className={row.unrealizedPnlBps > 0 ? "positive" : row.unrealizedPnlBps < 0 ? "negative" : ""}>{(row.unrealizedPnlBps / 100).toFixed(2)}%</td><td className={row.unrealizedPnl > 0 ? "positive" : row.unrealizedPnl < 0 ? "negative" : ""}>{formatWon(row.unrealizedPnl, true)}</td></tr>)}</tbody></table></div>;
}

function Errors({ data }: { data: DashboardResponse | null }) {
  if (!data) return <Empty label="시스템 기록을 불러오는 중입니다" />;
  const rows = data.errors;
  if (rows.length === 0) return <Empty label="문제나 안내 기록이 없습니다" />;
  const insufficient = rows.flatMap((row) => {
    const detail = insufficientDailyBars(row);
    return detail ? [{ row, detail }] : [];
  });
  const remaining = rows.filter((row) => insufficientDailyBars(row) === null);
  const requiredDays = [...new Set(insufficient.map(({ detail }) => detail.required))].sort((a, b) => a - b);
  return <div className="error-list">
    {insufficient.length > 0 ? <article>
      <span className="severity info">자료 부족</span>
      <div>
        <strong>최근 기록 중 {formatNumber(insufficient.length)}개 종목은 과거 자료가 부족해 자동매매 대상에서 제외했습니다.</strong>
        <p>이동평균선 계산에 {requiredDays.join("·")}거래일이 필요합니다. 주문 실패가 아니며, 자료가 쌓이면 자동으로 다시 검사합니다.</p>
        <details><summary>제외된 종목 자세히 보기</summary><p>{insufficient.map(({ detail }) => `${detail.symbol}(${detail.available}일)`).join(", ")}</p></details>
      </div>
      <time>{formatDateTime(insufficient[0]?.row.createdAt ?? "")}</time>
    </article> : null}
    {remaining.map((row) => {
      const presentation = presentError(row);
      return <article key={row.id}>
        <span className={`severity ${presentation.severityClass}`}>{presentation.severityLabel}</span>
        <div>
          <strong>{presentation.message}</strong>
          <p>{row.brokerId ? brokerLabel[row.brokerId] : "공통 엔진"}{presentation.detailLabel ? ` · ${presentation.detailLabel}` : ""}</p>
          {presentation.technicalDetails ? <details><summary>기술 정보</summary><p>{presentation.technicalDetails}</p></details> : null}
        </div>
        <time>{formatDateTime(row.createdAt)}</time>
      </article>;
    })}
  </div>;
}

function Empty({ label }: { label: string }) {
  return <div className="empty records-empty"><strong>{label}</strong><span>테스트용 가상 데이터는 표시하지 않습니다.</span></div>;
}
