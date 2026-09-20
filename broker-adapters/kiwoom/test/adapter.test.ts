import type {
  AccountScope,
  BrokerEvent,
  CachedAccessToken,
  Exchange,
  TokenStore,
} from "@kstock/shared";
import { describe, expect, it, vi } from "vitest";

import {
  KiwoomBrokerAdapter,
  kiwoomCashOrderFields,
} from "../src/adapter.js";

const scope: AccountScope = {
  brokerId: "kiwoom",
  environment: "live",
  accountId: "12345678",
};

class MemoryTokenStore implements TokenStore {
  async get(): Promise<CachedAccessToken> {
    return {
      token: "cached-token",
      expiresAt: "2099-12-31T23:59:59.000Z",
    };
  }

  async set(): Promise<void> {}

  async delete(): Promise<void> {}
}

function createAdapter(responseBody: Record<string, unknown>) {
  const fetchImplementation = vi.fn(async () => Response.json(responseBody)) as typeof fetch;
  const adapter = new KiwoomBrokerAdapter({
    environment: "live",
    credentials: {
      appKey: "app-key",
      appSecret: "app-secret",
      accountId: scope.accountId,
    },
    tokenStore: new MemoryTokenStore(),
    fetchImplementation,
  });
  return { adapter, fetchImplementation };
}

function createQuoteAdapter(exchange: Exchange) {
  const routedSymbol =
    exchange === "KRX" ? "005930" : exchange === "NXT" ? "005930_NX" : "005930_AL";
  const fetchImplementation = vi.fn(async () => Response.json({
    return_code: 0,
    atn_stk_infr: [{
      stk_cd: routedSymbol,
      cur_prc: "+70000",
      trde_qty: "123456",
      dt: "20260904",
      cntr_tm: "101500",
    }],
  })) as typeof fetch;
  const adapter = new KiwoomBrokerAdapter({
    environment: "live",
    quoteExchange: exchange,
    credentials: {
      appKey: "app-key",
      appSecret: "app-secret",
      accountId: scope.accountId,
    },
    tokenStore: new MemoryTokenStore(),
    fetchImplementation,
  });
  return { adapter, fetchImplementation, routedSymbol };
}

describe("Kiwoom official KOSPI index", () => {
  it("loads the KOSPI composite change from ka20001", async () => {
    const { adapter, fetchImplementation } = createAdapter({
      return_code: 0,
      cur_prc: "-3312.45",
      pred_pre_sig: "5",
      pred_pre: "-18.25",
      flu_rt: "-0.55",
    });

    await expect(adapter.fetchKospiIndex()).resolves.toMatchObject({
      indexCode: "KOSPI",
      currentValue: 3312.45,
      change: -18.25,
      changeRateBps: -55,
      direction: "DOWN",
      source: "kiwoom",
    });
    const request = fetchImplementation.mock.calls[0]?.[1];
    expect(request?.headers).toMatchObject({ "api-id": "ka20001" });
    expect(JSON.parse(String(request?.body))).toEqual({ mrkt_tp: "0", inds_cd: "001" });
  });

  it("accepts Kiwoom's pre-open flat summary when pred_pre is blank", async () => {
    const { adapter } = createAdapter({
      return_code: 0,
      cur_prc: "6684.37",
      pred_pre_sig: "3",
      pred_pre: "",
      flu_rt: "0.00",
      inds_cur_prc_tm: [{
        tm_n: "",
        cur_prc_n: "",
        pred_pre_sig_n: "",
        pred_pre_n: "",
        flu_rt_n: "",
      }],
    });

    await expect(adapter.fetchKospiIndex()).resolves.toMatchObject({
      currentValue: 6684.37,
      change: 0,
      changeRateBps: 0,
      direction: "FLAT",
      source: "kiwoom",
    });
  });

  it("falls back to the newest complete official time-series observation", async () => {
    const { adapter } = createAdapter({
      return_code: 0,
      cur_prc: "",
      pred_pre_sig: "",
      pred_pre: "",
      flu_rt: "",
      inds_cur_prc_tm: [
        {
          tm_n: "090100",
          cur_prc_n: "+3314.20",
          pred_pre_sig_n: "2",
          pred_pre_n: "+2.10",
          flu_rt_n: "+0.06",
        },
        {
          tm_n: "090500",
          cur_prc_n: "-3304.80",
          pred_pre_sig_n: "5",
          pred_pre_n: "-7.30",
          flu_rt_n: "-0.22",
        },
      ],
    });

    await expect(adapter.fetchKospiIndex()).resolves.toMatchObject({
      currentValue: 3304.8,
      change: -7.3,
      changeRateBps: -22,
      direction: "DOWN",
      source: "kiwoom",
    });
  });

  it("does not invent a non-flat point change when Kiwoom omits it", async () => {
    const { adapter } = createAdapter({
      return_code: 0,
      cur_prc: "3312.45",
      pred_pre_sig: "5",
      pred_pre: "",
      flu_rt: "-0.55",
    });

    await expect(adapter.fetchKospiIndex()).rejects.toMatchObject({
      code: "MALFORMED_KOSPI_INDEX",
    });
  });
});

describe("Kiwoom ka10099 universe", () => {
  it("keeps valid numeric and alphanumeric instruments when one row is malformed", async () => {
    const { adapter, fetchImplementation } = createAdapter({
      return_code: 0,
      list: [
        { code: "005930", name: "삼성전자", state: "정상", regDay: "19750611" },
        { code: "00088K", name: "한화3우B", state: "정상" },
        { code: "BAD", name: "잘못된 행", state: "정상" },
      ],
    });
    const events: BrokerEvent[] = [];
    adapter.onEvent((event) => events.push(event));

    await expect(adapter.fetchInstruments()).resolves.toMatchObject([
      { symbol: "005930", name: "삼성전자" },
      { symbol: "00088K", name: "한화3우B" },
    ]);
    expect(fetchImplementation).toHaveBeenCalledOnce();
    const request = fetchImplementation.mock.calls[0]?.[1];
    expect(JSON.parse(String(request?.body))).toEqual({ mrkt_tp: "0" });
    expect(events).toContainEqual({
      type: "error",
      error: expect.objectContaining({
        code: "KIWOOM_INSTRUMENT_RECORDS_SKIPPED",
        message: expect.stringContaining("INVALID_SYMBOL: 1"),
      }),
    });
  });

  it("fails clearly when the broker returns no usable instrument rows", async () => {
    const { adapter } = createAdapter({
      return_code: 0,
      list: [{ code: "BAD", name: "잘못된 행" }],
    });

    await expect(adapter.fetchInstruments()).rejects.toMatchObject({
      code: "MALFORMED_INSTRUMENT_UNIVERSE",
    });
  });
});

describe("Kiwoom quote routing", () => {
  for (const exchange of ["KRX", "NXT", "SOR"] as const) {
    it(`routes REST quotes through ${exchange} and normalizes the response`, async () => {
      const { adapter, fetchImplementation, routedSymbol } = createQuoteAdapter(exchange);

      await expect(adapter.fetchQuote("005930")).resolves.toMatchObject({
        symbol: "005930",
        exchange,
        price: 70_000,
      });
      const request = fetchImplementation.mock.calls[0]?.[1];
      expect(JSON.parse(String(request?.body))).toEqual({ stk_cd: routedSymbol });
    });
  }

  it("rejects an NXT quote route in paper trading", () => {
    expect(() => new KiwoomBrokerAdapter({
      environment: "paper",
      quoteExchange: "NXT",
      credentials: {
        appKey: "app-key",
        appSecret: "app-secret",
        accountId: scope.accountId,
      },
      tokenStore: new MemoryTokenStore(),
    })).toThrow(/paper trading supports KRX market data/i);
  });
});

describe("Kiwoom KRX aftermarket cash-order mapping", () => {
  const atKst = (value: string): Date => new Date(`${value}+09:00`);

  it.each([
    ["2026-09-13T16:00:00", false, "3"],
    ["2026-09-14T15:59:59", false, "3"],
    ["2026-09-14T16:00:00", true, "6"],
    ["2026-09-14T19:59:59", true, "6"],
    ["2026-09-14T20:00:00", false, "3"],
  ] as const)(
    "maps a market intent at %s (aftermarket=%s)",
    (timestamp, krxAftermarket, tradeType) => {
      expect(kiwoomCashOrderFields("market", undefined, "KRX", atKst(timestamp))).toEqual({
        tradeType,
        orderPrice: "",
        krxAftermarket,
      });
    },
  );

  it("does not apply KRX aftermarket semantics to SOR or NXT", () => {
    const now = atKst("2026-09-14T16:00:00");
    expect(kiwoomCashOrderFields("market", undefined, "SOR", now).tradeType).toBe("3");
    expect(kiwoomCashOrderFields("limit", 70_000, "NXT", now)).toMatchObject({
      tradeType: "0",
      orderPrice: "70000",
      krxAftermarket: false,
    });
  });

  it("submits an aftermarket best-price limit instead of an unavailable market order", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(atKst("2026-09-14T16:00:00"));
    try {
      const { adapter, fetchImplementation } = createAdapter({
        return_code: 0,
        ord_no: "0000123",
      });

      await expect(adapter.placeOrder({
        clientOrderId: "aftermarket-market-intent",
        symbol: "005930",
        side: "buy",
        orderType: "market",
        quantity: 1,
        exchange: "KRX",
      })).resolves.toMatchObject({ outcome: "ACCEPTED", brokerOrderId: "0000123" });

      const request = fetchImplementation.mock.calls[0]?.[1];
      const headers = new Headers(request?.headers);
      expect(headers.get("api-id")).toBe("kt10000");
      expect(JSON.parse(String(request?.body))).toEqual({
        dmst_stex_tp: "KRX",
        stk_cd: "005930",
        ord_qty: "1",
        trde_tp: "6",
        ord_uv: "",
        cond_uv: "",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps Kiwoom's normal limit code for a KRX aftermarket limit", () => {
    expect(kiwoomCashOrderFields(
      "limit",
      70_000,
      "KRX",
      atKst("2026-09-14T16:00:00"),
    )).toEqual({ tradeType: "0", orderPrice: "70000", krxAftermarket: true });
  });
});

describe("Kiwoom empty order history", () => {
  it("treats only kt00009's 501724 no-data response as an empty list", async () => {
    const { adapter } = createAdapter({
      return_code: 2000,
      return_msg: "[2000](501724:관련자료가없습니다)",
    });
    const today = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Seoul",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date()).replaceAll("-", "");

    await expect(adapter.fetchOrderHistory(today)).resolves.toEqual([]);
  });

  it("uses the date-scoped kt00009 ledger for today's executions", async () => {
    const { adapter, fetchImplementation } = createAdapter({
      return_code: 0,
      acnt_ord_cntr_prst_array: [{
        ord_no: "0255187",
        stk_cd: "005935",
        trde_tp: "2",
        io_tp_nm: "+매수",
        cntr_no: "49379",
        cntr_qty: "2",
        cntr_uv: "188850",
        cntr_tm: "122350",
      }],
    });
    const today = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Seoul",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date()).replaceAll("-", "");

    await expect(adapter.fetchExecutions(today)).resolves.toEqual([
      expect.objectContaining({
        executionId: `${today}:49379`,
        brokerOrderId: "0255187",
        symbol: "005935",
        quantity: 2,
        price: 188_850,
      }),
    ]);
    const request = fetchImplementation.mock.calls[0]?.[1];
    const headers = new Headers(request?.headers);
    expect(headers.get("api-id")).toBe("kt00009");
    expect(JSON.parse(String(request?.body))).toMatchObject({
      qry_tp: "1",
      ord_dt: today,
      dmst_stex_tp: "KRX",
    });
  });

  it("uses the configured NXT ledger route for execution reconciliation", async () => {
    const fetchImplementation = vi.fn(async () => Response.json({
      return_code: 2000,
      return_msg: "[2000](501724:관련자료가없습니다)",
    })) as typeof fetch;
    const adapter = new KiwoomBrokerAdapter({
      environment: "live",
      quoteExchange: "NXT",
      credentials: {
        appKey: "app-key",
        appSecret: "app-secret",
        accountId: scope.accountId,
      },
      tokenStore: new MemoryTokenStore(),
      fetchImplementation,
    });
    const today = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Seoul",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date()).replaceAll("-", "");

    await expect(adapter.fetchExecutions(today)).resolves.toEqual([]);
    expect(JSON.parse(String(fetchImplementation.mock.calls[0]?.[1]?.body))).toMatchObject({
      dmst_stex_tp: "NXT",
    });
  });

  it("does not hide a different kt00009 rejection as an empty list", async () => {
    const { adapter } = createAdapter({
      return_code: 2000,
      return_msg: "[2000](999999:권한이없습니다)",
    });
    const today = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Seoul",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date()).replaceAll("-", "");

    await expect(adapter.fetchOrderHistory(today)).rejects.toMatchObject({ code: "2000" });
  });
});
