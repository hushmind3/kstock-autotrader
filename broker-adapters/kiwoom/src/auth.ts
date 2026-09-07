import {
  BrokerRejectedError,
  BrokerTransportError,
  type AccountScope,
  type BrokerCredentials,
  type CachedAccessToken,
  type TokenStore,
} from "@kstock/shared";

import { asRecord, brokerNumber, redactText, stringAt } from "./normalization.js";

export interface KiwoomTokenManagerOptions {
  baseUrl: string;
  scope: AccountScope;
  credentials: BrokerCredentials;
  tokenStore: TokenStore;
  requestTimeoutMs?: number;
  fetchImplementation?: typeof fetch;
}

const TOKEN_REFRESH_SKEW_MS = 60_000;

export class KiwoomTokenManager {
  private cached: CachedAccessToken | undefined;
  private refreshPromise: Promise<CachedAccessToken> | undefined;
  private readonly fetchImplementation: typeof fetch;
  private readonly requestTimeoutMs: number;

  constructor(private readonly options: KiwoomTokenManagerOptions) {
    this.fetchImplementation = options.fetchImplementation ?? fetch;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 15_000;
  }

  get sensitiveValues(): readonly string[] {
    return [
      this.options.credentials.appKey,
      this.options.credentials.appSecret,
      this.options.credentials.accountId,
      ...(this.cached === undefined ? [] : [this.cached.token]),
    ];
  }

  async getAccessToken(forceRefresh = false): Promise<string> {
    if (!forceRefresh) {
      const cached = await this.loadCachedToken();
      if (cached !== undefined && isTokenFresh(cached)) return cached.token;
    }
    if (this.refreshPromise === undefined) {
      this.refreshPromise = this.issueToken().finally(() => {
        this.refreshPromise = undefined;
      });
    }
    return (await this.refreshPromise).token;
  }

  async invalidate(): Promise<void> {
    this.cached = undefined;
    try {
      await this.options.tokenStore.delete(this.options.scope);
    } catch (error) {
      throw new BrokerTransportError(
        "Failed to clear the cached Kiwoom access token.",
        "TOKEN_STORE_ERROR",
        safeErrorDetails(error, this.sensitiveValues),
      );
    }
  }

  private async loadCachedToken(): Promise<CachedAccessToken | undefined> {
    if (this.cached !== undefined) return this.cached;
    let stored: CachedAccessToken | null;
    try {
      stored = await this.options.tokenStore.get(this.options.scope);
    } catch (error) {
      throw new BrokerTransportError(
        "Failed to read the cached Kiwoom access token.",
        "TOKEN_STORE_ERROR",
        safeErrorDetails(error, this.sensitiveValues),
      );
    }
    if (stored !== null) this.cached = stored;
    return this.cached;
  }

  private async issueToken(): Promise<CachedAccessToken> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    timeout.unref?.();
    let response: Response;
    try {
      response = await this.fetchImplementation(`${this.options.baseUrl}/oauth2/token`, {
        method: "POST",
        headers: { "Content-Type": "application/json;charset=UTF-8" },
        body: JSON.stringify({
          grant_type: "client_credentials",
          appkey: this.options.credentials.appKey,
          secretkey: this.options.credentials.appSecret,
        }),
        signal: controller.signal,
      });
    } catch (error) {
      throw new BrokerTransportError(
        "Failed to reach the Kiwoom OAuth endpoint.",
        error instanceof DOMException && error.name === "AbortError"
          ? "OAUTH_TIMEOUT"
          : "OAUTH_TRANSPORT_ERROR",
        safeErrorDetails(error, this.sensitiveValues),
      );
    } finally {
      clearTimeout(timeout);
    }

    const parsed = await parseJsonResponse(response);
    const record = asRecord(parsed);
    const returnCode = record === undefined ? undefined : brokerNumber(record.return_code);
    const returnMessage =
      record === undefined ? undefined : stringAt(record, "return_msg");
    if (!response.ok || (returnCode !== undefined && returnCode !== 0)) {
      throw new BrokerRejectedError(
        redactText(returnMessage || "Kiwoom rejected the OAuth request.", this.sensitiveValues),
        returnCode === undefined ? `HTTP_${response.status}` : String(returnCode),
      );
    }
    if (record === undefined) {
      throw new BrokerTransportError(
        "Kiwoom OAuth returned a malformed response.",
        "OAUTH_MALFORMED_RESPONSE",
      );
    }
    const token = stringAt(record, "token");
    const expiresRaw = stringAt(record, "expires_dt");
    const expiresAt = expiresRaw === undefined ? undefined : parseKiwoomExpiry(expiresRaw);
    if (token === undefined || token.length === 0 || expiresAt === undefined) {
      throw new BrokerTransportError(
        "Kiwoom OAuth omitted the token or its expiry.",
        "OAUTH_MALFORMED_RESPONSE",
      );
    }
    const tokenType = stringAt(record, "token_type");
    const cached: CachedAccessToken = {
      token,
      expiresAt,
      ...(tokenType === undefined ? {} : { tokenType }),
    };
    try {
      await this.options.tokenStore.set(this.options.scope, cached);
    } catch (error) {
      throw new BrokerTransportError(
        "Kiwoom authenticated, but its access token could not be stored safely.",
        "TOKEN_STORE_ERROR",
        safeErrorDetails(error, [...this.sensitiveValues, token]),
      );
    }
    this.cached = cached;
    return cached;
  }
}

function isTokenFresh(token: CachedAccessToken): boolean {
  const expiresAt = Date.parse(token.expiresAt);
  return Number.isFinite(expiresAt) && expiresAt - Date.now() > TOKEN_REFRESH_SKEW_MS;
}

function parseKiwoomExpiry(value: string): string | undefined {
  if (/^\d{14}$/.test(value)) {
    const iso = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T${value.slice(8, 10)}:${value.slice(10, 12)}:${value.slice(12, 14)}+09:00`;
    const parsed = new Date(iso);
    return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

async function parseJsonResponse(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

function safeErrorDetails(error: unknown, sensitiveValues: readonly string[]): unknown {
  if (!(error instanceof Error)) return undefined;
  return {
    name: error.name,
    message: redactText(error.message, sensitiveValues),
  };
}
