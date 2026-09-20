import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ExecutionTable, ExecutionTradeCards } from "../components/records-client";
import type { ExecutionRow } from "../lib/api-types";
import {
  executionMarketLabel,
  filterExecutions,
  pairExecutionsFifo,
  summarizeExecutionTrades,
  summarizeExecutions,
} from "../lib/execution-records";

const buy: ExecutionRow = {
  id: "fill-buy",
  brokerId: "kiwoom",
  environment: "live",
  accountIdMasked: "****5678",
  brokerExecutionId: "execution-buy",
  brokerOrderId: "order-buy",
  symbol: "005930",
  name: "삼성전자",
  side: "buy",
  quantity: 3,
  price: 72_100,
  grossAmount: 216_300,
  fee: 120,
  tax: 0,
  exchange: "SOR",
  realizedPnl: null,
  executedAt: "2026-09-14T01:02:03.000Z",
};

const sell: ExecutionRow = {
  ...buy,
  id: "fill-sell",
  brokerId: "koreainvestment",
  environment: "paper",
  accountIdMasked: "****4321",
  brokerExecutionId: "execution-sell",
  brokerOrderId: "order-sell",
  symbol: "000660",
  name: "SK하이닉스",
  side: "sell",
  quantity: 2,
  price: 180_000,
  grossAmount: 360_000,
  fee: 150,
  tax: 650,
  exchange: "NXT",
  realizedPnl: null,
};

describe("실제 체결 내역", () => {
  it("매수·매도 필터가 주문이나 후보가 아닌 체결 행만 구분한다", () => {
    expect(filterExecutions([buy, sell], "all")).toEqual([buy, sell]);
    expect(filterExecutions([buy, sell], "buy")).toEqual([buy]);
    expect(filterExecutions([buy, sell], "sell")).toEqual([sell]);
  });

  it("DB에서 받은 체결금액과 비용만 합산한다", () => {
    expect(summarizeExecutions([buy, sell])).toEqual({
      totalCount: 2,
      buyCount: 1,
      sellCount: 1,
      buyAmount: 216_300,
      sellAmount: 360_000,
      fee: 270,
      tax: 650,
    });
  });

  it("종목, 방향, 실제 가격·금액·비용·시장·시각을 한국어 표에 표시한다", () => {
    const html = renderToStaticMarkup(createElement(ExecutionTable, { rows: [buy, sell] }));

    expect(html).toContain("체결시각");
    expect(html).toContain("삼성전자");
    expect(html).toContain("005930");
    expect(html).toContain("매수");
    expect(html).toContain("3주");
    expect(html).toContain("72,100원");
    expect(html).toContain("216,300원");
    expect(html).toContain("수수료");
    expect(html).toContain("120원");
    expect(html).toContain("세금");
    expect(html).toContain("650원");
    expect(html).toContain("자동선택 (SOR)");
    expect(html).toContain("NXT");
    expect(html).toContain("실전 · ****5678");
    expect(html).toContain("모의 · ****4321");
    expect(html).toContain("주문번호 order-buy");
    expect(html).toContain("체결 식별값 execution-buy");
  });

  it("공식 개별 매도 실현손익이 없으면 계산한 숫자를 만들지 않는다", () => {
    const html = renderToStaticMarkup(createElement(ExecutionTable, { rows: [sell] }));

    expect(html).toMatch(/data-label="매도 실현손익"[^>]*>—<\/td>/);
    expect(html).not.toContain("179,200원");
  });

  it("주문 시장 이름을 그대로 보존하고 SOR만 풀어 쓴다", () => {
    expect(executionMarketLabel("KRX")).toBe("KRX");
    expect(executionMarketLabel("NXT")).toBe("NXT");
    expect(executionMarketLabel("SOR")).toBe("자동선택 (SOR)");
    expect(executionMarketLabel(null)).toBe("—");
  });

  it("입력 순서와 무관하게 같은 계좌·종목의 매수를 시간순 FIFO로 부분매도에 연결한다", () => {
    const firstBuy: ExecutionRow = {
      ...buy,
      id: "first-buy",
      brokerExecutionId: "first-buy-execution",
      quantity: 5,
      price: 70_000,
      executedAt: "2026-09-14T00:00:00.000Z",
    };
    const secondBuy: ExecutionRow = {
      ...buy,
      id: "second-buy",
      brokerExecutionId: "second-buy-execution",
      quantity: 4,
      price: 71_000,
      executedAt: "2026-09-14T00:10:00.000Z",
    };
    const partialSell: ExecutionRow = {
      ...buy,
      id: "partial-sell",
      brokerExecutionId: "partial-sell-execution",
      side: "sell",
      quantity: 7,
      price: 73_000,
      executedAt: "2026-09-14T00:20:00.000Z",
    };

    const pairs = pairExecutionsFifo([partialSell, secondBuy, firstBuy]);
    const matched = pairs.filter((pair) => pair.status === "matched");
    const open = pairs.find((pair) => pair.status === "open-buy");

    expect(matched).toHaveLength(2);
    expect(matched.find((pair) => pair.buy?.execution.id === "first-buy")?.quantity).toBe(5);
    expect(matched.find((pair) => pair.buy?.execution.id === "second-buy")?.quantity).toBe(2);
    expect(open?.buy?.execution.id).toBe("second-buy");
    expect(open?.quantity).toBe(2);
    expect(summarizeExecutionTrades(pairs)).toEqual({
      matchedLotCount: 2,
      openBuyLotCount: 1,
      unmatchedSellLotCount: 0,
      matchedQuantity: 7,
      openBuyQuantity: 2,
      unmatchedSellQuantity: 0,
    });
  });

  it("다른 증권사·환경·계좌·종목의 체결을 서로 연결하지 않는다", () => {
    const accountSell: ExecutionRow = {
      ...buy,
      id: "other-account-sell",
      brokerExecutionId: "other-account-sell-execution",
      accountIdMasked: "****9999",
      side: "sell",
      quantity: 1,
      executedAt: "2026-09-14T02:00:00.000Z",
    };

    const pairs = pairExecutionsFifo([buy, accountSell]);

    expect(pairs.map((pair) => pair.status).sort()).toEqual(["open-buy", "unmatched-sell"]);
    expect(pairs.some((pair) => pair.status === "matched")).toBe(false);
  });

  it("매수보다 먼저 발생한 매도는 이후 매수에 거꾸로 연결하지 않는다", () => {
    const earlierSell: ExecutionRow = {
      ...buy,
      id: "earlier-sell",
      brokerExecutionId: "earlier-sell-execution",
      side: "sell",
      quantity: 2,
      executedAt: "2026-09-13T23:00:00.000Z",
    };
    const laterBuy: ExecutionRow = {
      ...buy,
      id: "later-buy",
      brokerExecutionId: "later-buy-execution",
      quantity: 2,
      executedAt: "2026-09-14T00:00:00.000Z",
    };

    const pairs = pairExecutionsFifo([laterBuy, earlierSell]);

    expect(pairs).toHaveLength(2);
    expect(pairs.some((pair) => pair.status === "unmatched-sell" && pair.sell?.execution.id === "earlier-sell")).toBe(true);
    expect(pairs.some((pair) => pair.status === "open-buy" && pair.buy?.execution.id === "later-buy")).toBe(true);
  });

  it("한 카드 안에 실제 매수·매도 시각, 가격, 연결 수량을 표시하고 손익을 만들지 않는다", () => {
    const paired = pairExecutionsFifo([{
      ...buy,
      id: "same-account-sell",
      brokerExecutionId: "same-account-sell-execution",
      side: "sell",
      quantity: 2,
      price: 74_000,
      executedAt: "2026-09-14T02:00:00.000Z",
    }, buy]);
    const html = renderToStaticMarkup(createElement(ExecutionTradeCards, { pairs: paired }));

    expect(html).toContain("매수·매도 연결");
    expect(html).toContain("72,100원 · 2주");
    expect(html).toContain("74,000원 · 2주");
    expect(html).toContain("서로 연결된 수량");
    expect(html).toContain("손익은 임의 계산하지 않습니다");
    expect(html).not.toContain("3,800원");
  });

  it("부분매도 잔량과 선행 매수가 없는 매도를 카드에서 명시한다", () => {
    const openAndUnmatched = pairExecutionsFifo([
      { ...buy, id: "open", brokerExecutionId: "open-execution", quantity: 3 },
      {
        ...buy,
        id: "unmatched",
        brokerExecutionId: "unmatched-execution",
        accountIdMasked: "****0000",
        side: "sell",
        quantity: 2,
        executedAt: "2026-09-14T03:00:00.000Z",
      },
    ]);
    const html = renderToStaticMarkup(createElement(ExecutionTradeCards, { pairs: openAndUnmatched }));

    expect(html).toContain("아직 매도 체결 없음");
    expect(html).toContain("조회 범위 내 매수 없음");
    expect(html).toContain("확인되지 않은 매수 체결을 만들어 연결하지 않았습니다");
  });
});
