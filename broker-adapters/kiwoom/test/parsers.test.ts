import { describe, expect, it } from "vitest";
import { readInstrumentSafetyMetadata } from "@kstock/shared";
import {
  parseCurrentExecution,
  parseHistoricalOrders,
  parseInstrument,
  parseInstrumentRecords,
  parseQuote,
} from "../src/parsers.js";
import {
  assertSymbol,
  exchangeFromKiwoomQuoteSymbol,
  kiwoomQuoteSymbol,
  normalizeSymbol,
} from "../src/normalization.js";

describe("Kiwoom current execution identity", () => {
  it("marks the ka10076 composite identity when no fill number is present", () => {
    expect(parseCurrentExecution({
      ord_no: "0255187",
      stk_cd: "005935",
      cntr_qty: "2",
      cntr_pric: "188850",
      ord_tm: "122350",
      io_tp_nm: "현금매수",
    }, "20260904")).toMatchObject({
      executionId: "ka10076:20260904:0255187:122350:188850:2",
      syntheticExecutionId: true,
    });
  });
});

describe("Kiwoom domestic stock symbols", () => {
  it("accepts six-character alphanumeric KRX short codes", () => {
    expect(assertSymbol("00088K")).toBe("00088K");
    expect(parseInstrument({ code: "00088K", name: "한화3우B", state: "정상" }))
      .toMatchObject({ symbol: "00088K", name: "한화3우B", active: true });
  });

  it("normalizes broker prefixes, casing, and exchange suffixes", () => {
    expect(normalizeSymbol(" A00088k_KRX ")).toBe("00088K");
    expect(assertSymbol("J005930_KRX")).toBe("005930");
    expect(assertSymbol("q123ab4_nxt")).toBe("123AB4");
  });

  it("uses Kiwoom's documented NXT and SOR quote suffixes", () => {
    expect(kiwoomQuoteSymbol("005930", "KRX")).toBe("005930");
    expect(kiwoomQuoteSymbol("005930", "NXT")).toBe("005930_NX");
    expect(kiwoomQuoteSymbol("005930", "SOR")).toBe("005930_AL");
    expect(exchangeFromKiwoomQuoteSymbol("005930_NX")).toBe("NXT");
    expect(exchangeFromKiwoomQuoteSymbol("005930_AL")).toBe("SOR");
  });

  it("still rejects malformed or non-ASCII short codes", () => {
    expect(() => assertSymbol("00593")).toThrow(/exactly six ASCII/);
    expect(() => assertSymbol("00593-0")).toThrow(/exactly six ASCII/);
    expect(() => assertSymbol("00가88K")).toThrow(/exactly six ASCII/);
  });

  it("isolates an invalid ka10099 row without dropping valid instruments", () => {
    const parsed = parseInstrumentRecords([
      { code: "005930", name: "삼성전자", state: "정상", regDay: "19750611" },
      { code: "00088K", name: "한화3우B", state: "정상" },
      { code: "BAD", name: "잘못된 행", state: "정상" },
      { code: "000660", state: "정상" },
    ]);

    expect(parsed.instruments.map((instrument) => instrument.symbol)).toEqual([
      "005930",
      "00088K",
    ]);
    expect(parsed.issues).toEqual([
      expect.objectContaining({ index: 2, code: "INVALID_SYMBOL" }),
      expect.objectContaining({ index: 3, code: "MALFORMED_RESPONSE" }),
    ]);
  });

  it("blocks broker-designated risky instruments from new buys", () => {
    const managed = parseInstrument({
      code: "005930",
      name: "위험종목",
      state: "관리종목 투자경고 거래정지",
      auditInfo: "감리",
      orderWarning: "1",
    });
    expect(readInstrumentSafetyMetadata(managed)).toMatchObject({
      buyAllowed: false,
      restrictionCodes: expect.arrayContaining([
        "TRADING_SUSPENDED",
        "MANAGED_ISSUE",
        "MARKET_WARNING",
        "INVESTMENT_CAUTION",
        "AUDIT_ISSUE",
      ]),
    });
  });

  it("does not mistake the normal '관리종목아님' value for a restriction", () => {
    const normal = parseInstrument({
      code: "005930",
      name: "삼성전자",
      state: "관리종목아님",
      auditInfo: "정상",
      orderWarning: "0",
    });
    expect(readInstrumentSafetyMetadata(normal).buyAllowed).toBe(true);
  });

  it("excludes clearly identified leveraged exchange products", () => {
    const product = parseInstrument({
      code: "123456",
      name: "테스트 레버리지 ETN",
      state: "정상",
      auditInfo: "정상",
      orderWarning: "0",
    });
    expect(readInstrumentSafetyMetadata(product).restrictionCodes).toContain(
      "HIGH_RISK_EXCHANGE_PRODUCT",
    );
  });

  it("excludes ordinary ETFs using the ka10099 market classification", () => {
    const product = parseInstrument({
      code: "069500",
      name: "KODEX 200",
      state: "증거금20%|담보대출|신용가능",
      auditInfo: "정상",
      orderWarning: "0",
      companyClassName: "",
      marketCode: "8",
      marketName: "ETF",
    });
    expect(readInstrumentSafetyMetadata(product)).toMatchObject({
      buyAllowed: false,
      restrictionCodes: ["HIGH_RISK_EXCHANGE_PRODUCT"],
    });
  });

  it("excludes all ka10099 ETN market variants", () => {
    for (const marketCode of ["60", "70", "90"]) {
      const product = parseInstrument({
        code: "123456",
        name: "테스트 상품",
        state: "정상",
        auditInfo: "정상",
        orderWarning: "0",
        marketCode,
        marketName: "ETN",
      });
      expect(readInstrumentSafetyMetadata(product).restrictionCodes).toContain(
        "HIGH_RISK_EXCHANGE_PRODUCT",
      );
    }
  });
});

describe("Kiwoom ka10095 quote timestamps", () => {
  const receivedAt = new Date("2026-09-03T04:00:05.000Z");
  const base = {
    stk_cd: "005930",
    cur_prc: "+70000",
    trde_qty: "123456",
  };

  it("marks a broker-supplied trading date and execution time as verified", () => {
    expect(parseQuote({ ...base, dt: "20260903", cntr_tm: "130003" }, receivedAt))
      .toMatchObject({
        tradingDate: "2026-09-03",
        tradingTime: "130003",
        brokerTimestampVerified: true,
        source: "kiwoom",
      });
  });

  it("preserves the NXT route while returning the canonical symbol", () => {
    expect(
      parseQuote(
        { ...base, stk_cd: "005930_NX", dt: "20260903", cntr_tm: "130003" },
        receivedAt,
      ),
    ).toMatchObject({ symbol: "005930", exchange: "NXT" });
  });

  it("never disguises a missing execution date or time as fresh broker evidence", () => {
    const missingDate = parseQuote({ ...base, cntr_tm: "130003" }, receivedAt);
    const missingTime = parseQuote({ ...base, dt: "20260903", bid_tm: "130004" }, receivedAt);

    expect(missingDate).toMatchObject({ stale: true });
    expect(missingDate.brokerTimestampVerified).toBeUndefined();
    expect(missingTime).toMatchObject({ tradingTime: "130004", stale: true });
    expect(missingTime.brokerTimestampVerified).toBeUndefined();
  });

  it("rejects an impossible broker execution time as freshness evidence", () => {
    const parsed = parseQuote({ ...base, dt: "20260903", cntr_tm: "256199" }, receivedAt);
    expect(parsed.stale).toBe(true);
    expect(parsed.brokerTimestampVerified).toBeUndefined();
  });
});

describe("Kiwoom kt00009 order history", () => {
  it("aggregates distinct fill rows into one order without double-counting", () => {
    const orders = parseHistoricalOrders([
      {
        ord_no: "0000123",
        stk_cd: "005930",
        trde_tp: "2",
        io_tp_nm: "현금매수",
        ord_qty: "5",
        ord_uv: "70000",
        acpt_tp: "접수",
        cntr_no: "9001",
        cntr_qty: "2",
        cntr_uv: "70000",
        cntr_tm: "091000",
      },
      {
        ord_no: "0000123",
        stk_cd: "005930",
        trde_tp: "2",
        io_tp_nm: "현금매수",
        ord_qty: "5",
        ord_uv: "70000",
        acpt_tp: "접수",
        cntr_no: "9002",
        cntr_qty: "1",
        cntr_uv: "70000",
        cntr_tm: "091001",
      },
      {
        ord_no: "0000123",
        stk_cd: "005930",
        trde_tp: "2",
        io_tp_nm: "현금매수",
        ord_qty: "5",
        ord_uv: "70000",
        acpt_tp: "접수",
        cntr_no: "9002",
        cntr_qty: "1",
        cntr_uv: "70000",
        cntr_tm: "091001",
      },
    ], "20260902");

    expect(orders).toHaveLength(1);
    expect(orders[0]).toMatchObject({
      brokerOrderId: "0000123",
      symbol: "005930",
      side: "buy",
      orderedQuantity: 5,
      filledQuantity: 3,
      remainingQuantity: 2,
      status: "PARTIALLY_FILLED",
    });
  });

  it("marks only a broker-confirmed linked cancellation as terminal", () => {
    const [confirmed, unconfirmed] = parseHistoricalOrders([
      {
        ord_no: "0000124",
        orig_ord_no: "0000123",
        stk_cd: "005930",
        trde_tp: "2",
        io_tp_nm: "현금매수취소",
        ord_qty: "2",
        cnfm_qty: "2",
        acpt_tp: "확인",
        mdfy_cncl_tp: "취소",
        cntr_tm: "091500",
      },
      {
        ord_no: "0000125",
        orig_ord_no: "0000123",
        stk_cd: "005930",
        trde_tp: "2",
        io_tp_nm: "현금매수취소",
        ord_qty: "2",
        cnfm_qty: "0",
        acpt_tp: "접수",
        mdfy_cncl_tp: "취소",
        cntr_tm: "091501",
      },
    ], "20260902");

    expect(confirmed).toMatchObject({
      brokerOrderId: "0000124",
      originalBrokerOrderId: "0000123",
      status: "CANCELED",
      remainingQuantity: 0,
    });
    expect(unconfirmed).toMatchObject({
      brokerOrderId: "0000125",
      status: "ACKED",
      remainingQuantity: 2,
    });
  });
});
