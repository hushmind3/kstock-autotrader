import type {
  AccountScope,
  CachedAccessToken,
  TokenStore,
} from "@kstock/shared";
import { describe, expect, it, vi } from "vitest";

import { KisRequestLimiter } from "../src/rate-limiter.js";
import { KisRestClient } from "../src/rest-client.js";

class MutableTokenStore implements TokenStore {
  token: CachedAccessToken | null = {
    token: "stale-token",
    expiresAt: "2099-12-31T23:59:59.000Z",
  };

  async get(_scope: AccountScope): Promise<CachedAccessToken | null> {
    return this.token;
  }

  async set(_scope: AccountScope, token: CachedAccessToken): Promise<void> {
    this.token = token;
  }

  async delete(_scope: AccountScope): Promise<void> {
    this.token = null;
  }
}

describe("KisRestClient authentication recovery", () => {
  it("refreshes one rejected token once when parallel queries fail at different times", async () => {
    const tokenStore = new MutableTokenStore();
    const staleResponses: Array<(response: Response) => void> = [];
    let tokenIssues = 0;
    let freshQueries = 0;

    const rejected = () => Response.json(
      { rt_cd: "1", msg_cd: "EGW00123", msg1: "기간이 만료된 token 입니다." },
      { status: 401 },
    );
    const accepted = () => Response.json({
      rt_cd: "0",
      msg_cd: "MCA00000",
      output: { value: "ok" },
    });

    const fetchImplementation = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/oauth2/tokenP")) {
        tokenIssues += 1;
        return Response.json({
          access_token: "fresh-token",
          token_type: "Bearer",
          expires_in: 86_400,
        });
      }

      const authorization = new Headers(init?.headers).get("authorization");
      if (authorization === "Bearer stale-token") {
        return new Promise<Response>((resolve) => {
          staleResponses.push(resolve);
          if (staleResponses.length === 2) staleResponses[0]?.(rejected());
        });
      }
      if (authorization === "Bearer fresh-token") {
        freshQueries += 1;
        // Let the second stale response arrive only after the first request has
        // refreshed, reproducing the late parallel 401 that used to hit KIS's
        // six-hour token reissue guard.
        if (freshQueries === 1) staleResponses[1]?.(rejected());
        return accepted();
      }
      throw new Error(`unexpected authorization: ${authorization ?? "none"}`);
    }) as typeof fetch;

    const client = new KisRestClient({
      baseUrl: "https://openapi.koreainvestment.com:9443",
      credentials: {
        appKey: "app-key",
        appSecret: "app-secret",
        accountId: "12345678",
        accountProductCode: "01",
      },
      scope: {
        brokerId: "koreainvestment",
        environment: "live",
        accountId: "12345678-01",
      },
      tokenStore,
      fetchImplementation,
      timeoutMs: 1_000,
      limiter: new KisRequestLimiter(100_000, 100_000, 100_000),
      useHashkey: false,
    });

    const request = {
      path: "/uapi/domestic-stock/v1/trading/inquire-balance",
      method: "GET" as const,
      trId: "TTTC8434R",
      kind: "query" as const,
    };
    const results = await Promise.all([client.request(request), client.request(request)]);

    expect(results).toHaveLength(2);
    expect(results.every((result) => result.body.rt_cd === "0")).toBe(true);
    expect(tokenIssues).toBe(1);
    expect(freshQueries).toBe(2);
    expect(tokenStore.token?.token).toBe("fresh-token");
  });
});
