import type {
  AccountScope,
  CachedAccessToken,
  TokenStore,
} from "@kstock/shared";
import { BrokerRejectedError } from "@kstock/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

import { KiwoomTokenManager } from "../src/auth.js";
import { KiwoomHttpClient } from "../src/http-client.js";
import { KiwoomRateLimiter } from "../src/rate-limiter.js";

const scope: AccountScope = {
  brokerId: "kiwoom",
  environment: "paper",
  accountId: "12345678",
};

class MemoryTokenStore implements TokenStore {
  token: CachedAccessToken | null = {
    token: "cached-token",
    expiresAt: "2099-12-31T23:59:59.000Z",
  };
  readonly deleted = vi.fn();

  async get(): Promise<CachedAccessToken | null> {
    return this.token;
  }

  async set(_scope: AccountScope, token: CachedAccessToken): Promise<void> {
    this.token = token;
  }

  async delete(): Promise<void> {
    this.deleted();
    this.token = null;
  }
}

function createClient(fetchImplementation: typeof fetch, tokenStore: TokenStore) {
  const tokenManager = new KiwoomTokenManager({
    baseUrl: "https://example.test",
    scope,
    credentials: {
      appKey: "app-key",
      appSecret: "app-secret",
      accountId: scope.accountId,
    },
    tokenStore,
    fetchImplementation,
  });
  return new KiwoomHttpClient({
    baseUrl: "https://example.test",
    tokenManager,
    rateLimiter: new KiwoomRateLimiter({
      paper: false,
      queryRequestsPerSecond: 100,
      orderRequestsPerSecond: 100,
    }),
    fetchImplementation,
  });
}

describe("KiwoomHttpClient authentication recovery", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("refreshes and retries a read-only request once for an official expiry code", async () => {
    const tokenStore = new MemoryTokenStore();
    let apiCalls = 0;
    let oauthCalls = 0;
    const fetchImplementation = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/oauth2/token")) {
        oauthCalls += 1;
        return Response.json({
          return_code: 0,
          token: "refreshed-token",
          expires_dt: "20991231235959",
        });
      }
      apiCalls += 1;
      return Response.json(
        apiCalls === 1
          ? { return_code: 8005, return_msg: "token expired" }
          : { return_code: 0, value: "ok" },
      );
    }) as typeof fetch;

    const response = await createClient(fetchImplementation, tokenStore).post({
      apiId: "ka10099",
      path: "/api/dostk/stkinfo",
      kind: "query",
      body: { mrkt_tp: "0" },
    });

    expect(response.body.value).toBe("ok");
    expect(apiCalls).toBe(2);
    expect(oauthCalls).toBe(1);
    expect(tokenStore.deleted).toHaveBeenCalledOnce();
  });

  it("never replays an order rejected with an authentication-expiry code", async () => {
    const tokenStore = new MemoryTokenStore();
    let apiCalls = 0;
    const fetchImplementation = vi.fn(async () => {
      apiCalls += 1;
      return Response.json({ return_code: 8005, return_msg: "token expired" });
    }) as typeof fetch;

    const request = createClient(fetchImplementation, tokenStore).post({
      apiId: "kt10000",
      path: "/api/dostk/ordr",
      kind: "order",
      body: { stk_cd: "005930", ord_qty: "1" },
    });

    await expect(request).rejects.toMatchObject<Partial<BrokerRejectedError>>({
      code: "8005",
    });
    expect(apiCalls).toBe(1);
  });

  it("briefly cools down and retries a flow-limited read-only query once", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const tokenStore = new MemoryTokenStore();
    let apiCalls = 0;
    const fetchImplementation = vi.fn(async () => {
      apiCalls += 1;
      return Response.json(
        apiCalls === 1
          ? {
              return_code: 5,
              return_msg: "허용된 요청 개수를 초과하였습니다[유량=5]",
            }
          : { return_code: 0, value: "ok" },
      );
    }) as typeof fetch;

    const request = createClient(fetchImplementation, tokenStore).post({
      apiId: "ka10095",
      path: "/api/dostk/stkinfo",
      kind: "query",
      body: { stk_cd: "005930" },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(apiCalls).toBe(1);
    await vi.advanceTimersByTimeAsync(1_499);
    expect(apiCalls).toBe(1);
    await vi.advanceTimersByTimeAsync(2);

    await expect(request).resolves.toMatchObject({ body: { value: "ok" } });
    expect(apiCalls).toBe(2);
  });

  it("never replays a flow-limited order", async () => {
    const tokenStore = new MemoryTokenStore();
    let apiCalls = 0;
    const fetchImplementation = vi.fn(async () => {
      apiCalls += 1;
      return Response.json({
        return_code: 5,
        return_msg: "허용된 요청 개수를 초과하였습니다[유량=5]",
      });
    }) as typeof fetch;

    const request = createClient(fetchImplementation, tokenStore).post({
      apiId: "kt10000",
      path: "/api/dostk/ordr",
      kind: "order",
      body: { stk_cd: "005930", ord_qty: "1" },
    });

    await expect(request).rejects.toMatchObject<Partial<BrokerRejectedError>>({
      code: "5",
    });
    expect(apiCalls).toBe(1);
  });
});
