import type {
  AccountScope,
  CachedAccessToken,
  Exchange,
  TokenStore,
} from "@kstock/shared";
import { describe, expect, it, vi } from "vitest";

import {
  KoreaInvestmentBrokerAdapter,
  kisCashOrderFields,
} from "../src/adapter.js";
import {
  KIS_QUOTE_MARKET_CODE,
  KIS_REALTIME_TRADE_TR_ID,
} from "../src/constants.js";

class MemoryTokenStore implements TokenStore {
  async get(_scope: AccountScope): Promise<CachedAccessToken> {
    return {
      token: "cached-token",
      expiresAt: "2099-12-31T23:59:59.000Z",
    };
  }

  async set(): Promise<void> {}
  async delete(): Promise<void> {}
}

function createAdapter(exchange: Exchange, output: Record<string, unknown>) {
  const fetchImplementation = vi.fn(async () => Response.json({
    rt_cd: "0",
    msg_cd: "MCA00000",
    output,
  })) as typeof fetch;
  const adapter = new KoreaInvestmentBrokerAdapter({
    environment: "live",
    quoteExchange: exchange,
    credentials: {
      appKey: "app-key",
      appSecret: "app-secret",
      accountId: "12345678",
      accountProductCode: "01",
    },
    tokenStore: new MemoryTokenStore(),
    fetchImplementation,
  });
  return { adapter, fetchImplementation };
}

describe("KIS official KOSPI index", () => {
  it("loads the KOSPI composite change from the domestic index endpoint", async () => {
    const { adapter, fetchImplementation } = createAdapter("KRX", {
      bstp_nmix_prpr: "3312.45",
      bstp_nmix_prdy_vrss: "18.25",
      prdy_vrss_sign: "5",
      bstp_nmix_prdy_ctrt: "0.55",
    });

    await expect(adapter.fetchKospiIndex()).resolves.toMatchObject({
      indexCode: "KOSPI",
      currentValue: 3312.45,
      change: -18.25,
      changeRateBps: -55,
      direction: "DOWN",
      source: "koreainvestment",
    });
    const requestUrl = new URL(String(fetchImplementation.mock.calls[0]?.[0]));
    expect(requestUrl.pathname).toBe("/uapi/domestic-stock/v1/quotations/inquire-index-price");
    expect(requestUrl.searchParams.get("FID_COND_MRKT_DIV_CODE")).toBe("U");
    expect(requestUrl.searchParams.get("FID_INPUT_ISCD")).toBe("0001");
    expect(fetchImplementation.mock.calls[0]?.[1]?.headers).toMatchObject({
      tr_id: "FHPUP02100000",
    });
  });
});

describe("KIS domestic-stock quote routing", () => {
  it("maps engine routes to the official REST and websocket market identifiers", () => {
    expect(KIS_QUOTE_MARKET_CODE).toEqual({ KRX: "J", NXT: "NX", SOR: "UN" });
    expect(KIS_REALTIME_TRADE_TR_ID).toEqual({
      KRX: "H0STCNT0",
      NXT: "H0NXCNT0",
      SOR: "H0UNCNT0",
    });
  });

  for (const [exchange, marketCode] of [
    ["KRX", "J"],
    ["NXT", "NX"],
    ["SOR", "UN"],
  ] as const) {
    it(`requests ${exchange} current prices with ${marketCode}`, async () => {
      const { adapter, fetchImplementation } = createAdapter(exchange, {
        stck_prpr: "70000",
        acml_vol: "123456",
      });

      await expect(adapter.fetchQuote("005930")).resolves.toMatchObject({
        symbol: "005930",
        exchange,
        price: 70_000,
      });
      const requestUrl = new URL(String(fetchImplementation.mock.calls[0]?.[0]));
      expect(requestUrl.searchParams.get("FID_COND_MRKT_DIV_CODE")).toBe(marketCode);
      expect(requestUrl.searchParams.get("FID_INPUT_ISCD")).toBe("005930");
    });
  }

  it("rejects NXT market data in paper trading", () => {
    expect(() => new KoreaInvestmentBrokerAdapter({
      environment: "paper",
      quoteExchange: "NXT",
      credentials: {
        appKey: "app-key",
        appSecret: "app-secret",
        accountId: "12345678",
        accountProductCode: "01",
      },
      tokenStore: new MemoryTokenStore(),
    })).toThrow(/paper trading supports KRX market data/i);
  });
});

describe("KIS KRX aftermarket cash-order mapping", () => {
  const atKst = (value: string): Date => new Date(`${value}+09:00`);

  it.each([
    ["2026-09-13T16:00:00", false, "01"],
    ["2026-09-14T15:59:59", false, "01"],
    ["2026-09-14T16:00:00", true, "44"],
    ["2026-09-14T19:59:59", true, "44"],
    ["2026-09-14T20:00:00", false, "01"],
  ] as const)(
    "maps a market intent at %s (aftermarket=%s)",
    (timestamp, krxAftermarket, orderDivisionCode) => {
      expect(kisCashOrderFields("market", undefined, "KRX", atKst(timestamp))).toEqual({
        orderDivisionCode,
        orderPrice: "0",
        krxAftermarket,
      });
    },
  );

  it("uses KIS code 41 and the supplied price for a KRX aftermarket limit", () => {
    expect(kisCashOrderFields(
      "limit",
      70_000,
      "KRX",
      atKst("2026-09-14T16:00:00"),
    )).toEqual({
      orderDivisionCode: "41",
      orderPrice: "70000",
      krxAftermarket: true,
    });
  });

  it("does not apply KRX aftermarket order codes to SOR or NXT", () => {
    const now = atKst("2026-09-14T16:00:00");
    expect(kisCashOrderFields("market", undefined, "SOR", now).orderDivisionCode).toBe("01");
    expect(kisCashOrderFields("limit", 70_000, "NXT", now)).toMatchObject({
      orderDivisionCode: "00",
      orderPrice: "70000",
      krxAftermarket: false,
    });
  });

  it("submits KIS code 44 for a KRX aftermarket market-order intent", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(atKst("2026-09-14T16:00:00"));
    try {
      const { adapter, fetchImplementation } = createAdapter("KRX", {
        KRX_FWDG_ORD_ORGNO: "001",
        ODNO: "0000123",
        ORD_TMD: "160000",
      });

      await expect(adapter.placeOrder({
        clientOrderId: "aftermarket-market-intent",
        symbol: "005930",
        side: "buy",
        orderType: "market",
        quantity: 1,
        exchange: "KRX",
      })).resolves.toMatchObject({ outcome: "ACCEPTED" });

      const request = fetchImplementation.mock.calls[0]?.[1];
      expect(JSON.parse(String(request?.body))).toMatchObject({
        PDNO: "005930",
        ORD_DVSN: "44",
        ORD_QTY: "1",
        ORD_UNPR: "0",
        EXCG_ID_DVSN_CD: "KRX",
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
