import type {
  AccountScope,
  BrokerEvent,
  CachedAccessToken,
  Exchange,
  TokenStore,
} from "@kstock/shared";
import { describe, expect, it, vi } from "vitest";

import { KiwoomBrokerAdapter } from "../src/adapter.js";

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
