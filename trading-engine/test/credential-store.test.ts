import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  AccountScope,
  BrokerCredentials,
  CachedAccessToken,
} from "@kstock/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CredentialStore,
  EncryptedFileTokenStore,
} from "../src/security/credential-store.js";

const MASTER_KEY = "test-only-master-key-with-at-least-32-characters";
const credentials: BrokerCredentials = {
  appKey: "encrypted-app-key",
  appSecret: "encrypted-app-secret",
  accountId: "12345678",
};
const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "kstock-credentials-"));
  temporaryDirectories.push(directory);
  return directory;
}

function clearKiwoomLiveEnvironment(): void {
  vi.stubEnv("KIWOOM_LIVE_APP_KEY", "");
  vi.stubEnv("KIWOOM_LIVE_APP_SECRET", "");
  vi.stubEnv("KIWOOM_LIVE_ACCOUNT_ID", "");
  vi.stubEnv("KIWOOM_LIVE_ACCOUNT_PRODUCT_CODE", "");
  vi.stubEnv("KIWOOM_LIVE_HTS_ID", "");
}

function clearKisDerivativesLiveEnvironment(): void {
  vi.stubEnv("KIS_DERIVATIVES_LIVE_APP_KEY", "");
  vi.stubEnv("KIS_DERIVATIVES_LIVE_APP_SECRET", "");
  vi.stubEnv("KIS_DERIVATIVES_LIVE_ACCOUNT_ID", "");
  vi.stubEnv("KIS_DERIVATIVES_LIVE_ACCOUNT_PRODUCT_CODE", "");
  vi.stubEnv("KIS_DERIVATIVES_LIVE_HTS_ID", "");
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("CredentialStore encrypted file persistence", () => {
  it("encrypts credentials atomically and reports only masked status", async () => {
    clearKiwoomLiveEnvironment();
    const directory = await temporaryDirectory();
    const store = new CredentialStore(directory, MASTER_KEY);

    await store.save("kiwoom", "live", credentials);

    expect(await store.get("kiwoom", "live")).toEqual(credentials);
    expect(await store.status("kiwoom", "live")).toEqual({
      configured: true,
      source: "encrypted-file",
      maskedAccountId: "****5678",
    });

    const filename = path.join(directory, "broker-credentials.enc.json");
    const contents = await readFile(filename, "utf8");
    expect(contents).not.toContain(credentials.appKey);
    expect(contents).not.toContain(credentials.appSecret);
    expect(contents).not.toContain(credentials.accountId);
    expect(JSON.parse(contents)).toMatchObject({ version: 1 });
    if (process.platform !== "win32") {
      expect((await stat(filename)).mode & 0o777).toBe(0o600);
    }
  });

  it("serializes concurrent scope updates without losing credentials", async () => {
    clearKiwoomLiveEnvironment();
    vi.stubEnv("KIS_PAPER_APP_KEY", "");
    vi.stubEnv("KIS_PAPER_APP_SECRET", "");
    vi.stubEnv("KIS_PAPER_ACCOUNT_ID", "");
    const directory = await temporaryDirectory();
    const store = new CredentialStore(directory, MASTER_KEY);
    const kisCredentials: BrokerCredentials = {
      appKey: "kis-app-key",
      appSecret: "kis-app-secret",
      accountId: "87654321",
      accountProductCode: "01",
      htsId: "operator-id",
    };

    await Promise.all([
      store.save("kiwoom", "live", credentials),
      store.save("koreainvestment", "paper", kisCredentials),
    ]);

    expect(await store.get("kiwoom", "live")).toEqual(credentials);
    expect(await store.get("koreainvestment", "paper")).toEqual(kisCredentials);
    expect(await store.delete("kiwoom", "live")).toBe(true);
    expect(await store.delete("kiwoom", "live")).toBe(false);
    expect(await store.get("koreainvestment", "paper")).toEqual(kisCredentials);
  });

  it("keeps complete environment credentials highest-precedence and immutable", async () => {
    clearKiwoomLiveEnvironment();
    const directory = await temporaryDirectory();
    const store = new CredentialStore(directory, MASTER_KEY);
    await store.save("kiwoom", "live", credentials);

    vi.stubEnv("KIWOOM_LIVE_APP_KEY", "environment-app-key");
    vi.stubEnv("KIWOOM_LIVE_APP_SECRET", "environment-app-secret");
    vi.stubEnv("KIWOOM_LIVE_ACCOUNT_ID", "99887766");

    expect(await store.get("kiwoom", "live")).toMatchObject({
      appKey: "environment-app-key",
      appSecret: "environment-app-secret",
      accountId: "99887766",
    });
    expect(await store.status("kiwoom", "live")).toEqual({
      configured: true,
      source: "environment",
      maskedAccountId: "****7766",
    });
    await expect(store.save("kiwoom", "live", credentials)).rejects.toThrow(
      "managed by environment variables",
    );
    expect(await store.delete("kiwoom", "live")).toBe(false);

    clearKiwoomLiveEnvironment();
    expect(await store.get("kiwoom", "live")).toEqual(credentials);
  });

  it("stores the KIS derivatives account in a separate encrypted scope fixed to product 03", async () => {
    clearKisDerivativesLiveEnvironment();
    vi.stubEnv("KIS_LIVE_APP_KEY", "");
    vi.stubEnv("KIS_LIVE_APP_SECRET", "");
    vi.stubEnv("KIS_LIVE_ACCOUNT_ID", "");
    const directory = await temporaryDirectory();
    const store = new CredentialStore(directory, MASTER_KEY);
    const cashCredentials: BrokerCredentials = {
      appKey: "shared-kis-key",
      appSecret: "shared-kis-secret",
      accountId: "11112222",
      accountProductCode: "01",
    };
    const derivativeCredentials: BrokerCredentials = {
      appKey: "shared-kis-key",
      appSecret: "shared-kis-secret",
      accountId: "33334444-03",
      accountProductCode: "03",
      htsId: "operator-id",
    };

    await store.save("koreainvestment", "live", cashCredentials);
    await store.saveDerivatives("live", derivativeCredentials);

    expect(await store.get("koreainvestment", "live")).toEqual(cashCredentials);
    expect(await store.getDerivatives("live")).toEqual({
      ...derivativeCredentials,
      accountId: "33334444",
    });
    expect(await store.statusDerivatives("live")).toEqual({
      configured: true,
      source: "encrypted-file",
      maskedAccountId: "****4444",
      accountProductCode: "03",
    });
    expect(await store.deleteDerivatives("live")).toBe(true);
    expect(await store.getDerivatives("live")).toBeNull();
    expect(await store.get("koreainvestment", "live")).toEqual(cashCredentials);
  });

  it("requires a private data directory and a sufficiently strong master key", async () => {
    const directory = await temporaryDirectory();
    expect(() => new CredentialStore(undefined, MASTER_KEY)).toThrow("KSTOCK_DATA_DIR");
    expect(() => new CredentialStore(directory, "too-short")).toThrow(
      "at least 32 characters",
    );
  });
});

describe("EncryptedFileTokenStore concurrency", () => {
  it("serializes set and delete operations across store instances sharing one file", async () => {
    const directory = await temporaryDirectory();
    const first = new EncryptedFileTokenStore(directory, MASTER_KEY);
    const second = new EncryptedFileTokenStore(directory, MASTER_KEY);
    const cashScope: AccountScope = {
      brokerId: "koreainvestment",
      environment: "live",
      accountId: "11112222",
    };
    const derivativeScope: AccountScope = {
      brokerId: "koreainvestment",
      environment: "live",
      accountId: "33334444-03",
    };
    const cashToken: CachedAccessToken = {
      token: "cash-token",
      expiresAt: "2099-12-31T23:59:59.000Z",
    };
    const derivativeToken: CachedAccessToken = {
      token: "derivative-token",
      expiresAt: "2099-12-31T23:59:59.000Z",
    };

    await Promise.all([
      first.set(cashScope, cashToken),
      second.set(derivativeScope, derivativeToken),
    ]);

    await expect(first.get(cashScope)).resolves.toEqual(cashToken);
    await expect(second.get(derivativeScope)).resolves.toEqual(derivativeToken);

    await Promise.all([
      first.delete(cashScope),
      second.delete(derivativeScope),
    ]);

    await expect(first.get(cashScope)).resolves.toBeNull();
    await expect(second.get(derivativeScope)).resolves.toBeNull();
  });
});
