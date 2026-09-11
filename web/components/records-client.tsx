"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertCircle, RefreshCw } from "lucide-react";
import { formatDateTime, formatNumber, formatWon, getJson } from "@/lib/client-api";
import type { DashboardResponse } from "@/lib/api-types";
import { tradeReasonSummary } from "../lib/trade-reasons";
import {
  formatOrderStatus,
  insufficientDailyBars,
  presentError,
} from "@/lib/error-presentation";

export function RecordsClient({ type }: { type: "orders" | "positions" | "errors" }) {
  const [data, setData] = useState<DashboardResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => { try { setData(await getJson<DashboardResponse>("/api/engine/dashboard")); setError(null); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } }, []);
  useEffect(() => { void load(); }, [load]);
  const title = type === "orders" ? "주문·체결" : type === "positions" ? "보유종목" : "시스템 기록";
  const eyebrow = type === "orders" ? "주문 내역" : type === "positions" ? "보유 현황" : "오류와 안내";
  const subtitle = type === "errors"
    ? "실제 주문 오류뿐 아니라 연결 재시도와 시세 자료 안내도 함께 표시합니다."
    : "키움증권과 한국투자증권 기록을 한곳에 표시합니다.";
  return <main className="shell"><header className="page-header"><div><p className="eyebrow">{eyebrow}</p><h1>{title}</h1><p className="subtitle">{subtitle}</p></div><button className="icon-button" onClick={() => void load()} aria-label="새로고침"><RefreshCw size={16} /></button></header>{error ? <div className="notice danger"><AlertCircle size={17} /><div><strong>데이터를 불러오지 못했습니다</strong><p>트레이딩 엔진 연결 상태를 확인한 뒤 다시 시도해 주세요.</p><details><summary>기술 정보</summary><p>{error}</p></details></div></div> : null}{type === "orders" ? <div className="notice"><AlertCircle size={17} /><div><strong>조건검색은 자동매매 시작 여부와 상관없이 실행됩니다</strong><p>아래 후보는 조건검색 결과이며 주문 내역이 아닙니다. 실제 주문은 자동매매를 시작하고 모든 안전 조건을 통과한 장중에만 전송됩니다.</p></div></div> : null}{type === "errors" ? <div className="notice warning"><AlertCircle size={17} /><div><strong>‘자료 부족’은 주문 실패가 아닙니다</strong><p>이동평균선을 계산할 과거 거래일이 부족한 신규 종목은 자동으로 건너뛰며, 자료가 쌓이면 다시 검사합니다.</p></div></div> : null}{type === "orders" ? <><section className="table-card records-card"><div className="section-head"><div><p>조건 검사 결과</p><h2>현재 매수·매도 후보 전체</h2></div><span>{formatNumber(data?.candidates.length)}종목</span></div><Candidates data={data} /></section><section className="table-card records-card"><div className="section-head"><div><p>실제 증권사 전송 기록</p><h2>오늘 주문·체결 내역</h2></div></div><Orders data={data} /></section></> : <section className="table-card records-card">{type === "positions" ? <Positions data={data} /> : <Errors data={data} />}</section>}</main>;
}

function Candidates({ data }: { data: DashboardResponse | null }) { const rows = data?.candidates ?? []; return rows.length === 0 ? <Empty label={data?.market.scanMode === "WAITING_FOR_DATA" ? "조건 검사를 준비하고 있습니다" : "조건을 통과한 종목이 없습니다"} /> : <div className="table-wrap"><table><thead><tr><th>기준 시각</th><th>증권사</th><th>종목</th><th>판정</th><th>기준 가격</th><th>가격 기준</th></tr></thead><tbody>{rows.map((row) => <tr key={row.id}><td>{formatDateTime(row.generatedAt)}</td><td>{row.brokerId === "kiwoom" ? "키움" : "한투"}</td><td><strong>{row.name || row.symbol}</strong><small>{row.symbol}</small></td><td><span className={`side ${row.action.toLowerCase()}`}>{row.action === "BUY" ? "매수 후보" : row.action === "SELL" ? "매도 후보" : "조건 감지"}</span>{tradeReasonSummary(row.reasonCodes) ? <small>{tradeReasonSummary(row.reasonCodes)}</small> : null}</td><td>{formatWon(row.price)}</td><td>{row.source === "LIVE" ? "실시간 가격" : "마지막 저장 가격"}</td></tr>)}</tbody></table></div>; }
function Orders({ data }: { data: DashboardResponse | null }) { const rows = data?.orders ?? []; return rows.length === 0 ? <Empty label="저장된 실제 주문이 없습니다" /> : <div className="table-wrap"><table><thead><tr><th>시간</th><th>증권사</th><th>주문 시장</th><th>종목</th><th>구분</th><th>주문한 수량</th><th>체결된 수량</th><th>주문 가격</th><th>처리 상태</th></tr></thead><tbody>{rows.map((row) => <tr key={row.id}><td>{formatDateTime(row.createdAt)}</td><td>{row.brokerId === "kiwoom" ? "키움" : "한투"}</td><td>{row.exchange === "SOR" ? "자동 선택" : row.exchange ?? "KRX"}</td><td><strong>{row.name || row.symbol}</strong><small>{row.symbol}</small></td><td><span className={`side ${row.side}`}>{row.side === "buy" ? "매수" : "매도"}</span></td><td>{formatNumber(row.quantity)}</td><td>{formatNumber(row.filledQuantity)}</td><td>{row.orderType === "market" ? "시장가" : formatWon(row.limitPrice)}</td><td>{formatOrderStatus(row.status)}</td></tr>)}</tbody></table></div>; }
function Positions({ data }: { data: DashboardResponse | null }) { const rows = data?.positions ?? []; return rows.length === 0 ? <Empty label="동기화된 실제 보유종목이 없습니다" /> : <div className="table-wrap"><table><thead><tr><th>증권사</th><th>종목</th><th>보유 수량</th><th>평균 매수가</th><th>현재가</th><th>수익률</th><th>평가손익</th></tr></thead><tbody>{rows.map((row) => <tr key={`${row.brokerId}-${row.symbol}`}><td>{row.brokerId === "kiwoom" ? "키움" : "한투"}</td><td><strong>{row.name || row.symbol}</strong><small>{row.symbol}</small></td><td>{formatNumber(row.quantity)}</td><td>{formatWon(row.averagePrice)}</td><td>{formatWon(row.currentPrice)}</td><td className={row.unrealizedPnlBps > 0 ? "positive" : row.unrealizedPnlBps < 0 ? "negative" : ""}>{(row.unrealizedPnlBps / 100).toFixed(2)}%</td><td className={row.unrealizedPnl > 0 ? "positive" : row.unrealizedPnl < 0 ? "negative" : ""}>{formatWon(row.unrealizedPnl, true)}</td></tr>)}</tbody></table></div>; }
function Errors({ data }: { data: DashboardResponse | null }) {
  const rows = data?.errors ?? [];
  if (rows.length === 0) return <Empty label="문제나 안내 기록이 없습니다" />;
  const insufficient = rows.flatMap((row) => {
    const detail = insufficientDailyBars(row);
    return detail ? [{ row, detail }] : [];
  });
  const remaining = rows.filter((row) => insufficientDailyBars(row) === null);
  const requiredDays = [...new Set(insufficient.map(({ detail }) => detail.required))].sort((a, b) => a - b);
  return <div className="error-list">{insufficient.length > 0 ? <article><span className="severity info">자료 부족</span><div><strong>최근 기록 중 {formatNumber(insufficient.length)}개 종목은 과거 자료가 부족해 자동매매 대상에서 제외했습니다.</strong><p>이동평균선 계산에 {requiredDays.join("·")}거래일이 필요합니다. 주문 실패가 아니며, 자료가 쌓이면 자동으로 다시 검사합니다.</p><details><summary>제외된 종목 자세히 보기</summary><p>{insufficient.map(({ detail }) => `${detail.symbol}(${detail.available}일)`).join(", ")}</p></details></div><time>{formatDateTime(insufficient[0]?.row.createdAt ?? "")}</time></article> : null}{remaining.map((row) => { const presentation = presentError(row); return <article key={row.id}><span className={`severity ${presentation.severityClass}`}>{presentation.severityLabel}</span><div><strong>{presentation.message}</strong><p>{row.brokerId ? (row.brokerId === "kiwoom" ? "키움증권" : "한국투자증권") : "공통 엔진"}{presentation.detailLabel ? ` · ${presentation.detailLabel}` : ""}</p>{presentation.technicalDetails ? <details><summary>기술 정보</summary><p>{presentation.technicalDetails}</p></details> : null}</div><time>{formatDateTime(row.createdAt)}</time></article>; })}</div>;
}
function Empty({ label }: { label: string }) { return <div className="empty records-empty"><strong>{label}</strong><span>테스트용 가상 데이터는 표시하지 않습니다.</span></div>; }
