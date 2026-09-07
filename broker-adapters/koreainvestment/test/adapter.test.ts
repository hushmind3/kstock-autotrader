import type {
  AccountScope,
  CachedAccessToken,
  Exchange,
  TokenStore,
} from "@kstock/shared";
import { describe, expect, it, vi } from "vitest";

import { KoreaInvestmentBrokerAdapter } from "../src/adapter.js";
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
