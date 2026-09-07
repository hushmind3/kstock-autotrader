import type { AccountScope, CachedAccessToken, TokenStore } from "@kstock/shared";
import { describe, expect, it } from "vitest";
import { KoreaInvestmentDerivativeAdapter } from "../src/adapter.js";
import { KIS_DERIVATIVE_TR_IDS } from "../src/constants.js";
import { parseDerivativeNoticeFields, parseDerivativeTradeFields } from "../src/websocket-client.js";

class MemoryTokenStore implements TokenStore {
  value: CachedAccessToken | null = null;
  async get(_scope: AccountScope): Promise<CachedAccessToken | null> { return this.value; }
  async set(_scope: AccountScope, token: CachedAccessToken): Promise<void> { this.value = token; }
  async delete(_scope: AccountScope): Promise<void> { this.value = null; }
}

interface CapturedRequest {
  url: string;
  method: string;
  trId: string;
  body?: Record<string, unknown>;
}

function json(body: Record<string, unknown>, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function fixtureAdapter(options?: {
  environment?: "live" | "paper";
  balanceRows?: Array<Record<string, unknown>>;
  orderRows?: Array<Record<string, unknown>>;
  futuresBoardRows?: Array<Record<string, unknown>>;
  dailyBarRows?: Array<Record<string, unknown>>;
  capacityOutput?: Record<string, unknown>;
}) {
  const captured: CapturedRequest[] = [];
  const balanceRows = options?.balanceRows ?? [];
  const orderRows = options?.orderRows ?? [];
  const fetchImplementation: typeof fetch = async (input, init) => {
    const url = String(input);
    const request: CapturedRequest = {
      url,
      method: init?.method ?? "GET",
      trId: new Headers(init?.headers).get("tr_id") ?? "",
    };
    if (typeof init?.body === "string") request.body = JSON.parse(init.body) as Record<string, unknown>;
    captured.push(request);
    if (url.includes("/oauth2/tokenP")) {
      return json({ access_token: "token", expires_in: 86_400, token_type: "Bearer" });
    }
    if (url.includes("inquire-balance") || url.includes("inquire-ngt-balance")) {
      return json({
        rt_cd: "0",
        output1: balanceRows,
        output2: {
          dnca_cash: "10000000",
          ord_psbl_cash: "9000000",
          mgna_tota: "1200000",
          mmga_tot_amt: "900000",
        },
        ctx_area_fk200: "",
        ctx_area_nk200: "",
      });
    }
    if (url.includes("inquire-ccnl") || url.includes("inquire-ngt-ccnl")) {
      return json({ rt_cd: "0", output1: orderRows, output2: {}, ctx_area_fk200: "", ctx_area_nk200: "" });
    }
    if (url.includes("display-board-futures")) {
      return json({ rt_cd: "0", output: options?.futuresBoardRows ?? [] });
    }
    if (url.includes("inquire-daily-fuopchartprice")) {
      return json({ rt_cd: "0", output1: {}, output2: options?.dailyBarRows ?? [] });
    }
    if (url.includes("inquire-psbl-order") || url.includes("inquire-psbl-ngt-order")) {
      return json({ rt_cd: "0", output: options?.capacityOutput ?? {} });
    }
    if (url.endsWith("/order") || url.includes("order-rvsecncl")) {
      return json({ rt_cd: "0", output: { ODNO: "0000012345", ORD_TMD: "101500" } });
    }
    if (url.includes("inquire-price")) {
      return json({ rt_cd: "0", output1: { futs_prpr: "351.25" } });
    }
    throw new Error(`Unexpected request ${url}`);
  };
  const adapter = new KoreaInvestmentDerivativeAdapter({
    environment: options?.environment ?? "live",
    credentials: {
      appKey: "app-key",
      appSecret: "app-secret",
      accountId: "12345678",
      accountProductCode: "03",
    },
    tokenStore: new MemoryTokenStore(),
    fetchImplementation,
  });
  return { adapter, captured };
}

describe("KoreaInvestmentDerivativeAdapter", () => {
  it("refuses a cash product code instead of silently reusing product 01", () => {
    expect(() => new KoreaInvestmentDerivativeAdapter({
      environment: "live",
      credentials: {
        appKey: "key",
        appSecret: "secret",
        accountId: "12345678",
        accountProductCode: "01",
      },
      tokenStore: new MemoryTokenStore(),
    })).toThrow(/product code 03/i);
  });

  it("refuses an embedded cash product code even when explicit product 03 is supplied", () => {
    expect(() => new KoreaInvestmentDerivativeAdapter({
      environment: "live",
      credentials: {
        appKey: "key",
        appSecret: "secret",
        accountId: "12345678-01",
        accountProductCode: "03",
      },
      tokenStore: new MemoryTokenStore(),
    })).toThrow(/must end with product code 03/i);
  });

  it("refuses account text containing characters other than digits and hyphens", () => {
    expect(() => new KoreaInvestmentDerivativeAdapter({
      environment: "live",
      credentials: {
        appKey: "key",
        appSecret: "secret",
        accountId: "abc1234-5678xyz",
        accountProductCode: "03",
      },
      tokenStore: new MemoryTokenStore(),
    })).toThrow(/only digits and hyphens/i);
  });

  it("loads product-03 cash, margin, positions and open orders without invented values", async () => {
    const { adapter, captured } = fixtureAdapter({
      balanceRows: [{
        pdno: "101W09",
        prdt_name: "코스피200 선물",
        sll_buy_dvsn_name: "매수",
        cblc_qty: "2",
        lqd_psbl_qty: "2",
        ccld_avg_unpr1: "350.10",
        idx_clpr: "351.25",
        evlu_pfls_amt: "575000",
      }],
      orderRows: [{
        odno: "0000001001",
        pdno: "101W09",
        sll_buy_dvsn_cd: "01",
        ord_qty: "2",
        tot_ccld_qty: "1",
        qty: "1",
        ord_idx: "352.00",
        avg_idx: "351.75",
      }],
    });
    const snapshot = await adapter.fetchAccountSnapshot("DAY");
    expect(snapshot.accountProductCode).toBe("03");
    expect(snapshot.depositCash).toBe(10_000_000);
    expect(snapshot.initialMargin).toBe(1_200_000);
    expect(snapshot.maintenanceMargin).toBe(900_000);
    expect(snapshot.positions[0]).toMatchObject({
      symbol: "101W09",
      direction: "LONG",
      quantity: 2,
      averagePrice: 350.1,
    });
    expect(snapshot.openOrders[0]).toMatchObject({
      status: "PARTIALLY_FILLED",
      remainingQuantity: 1,
      orderPrice: 352,
      averageFillPrice: 351.75,
    });
    expect(captured.some((request) => request.trId === KIS_DERIVATIVE_TR_IDS.live.dayBalance)).toBe(true);
    expect(captured.every((request) => request.body?.ACNT_PRDT_CD !== "01")).toBe(true);
  });

  it("single-flights refresh when parallel account queries reject the same cached token", async () => {
    const tokenStore = new MemoryTokenStore();
    tokenStore.value = {
      token: "rejected-cached-token",
      expiresAt: "2099-12-31T23:59:59.000Z",
    };
    let tokenIssues = 0;
    let oldTokenRequests = 0;
    let refreshedTokenRequests = 0;
    const fetchImplementation: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.includes("/oauth2/tokenP")) {
        tokenIssues += 1;
        return json({ access_token: "refreshed-token", expires_in: 86_400 });
      }

      const authorization = new Headers(init?.headers).get("authorization");
      if (authorization === "Bearer rejected-cached-token") {
        oldTokenRequests += 1;
        if (url.includes("inquire-ccnl")) {
          await new Promise((resolve) => setTimeout(resolve, 120));
        }
        return new Response(JSON.stringify({
          rt_cd: "1",
          msg_cd: "EGW00123",
          msg1: "expired token",
        }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        });
      }

      expect(authorization).toBe("Bearer refreshed-token");
      refreshedTokenRequests += 1;
      return json({
        rt_cd: "0",
        output1: [],
        output2: {},
        ctx_area_fk200: "",
        ctx_area_nk200: "",
      });
    };
    const adapter = new KoreaInvestmentDerivativeAdapter({
      environment: "live",
      credentials: {
        appKey: "app-key",
        appSecret: "app-secret",
        accountId: "12345678",
        accountProductCode: "03",
      },
      tokenStore,
      fetchImplementation,
    });

    await expect(adapter.fetchAccountSnapshot("DAY")).resolves.toMatchObject({
      accountId: "12345678-03",
      accountProductCode: "03",
      positions: [],
      openOrders: [],
    });
    expect(tokenIssues).toBe(1);
    expect(oldTokenRequests).toBe(2);
    expect(refreshedTokenRequests).toBe(2);
    expect(tokenStore.value?.token).toBe("refreshed-token");
  });

  it("submits a real night OPEN SHORT as an explicit sell after a position preflight", async () => {
    const { adapter, captured } = fixtureAdapter();
    const result = await adapter.placeOrder({
      symbol: "101W09",
      instrumentKind: "INDEX_FUTURE",
      session: "NIGHT",
      direction: "SHORT",
      positionEffect: "OPEN",
      quantity: 1,
      orderType: "MARKET",
    });
    expect(result).toMatchObject({
      brokerOrderId: "0000012345",
      session: "NIGHT",
      direction: "SHORT",
      positionEffect: "OPEN",
      side: "SELL",
    });
    const mutation = captured.find((request) => request.url.endsWith("/order"));
    expect(mutation?.trId).toBe("STTN1101U");
    expect(mutation?.body).toMatchObject({
      ACNT_PRDT_CD: "03",
      SLL_BUY_DVSN_CD: "01",
      ORD_QTY: "1",
      UNIT_PRICE: "0",
      ORD_DVSN_CD: "02",
    });
  });

  it("fails closed when the same symbol already has a remaining open order", async () => {
    const { adapter, captured } = fixtureAdapter({
      orderRows: [{
        odno: "0000001001",
        pdno: "101W09",
        sll_buy_dvsn_cd: "02",
        ord_qty: "2",
        tot_ccld_qty: "1",
        nccs_qty: "1",
        ord_idx: "351.00",
      }],
    });

    await expect(adapter.placeOrder({
      symbol: "101W09",
      instrumentKind: "INDEX_FUTURE",
      session: "DAY",
      direction: "LONG",
      positionEffect: "OPEN",
      quantity: 1,
      orderType: "MARKET",
    })).rejects.toThrow(/still has 1 contracts open/i);

    expect(captured.some((request) => request.url.endsWith("/order"))).toBe(false);
    expect(captured.some((request) => request.url.includes("inquire-ccnl"))).toBe(true);
  });

  it("fails closed when OPEN LONG would actually offset a held short", async () => {
    const { adapter, captured } = fixtureAdapter({
      balanceRows: [{
        pdno: "101W09",
        sll_buy_dvsn_cd: "01",
        cblc_qty: "1",
        lqd_psbl_qty: "1",
        ccld_avg_unpr1: "351.00",
      }],
    });
    await expect(adapter.placeOrder({
      symbol: "101W09",
      instrumentKind: "INDEX_FUTURE",
      session: "DAY",
      direction: "LONG",
      positionEffect: "OPEN",
      quantity: 1,
      orderType: "MARKET",
    })).rejects.toThrow(/explicit close order/i);
    expect(captured.some((request) => request.url.endsWith("/order"))).toBe(false);
  });

  it("fails closed when a CLOSE LONG exceeds the live position", async () => {
    const { adapter, captured } = fixtureAdapter({
      balanceRows: [{
        pdno: "101W09",
        sll_buy_dvsn_cd: "02",
        cblc_qty: "1",
        lqd_psbl_qty: "1",
        ccld_avg_unpr1: "351.00",
      }],
    });
    await expect(adapter.placeOrder({
      symbol: "101W09",
      instrumentKind: "INDEX_FUTURE",
      session: "DAY",
      direction: "LONG",
      positionEffect: "CLOSE",
      quantity: 2,
      orderType: "MARKET",
    })).rejects.toThrow(/only 1 contracts/i);
    expect(captured.some((request) => request.url.endsWith("/order"))).toBe(false);
  });

  it("submits CLOSE LONG as a sell only after confirming the held long", async () => {
    const { adapter, captured } = fixtureAdapter({
      balanceRows: [{
        pdno: "101W09",
        sll_buy_dvsn_cd: "02",
        cblc_qty: "2",
        lqd_psbl_qty: "2",
        ccld_avg_unpr1: "351.00",
      }],
    });
    const result = await adapter.placeOrder({
      symbol: "101W09",
      instrumentKind: "INDEX_FUTURE",
      session: "DAY",
      direction: "LONG",
      positionEffect: "CLOSE",
      quantity: 1,
      orderType: "MARKET",
    });
    expect(result).toMatchObject({ direction: "LONG", positionEffect: "CLOSE", side: "SELL" });
    expect(captured.find((request) => request.url.endsWith("/order"))?.body).toMatchObject({
      SLL_BUY_DVSN_CD: "01",
      ACNT_PRDT_CD: "03",
    });
  });

  it("uses liquidation-available quantity rather than gross balance for CLOSE", async () => {
    const { adapter, captured } = fixtureAdapter({
      balanceRows: [{
        shtn_pdno: "101W09",
        pdno: "101W09",
        sll_buy_dvsn_name: "매수",
        cblc_qty: "3",
        lqd_psbl_qty: "1",
        ccld_avg_unpr1: "351.00",
      }],
    });
    await expect(adapter.placeOrder({
      symbol: "101W09",
      instrumentKind: "INDEX_FUTURE",
      session: "DAY",
      direction: "LONG",
      positionEffect: "CLOSE",
      quantity: 2,
      orderType: "MARKET",
    })).rejects.toThrow(/only 1 contracts are available to liquidate/i);
    expect(captured.some((request) => request.url.endsWith("/order"))).toBe(false);
  });

  it("fails closed when KIS omits liquidation-available quantity", async () => {
    const { adapter, captured } = fixtureAdapter({
      balanceRows: [{
        shtn_pdno: "101W09",
        sll_buy_dvsn_cd: "02",
        cblc_qty: "2",
        ccld_avg_unpr1: "351.00",
      }],
    });
    await expect(adapter.placeOrder({
      symbol: "101W09",
      instrumentKind: "INDEX_FUTURE",
      session: "DAY",
      direction: "LONG",
      positionEffect: "CLOSE",
      quantity: 1,
      orderType: "MARKET",
    })).rejects.toThrow(/liquidation-available quantity/i);
    expect(captured.some((request) => request.url.endsWith("/order"))).toBe(false);
  });

  it("maps every supported order style to the official three KIS order-code fields", async () => {
    const cases = [
      { orderType: "LIMIT" as const, timeInForce: "DAY" as const, limitPrice: 350.25, expected: ["01", "0", "01", "350.25"] },
      { orderType: "LIMIT" as const, timeInForce: "IOC" as const, limitPrice: 350.25, expected: ["01", "3", "10", "350.25"] },
      { orderType: "LIMIT" as const, timeInForce: "FOK" as const, limitPrice: 350.25, expected: ["01", "4", "11", "350.25"] },
      { orderType: "MARKET" as const, timeInForce: "DAY" as const, expected: ["02", "0", "02", "0"] },
      { orderType: "MARKET" as const, timeInForce: "IOC" as const, expected: ["02", "3", "12", "0"] },
      { orderType: "MARKET" as const, timeInForce: "FOK" as const, expected: ["02", "4", "13", "0"] },
      { orderType: "BEST" as const, timeInForce: "DAY" as const, expected: ["04", "0", "04", "0"] },
      { orderType: "BEST" as const, timeInForce: "IOC" as const, expected: ["04", "3", "14", "0"] },
      { orderType: "BEST" as const, timeInForce: "FOK" as const, expected: ["04", "4", "15", "0"] },
    ];
    for (const item of cases) {
      const { adapter, captured } = fixtureAdapter();
      await adapter.placeOrder({
        symbol: "101W09",
        instrumentKind: "INDEX_FUTURE",
        session: "DAY",
        direction: "LONG",
        positionEffect: "OPEN",
        quantity: 1,
        orderType: item.orderType,
        timeInForce: item.timeInForce,
        ...(item.limitPrice === undefined ? {} : { limitPrice: item.limitPrice }),
      });
      const body = captured.find((request) => request.url.endsWith("/order"))?.body;
      expect([
        body?.NMPR_TYPE_CD,
        body?.KRX_NMPR_CNDT_CD,
        body?.ORD_DVSN_CD,
        body?.UNIT_PRICE,
      ]).toEqual(item.expected);
    }
  });

  it("parses official order-history quantity and average-index fields", async () => {
    const { adapter, captured } = fixtureAdapter({
      orderRows: [{
        ord_dt: "20260905",
        ord_tmd: "101500",
        odno: "0000001001",
        pdno: "101W09",
        sll_buy_dvsn_cd: "02",
        ord_qty: "3",
        qty: "1",
        tot_ccld_qty: "2",
        ord_idx: "351.00",
        avg_idx: "350.75",
      }],
    });
    const executions = await adapter.fetchExecutions("DAY", "20260905", "20260905");
    expect(executions).toHaveLength(1);
    expect(executions[0]).toMatchObject({
      brokerOrderId: "0000001001",
      quantity: 2,
      price: 350.75,
    });
    expect(executions[0]?.executedAt).toBeUndefined();
    expect(captured.find((request) => request.url.includes("inquire-ccnl"))?.url)
      .toContain("CCLD_NCCS_DVSN=01");
  });

  it("uses the official live night amend/cancel TR IDs", async () => {
    const { adapter, captured } = fixtureAdapter();
    await adapter.amendOrder({
      brokerOrderId: "0000001001",
      session: "NIGHT",
      quantity: 1,
      orderType: "LIMIT",
      limitPrice: 350.25,
    });
    await adapter.cancelOrder({
      brokerOrderId: "0000001002",
      session: "NIGHT",
      cancelAllRemaining: true,
    });
    const mutations = captured.filter((request) => request.url.includes("order-rvsecncl"));
    expect(mutations.map((request) => request.trId)).toEqual(["TTTN1103U", "TTTN1103U"]);
    expect(mutations[0]?.body).toMatchObject({ RVSE_CNCL_DVSN_CD: "01", UNIT_PRICE: "350.25" });
    expect(mutations[1]?.body).toMatchObject({ RVSE_CNCL_DVSN_CD: "02", RMN_QTY_YN: "Y", ORD_QTY: "0" });
  });

  it("rejects paper-night operations before reaching the broker", async () => {
    const { adapter, captured } = fixtureAdapter({ environment: "paper" });
    await expect(adapter.fetchAccountSnapshot("NIGHT")).rejects.toThrow(/paper-night/i);
    expect(captured).toEqual([]);
  });

  it("keeps live and paper account-notice TR IDs distinct", () => {
    expect(KIS_DERIVATIVE_TR_IDS.realtime.notice.day).toBe("H0IFCNI0");
    expect(KIS_DERIVATIVE_TR_IDS.realtime.notice.paperDay).toBe("H0IFCNI9");
  });

  it("uses the official derivative quote endpoint and market selector", async () => {
    const { adapter, captured } = fixtureAdapter();
    const quote = await adapter.fetchQuote("101W09", "INDEX_FUTURE");
    expect(quote.price).toBe(351.25);
    const request = captured.find((item) => item.url.includes("inquire-price"));
    expect(request?.trId).toBe("FHMIF10000000");
    expect(request?.url).toContain("FID_COND_MRKT_DIV_CODE=F");
  });

  it("loads and sorts Mini-KOSPI200 contracts from the official futures board request", async () => {
    const { adapter, captured } = fixtureAdapter({
      futuresBoardRows: [
        {
          futs_shrn_iscd: "105V7000",
          hts_kor_isnm: "미니코스피200 12월물",
          futs_prpr: "352.15",
          futs_bidp: "352.10",
          futs_askp: "352.20",
          acml_vol: "12500",
          hts_rmnn_dynu: "91",
        },
        {
          futs_shrn_iscd: "105V6000",
          hts_kor_isnm: "미니코스피200 9월물",
          futs_prpr: "351.25",
          futs_bidp: "351.20",
          futs_askp: "351.30",
          acml_vol: "55000",
          hts_rmnn_dynu: "7",
        },
        { futs_shrn_iscd: "", hts_kor_isnm: "잘못된 행" },
      ],
    });

    await expect(adapter.fetchMiniKospi200Contracts()).resolves.toEqual([
      expect.objectContaining({
        symbol: "105V6000",
        name: "미니코스피200 9월물",
        currentPrice: 351.25,
        bidPrice: 351.2,
        askPrice: 351.3,
        cumulativeVolume: 55_000,
        remainingDays: 7,
      }),
      expect.objectContaining({ symbol: "105V7000", remainingDays: 91 }),
    ]);
    const request = captured.find((item) => item.url.includes("display-board-futures"));
    expect(request?.trId).toBe("FHPIF05030200");
    expect(request?.url).toContain("FID_COND_MRKT_DIV_CODE=F");
    expect(request?.url).toContain("FID_COND_SCR_DIV_CODE=20503");
    expect(request?.url).toContain("FID_COND_MRKT_CLS_CODE=MKI");
  });

  it("loads valid completed futures bars with the official daily-chart TR and dates", async () => {
    const { adapter, captured } = fixtureAdapter({
      dailyBarRows: [
        {
          stck_bsop_date: "20260905",
          futs_oprc: "350.00",
          futs_hgpr: "352.00",
          futs_lwpr: "349.50",
          futs_prpr: "351.25",
          acml_vol: "12000",
        },
        {
          stck_bsop_date: "20260904",
          futs_oprc: "348.00",
          futs_hgpr: "351.00",
          futs_lwpr: "347.50",
          futs_prpr: "350.00",
          acml_vol: "10000",
        },
        { stck_bsop_date: "bad", futs_prpr: "999" },
      ],
    });

    await expect(adapter.fetchDailyBars("105V6000", "20260801", "20260905")).resolves.toEqual([
      expect.objectContaining({
        tradingDate: "20260904",
        open: 348,
        high: 351,
        low: 347.5,
        close: 350,
        volume: 10_000,
      }),
      expect.objectContaining({ tradingDate: "20260905", close: 351.25, volume: 12_000 }),
    ]);
    const request = captured.find((item) => item.url.includes("inquire-daily-fuopchartprice"));
    expect(request?.trId).toBe("FHKIF03020100");
    expect(request?.url).toContain("FID_INPUT_ISCD=105V6000");
    expect(request?.url).toContain("FID_INPUT_DATE_1=20260801");
    expect(request?.url).toContain("FID_INPUT_DATE_2=20260905");
    expect(request?.url).toContain("FID_PERIOD_DIV_CODE=D");
  });

  it.each([
    ["live day", "live", "DAY", "TTTO5105R", "inquire-psbl-order"],
    ["paper day", "paper", "DAY", "VTTO5105R", "inquire-psbl-order"],
    ["live night", "live", "NIGHT", "STTN5105R", "inquire-psbl-ngt-order"],
  ] as const)("uses the official %s order-capacity request", async (
    _label,
    environment,
    session,
    trId,
    path,
  ) => {
    const { adapter, captured } = fixtureAdapter({
      environment,
      capacityOutput: { ord_psbl_qty: "3", ord_psbl_amt: "52500000" },
    });

    await expect(adapter.fetchOrderCapacity({
      symbol: "105V6000",
      session,
      side: "SELL",
      orderType: "LIMIT",
      limitPrice: 350.25,
    })).resolves.toMatchObject({
      symbol: "105V6000",
      side: "SELL",
      orderableQuantity: 3,
      orderableAmount: 52_500_000,
      unavailableFields: [],
    });
    const request = captured.find((item) => item.url.includes(path));
    expect(request?.trId).toBe(trId);
    expect(request?.url).toContain("CANO=12345678");
    expect(request?.url).toContain("ACNT_PRDT_CD=03");
    expect(request?.url).toContain("PDNO=105V6000");
    expect(request?.url).toContain("SLL_BUY_DVSN_CD=01");
    expect(request?.url).toContain("UNIT_PRICE=350.25");
    expect(request?.url).toContain("ORD_DVSN_CD=01");
    if (session === "NIGHT") expect(request?.url).toContain("PRDT_TYPE_CD=301");
  });

  it("does not invent missing account summary amounts", async () => {
    const captured: CapturedRequest[] = [];
    const adapter = new KoreaInvestmentDerivativeAdapter({
      environment: "live",
      credentials: { appKey: "key", appSecret: "secret", accountId: "12345678-03" },
      tokenStore: new MemoryTokenStore(),
      fetchImplementation: async (input, init) => {
        const url = String(input);
        captured.push({ url, method: init?.method ?? "GET", trId: new Headers(init?.headers).get("tr_id") ?? "" });
        if (url.includes("tokenP")) return json({ access_token: "token", expires_in: 86_400 });
        return json({ rt_cd: "0", output1: [], output2: {}, ctx_area_fk200: "", ctx_area_nk200: "" });
      },
    });
    const snapshot = await adapter.fetchAccountSnapshot("DAY");
    expect(snapshot.depositCash).toBeUndefined();
    expect(snapshot.initialMargin).toBeUndefined();
    expect(snapshot.unavailableFields).toEqual([
      "depositCash",
      "orderableCash",
      "initialMargin",
      "maintenanceMargin",
    ]);
    expect(captured.length).toBeGreaterThan(0);
  });
});

describe("KIS derivative websocket parsers", () => {
  it("parses the official H0IFCNT0 index-future layout", () => {
    const fields = Array.from({ length: 50 }, () => "0");
    fields[0] = "101W09";
    fields[1] = "101530";
    fields[5] = "351.25";
    fields[6] = "349.50";
    fields[7] = "352.00";
    fields[8] = "348.75";
    fields[10] = "12500";
    expect(parseDerivativeTradeFields("H0IFCNT0", fields)).toMatchObject({
      symbol: "101W09",
      instrumentKind: "INDEX_FUTURE",
      session: "DAY",
      price: 351.25,
      open: 349.5,
      cumulativeVolume: 12_500,
    });
  });

  it("uses the separate official widths and price fields for night and stock futures", () => {
    const night = Array.from({ length: 49 }, () => "0");
    night[0] = "101W9000";
    night[5] = "352.50";
    expect(parseDerivativeTradeFields("H0MFCNT0", night)).toMatchObject({
      session: "NIGHT",
      instrumentKind: "INDEX_FUTURE",
      price: 352.5,
    });

    const stock = Array.from({ length: 49 }, () => "0");
    stock[0] = "A01W09";
    stock[2] = "12500";
    expect(parseDerivativeTradeFields("H0ZFCNT0", stock)).toMatchObject({
      session: "DAY",
      instrumentKind: "STOCK_FUTURE",
      price: 12_500,
    });
  });

  it("parses day execution notices into both order and execution events", () => {
    const fields = Array.from({ length: 22 }, () => "");
    fields[2] = "0000001001";
    fields[4] = "02";
    fields[6] = "0";
    fields[7] = "101W09";
    fields[8] = "1";
    fields[9] = "351.25";
    fields[10] = "101530";
    fields[11] = "0";
    fields[12] = "2";
    fields[15] = "1";
    fields[21] = "351.25";
    const parsed = parseDerivativeNoticeFields("H0IFCNI0", fields, "2026-09-05T01:15:30.000Z");
    expect(parsed.order).toMatchObject({ side: "BUY", status: "FILLED", session: "DAY" });
    expect(parsed.execution).toMatchObject({ quantity: 1, price: 351.25 });
  });

  it("does not turn a positive-price order acknowledgement into a phantom fill", () => {
    const fields = Array.from({ length: 22 }, () => "");
    fields[2] = "0000001002";
    fields[4] = "02";
    fields[6] = "L";
    fields[7] = "101W09";
    fields[8] = "2";
    fields[9] = "352.00";
    fields[10] = "101531";
    fields[11] = "0";
    fields[12] = "1";
    fields[13] = "1";
    fields[15] = "0";
    fields[21] = "352.00";
    const parsed = parseDerivativeNoticeFields("H0IFCNI0", fields);
    expect(parsed.order).toMatchObject({
      requestedQuantity: 2,
      filledQuantity: 0,
      remainingQuantity: 2,
      orderPrice: 352,
      status: "OPEN",
    });
    expect(parsed.execution).toBeUndefined();
  });

  it("recognizes cancel and rejection acknowledgements without emitting executions", () => {
    const canceled = Array.from({ length: 22 }, () => "");
    canceled[2] = "0000001003";
    canceled[3] = "0000001001";
    canceled[4] = "01";
    canceled[5] = "2";
    canceled[6] = "L";
    canceled[7] = "101W09";
    canceled[8] = "1";
    canceled[9] = "351.00";
    canceled[10] = "101532";
    canceled[11] = "0";
    canceled[12] = "1";
    canceled[13] = "1";
    canceled[15] = "0";
    const canceledResult = parseDerivativeNoticeFields("H0IFCNI0", canceled);
    expect(canceledResult.order).toMatchObject({
      originalBrokerOrderId: "0000001001",
      status: "CANCELED",
      remainingQuantity: 0,
    });
    expect(canceledResult.execution).toBeUndefined();

    const rejected = [...canceled];
    rejected[2] = "0000001004";
    rejected[11] = "1";
    const rejectedResult = parseDerivativeNoticeFields("H0IFCNI0", rejected);
    expect(rejectedResult.order.status).toBe("REJECTED");
    expect(rejectedResult.order.remainingQuantity).toBe(1);
    expect(rejectedResult.execution).toBeUndefined();
  });

  it("parses paper and night notice layouts and dates them in Korea time", () => {
    const paper = Array.from({ length: 22 }, () => "");
    paper[2] = "0000001005";
    paper[4] = "02";
    paper[6] = "L";
    paper[7] = "101W09";
    paper[8] = "1";
    paper[9] = "350.00";
    paper[10] = "153000";
    paper[15] = "0";
    expect(parseDerivativeNoticeFields("H0IFCNI9", paper).order.session).toBe("DAY");

    const night = Array.from({ length: 19 }, () => "");
    night[2] = "0000001006";
    night[4] = "01";
    night[6] = "0";
    night[7] = "101W9000";
    night[8] = "1";
    night[9] = "353.00";
    night[10] = "000500";
    night[12] = "2";
    night[15] = "2";
    const parsed = parseDerivativeNoticeFields("H0MFCNI0", night, "2026-09-05T15:05:00.000Z");
    expect(parsed.order).toMatchObject({
      session: "NIGHT",
      status: "PARTIALLY_FILLED",
      orderedAt: "2026-09-06T00:05:00+09:00",
    });
    expect(parsed.execution).toMatchObject({ quantity: 1, price: 353 });
  });

  it("rejects unknown notice kinds instead of guessing from positive quantity and price", () => {
    const fields = Array.from({ length: 22 }, () => "");
    fields[2] = "0000001007";
    fields[4] = "02";
    fields[6] = "";
    fields[7] = "101W09";
    fields[8] = "1";
    fields[9] = "351.25";
    fields[15] = "1";
    expect(() => parseDerivativeNoticeFields("H0IFCNI0", fields)).toThrow(/order-kind discriminator/i);
    expect(() => parseDerivativeNoticeFields("UNKNOWN", fields)).toThrow(/unsupported.*notice/i);
  });
});
