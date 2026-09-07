import type {
  CachedAccessToken,
  TokenStore,
} from "@kstock/shared";
import { describe, expect, it, vi } from "vitest";

import { KiwoomBrokerAdapter } from "../src/adapter.js";

const accountRoot = "01234567";

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

function createAdapter(configuredAccountId: string, availableAccounts: string) {
  const fetchImplementation = vi.fn(async () => Response.json({
    return_code: 0,
    acctNo: availableAccounts,
  })) as typeof fetch;
  return new KiwoomBrokerAdapter({
    environment: "live",
    credentials: {
      appKey: "app-key",
      appSecret: "app-secret",
      accountId: configuredAccountId,
    },
    tokenStore: new MemoryTokenStore(),
    fetchImplementation,
    webSocketFactory: () => {
      throw new Error("WebSocket must not open when account verification fails");
    },
  });
}

describe("Kiwoom configured account verification", () => {
  it("rejects an ambiguous 8-digit root instead of choosing one full account", async () => {
    const adapter = createAdapter(
      accountRoot,
      `${accountRoot}01;${accountRoot}02`,
    );

    await expect(adapter.connect()).rejects.toMatchObject({
      code: "ACCOUNT_SCOPE_AMBIGUOUS",
    });
  });

  it("does not accept a different full account that merely shares the root", async () => {
    const adapter = createAdapter(`${accountRoot}01`, `${accountRoot}02`);

    await expect(adapter.connect()).rejects.toMatchObject({
      code: "ACCOUNT_SCOPE_MISMATCH",
    });
  });
});
