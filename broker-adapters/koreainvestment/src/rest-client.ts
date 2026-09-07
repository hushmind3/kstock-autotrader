import {
  BrokerIndeterminateError,
  BrokerRejectedError,
  BrokerTransportError,
  type AccountScope,
  type BrokerCredentials,
  type CachedAccessToken,
  type TokenStore,
} from "@kstock/shared";
import { KIS_PATHS } from "./constants.js";
import { KisRequestLimiter, PacedLimiter, type KisRequestKind } from "./rate-limiter.js";
import type { JsonRecord, KisRestResult } from "./types.js";
import {
  asRecord,
  numberValue,
  redactSensitive,
  stringValue,
} from "./utils.js";

const TOKEN_EXPIRY_SKEW_MS = 5 * 60_000;
const TOKEN_REISSUE_GUARD_MS = 6 * 60 * 60_000;
const APPROVAL_CACHE_MS = 23 * 60 * 60_000;

interface KisAuthManagerOptions {
  baseUrl: string;
  credentials: BrokerCredentials;
  scope: AccountScope;
  tokenStore: TokenStore;
  fetchImplementation: typeof fetch;
  timeoutMs: number;
}

function isUsableToken(token: CachedAccessToken | undefined | null): token is CachedAccessToken {
  if (token === undefined || token === null || token.token.trim() === "") return false;
  const expiresAt = Date.parse(token.expiresAt);
  return Number.isFinite(expiresAt) && expiresAt - TOKEN_EXPIRY_SKEW_MS > Date.now();
}

function parseTokenExpiry(body: JsonRecord): string {
  const explicit = stringValue(body.access_token_token_expired);
  if (explicit !== "") {
    const iso = explicit.includes("T")
      ? explicit
      : `${explicit.replace(" ", "T")}+09:00`;
    const timestamp = Date.parse(iso);
    if (Number.isFinite(timestamp)) return new Date(timestamp).toISOString();
  }
  const expiresInSeconds = numberValue(body.expires_in);
  if (expiresInSeconds > 0) {
    return new Date(Date.now() + expiresInSeconds * 1_000).toISOString();
  }
  throw new BrokerTransportError(
    "KIS token response did not contain a valid expiry",
    "KIS_TOKEN_MALFORMED",
  );
}

async function readJson(response: Response): Promise<JsonRecord> {
  const text = await response.text();
  if (text.trim() === "") return {};
  try {
    return asRecord(JSON.parse(text));
  } catch (error) {
    throw new BrokerTransportError(
      "KIS returned a non-JSON response",
      "KIS_RESPONSE_JSON",
      error instanceof Error ? { name: error.name } : undefined,
    );
  }
}

export class KisAuthManager {
  readonly #baseUrl: string;
  readonly #credentials: BrokerCredentials;
  readonly #scope: AccountScope;
  readonly #tokenStore: TokenStore;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  readonly #authLimiter = new PacedLimiter(1);
  #cachedToken?: CachedAccessToken;
  #tokenPromise?: Promise<CachedAccessToken>;
  #refreshPromise?: Promise<CachedAccessToken>;
  #lastIssuedAt?: number;
  #approval?: { value: string; expiresAt: number };
  #approvalPromise?: Promise<string>;

  constructor(options: KisAuthManagerOptions) {
    this.#baseUrl = options.baseUrl;
    this.#credentials = options.credentials;
    this.#scope = options.scope;
    this.#tokenStore = options.tokenStore;
    this.#fetch = options.fetchImplementation;
    this.#timeoutMs = options.timeoutMs;
  }

  async accessToken(): Promise<string> {
    if (this.#refreshPromise !== undefined) {
      return (await this.#refreshPromise).token;
    }
    if (isUsableToken(this.#cachedToken)) return this.#cachedToken.token;
    const stored = await this.#tokenStore.get(this.#scope);
    if (isUsableToken(stored)) {
      this.#cachedToken = stored;
      return stored.token;
    }
    const token = await this.#issueTokenSingleFlight();
    this.#cachedToken = token;
    return token.token;
  }

  async forceRefreshAfterDefinitiveAuthFailure(rejectedToken: string): Promise<string> {
    if (
      isUsableToken(this.#cachedToken) &&
      this.#cachedToken.token !== rejectedToken
    ) {
      return this.#cachedToken.token;
    }
    if (this.#refreshPromise !== undefined) {
      return (await this.#refreshPromise).token;
    }

    const refresh = this.#refreshRejectedToken(rejectedToken);
    this.#refreshPromise = refresh;
    try {
      return (await refresh).token;
    } finally {
      if (this.#refreshPromise === refresh) this.#refreshPromise = undefined;
    }
  }

  async approvalKey(): Promise<string> {
    if (this.#approval !== undefined && this.#approval.expiresAt > Date.now()) {
      return this.#approval.value;
    }
    if (this.#approvalPromise !== undefined) return this.#approvalPromise;
    this.#approvalPromise = this.#issueApproval();
    try {
      return await this.#approvalPromise;
    } finally {
      this.#approvalPromise = undefined;
    }
  }

  async #issueToken(): Promise<CachedAccessToken> {
    if (
      this.#lastIssuedAt !== undefined &&
      Date.now() - this.#lastIssuedAt < TOKEN_REISSUE_GUARD_MS
    ) {
      throw new BrokerRejectedError(
        "KIS token reissuance was requested inside the six-hour guard window",
        "KIS_TOKEN_REISSUE_GUARD",
      );
    }
    await this.#authLimiter.acquire();
    const body = await this.#postCredentialGrant(KIS_PATHS.accessToken, {
      grant_type: "client_credentials",
      appkey: this.#credentials.appKey,
      appsecret: this.#credentials.appSecret,
    });
    const accessToken = stringValue(body.access_token);
    if (accessToken === "") {
      throw new BrokerRejectedError(
        stringValue(body.error_description) || "KIS token issuance was rejected",
        stringValue(body.error_code) || "KIS_TOKEN_REJECTED",
        redactSensitive(body),
      );
    }
    const cached: CachedAccessToken = {
      token: accessToken,
      expiresAt: parseTokenExpiry(body),
    };
    const tokenType = stringValue(body.token_type);
    if (tokenType !== "") cached.tokenType = tokenType;
    await this.#tokenStore.set(this.#scope, cached);
    this.#lastIssuedAt = Date.now();
    return cached;
  }

  async #issueTokenSingleFlight(): Promise<CachedAccessToken> {
    if (this.#tokenPromise !== undefined) return this.#tokenPromise;
    const issue = this.#issueToken();
    this.#tokenPromise = issue;
    try {
      return await issue;
    } finally {
      if (this.#tokenPromise === issue) this.#tokenPromise = undefined;
    }
  }

  async #refreshRejectedToken(rejectedToken: string): Promise<CachedAccessToken> {
    if (
      isUsableToken(this.#cachedToken) &&
      this.#cachedToken.token !== rejectedToken
    ) {
      return this.#cachedToken;
    }
    if (this.#tokenPromise !== undefined) {
      const issued = await this.#tokenPromise;
      if (issued.token !== rejectedToken) {
        this.#cachedToken = issued;
        return issued;
      }
    }

    const stored = await this.#tokenStore.get(this.#scope);
    if (isUsableToken(stored) && stored.token !== rejectedToken) {
      this.#cachedToken = stored;
      return stored;
    }
    if (
      this.#lastIssuedAt !== undefined &&
      Date.now() - this.#lastIssuedAt < TOKEN_REISSUE_GUARD_MS
    ) {
      throw new BrokerRejectedError(
        "KIS rejected a recently issued token; automatic reissuance is suppressed by the six-hour guard",
        "KIS_TOKEN_REISSUE_GUARD",
      );
    }

    if (this.#cachedToken?.token === rejectedToken) this.#cachedToken = undefined;
    if (stored?.token === rejectedToken) await this.#tokenStore.delete(this.#scope);
    const issued = await this.#issueTokenSingleFlight();
    this.#cachedToken = issued;
    return issued;
  }

  async #issueApproval(): Promise<string> {
    await this.#authLimiter.acquire();
    const body = await this.#postCredentialGrant(KIS_PATHS.approval, {
      grant_type: "client_credentials",
      appkey: this.#credentials.appKey,
      secretkey: this.#credentials.appSecret,
    });
    const approval = stringValue(body.approval_key);
    if (approval === "") {
      throw new BrokerRejectedError(
        stringValue(body.msg1) || "KIS websocket approval was rejected",
        stringValue(body.msg_cd) || "KIS_APPROVAL_REJECTED",
        redactSensitive(body),
      );
    }
    this.#approval = { value: approval, expiresAt: Date.now() + APPROVAL_CACHE_MS };
    return approval;
  }

  async #postCredentialGrant(path: string, payload: JsonRecord): Promise<JsonRecord> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.#timeoutMs);
    try {
      const response = await this.#fetch(`${this.#baseUrl}${path}`, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          Accept: "application/json",
        },
        body: JSON.stringify(payload),
      });
      const body = await readJson(response);
      if (!response.ok) {
        throw new BrokerRejectedError(
          stringValue(body.error_description) ||
            `KIS credential endpoint returned HTTP ${response.status}`,
          stringValue(body.error_code) || "KIS_AUTH_HTTP",
          redactSensitive(body),
        );
      }
      return body;
    } catch (error) {
      if (error instanceof BrokerRejectedError || error instanceof BrokerTransportError) {
        throw error;
      }
      throw new BrokerTransportError(
        "KIS credential endpoint was unreachable",
        "KIS_AUTH_TRANSPORT",
        error instanceof Error ? { name: error.name, message: error.message } : undefined,
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}

interface KisRestClientOptions extends KisAuthManagerOptions {
  limiter: KisRequestLimiter;
  useHashkey: boolean;
}

export interface KisRestRequest {
  path: string;
  method: "GET" | "POST";
  trId: string;
  kind: KisRequestKind;
  query?: Record<string, string>;
  body?: JsonRecord;
  trContinuation?: string;
  mutation?: boolean;
  hashkey?: boolean;
}

export class KisRestClient {
  readonly #baseUrl: string;
  readonly #credentials: BrokerCredentials;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  readonly #limiter: KisRequestLimiter;
  readonly #useHashkey: boolean;
  readonly auth: KisAuthManager;

  constructor(options: KisRestClientOptions) {
    this.#baseUrl = options.baseUrl;
    this.#credentials = options.credentials;
    this.#fetch = options.fetchImplementation;
    this.#timeoutMs = options.timeoutMs;
    this.#limiter = options.limiter;
    this.#useHashkey = options.useHashkey;
    this.auth = new KisAuthManager(options);
  }

  async request(
    request: KisRestRequest,
    refreshedAfterAuthFailure = false,
  ): Promise<KisRestResult> {
    const token = await this.auth.accessToken();
    let hashkey: string | undefined;
    if ((request.hashkey ?? this.#useHashkey) && request.body !== undefined) {
      hashkey = await this.createHashkey(request.body, token);
    }
    await this.#limiter.acquire(request.kind);

    const url = new URL(`${this.#baseUrl}${request.path}`);
    for (const [key, value] of Object.entries(request.query ?? {})) {
      url.searchParams.set(key, value);
    }
    const headers: Record<string, string> = {
      "Content-Type": "application/json; charset=utf-8",
      Accept: "application/json",
      authorization: `Bearer ${token}`,
      appkey: this.#credentials.appKey,
      appsecret: this.#credentials.appSecret,
      tr_id: request.trId,
      custtype: "P",
      "User-Agent": "kstock-autotrader/0.1",
    };
    if (request.trContinuation !== undefined && request.trContinuation !== "") {
      headers.tr_cont = request.trContinuation;
    }
    if (hashkey !== undefined) headers.hashkey = hashkey;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.#timeoutMs);
    let response: Response;
    try {
      const init: RequestInit = {
        method: request.method,
        signal: controller.signal,
        headers,
      };
      if (request.body !== undefined) init.body = JSON.stringify(request.body);
      response = await this.#fetch(url, init);
    } catch (error) {
      clearTimeout(timeout);
      const details =
        error instanceof Error ? { name: error.name, message: error.message } : undefined;
      if (request.mutation === true) {
        throw new BrokerIndeterminateError(
          "KIS order transport failed after dispatch; reconcile orders before retrying",
          "KIS_ORDER_INDETERMINATE",
          details,
        );
      }
      throw new BrokerTransportError(
        "KIS REST transport failed",
        "KIS_REST_TRANSPORT",
        details,
      );
    }

    try {
      let body: JsonRecord;
      try {
        body = await readJson(response);
      } catch (error) {
        if (request.mutation === true) {
          throw new BrokerIndeterminateError(
            "KIS order response could not be decoded; reconcile orders before retrying",
            "KIS_ORDER_INDETERMINATE",
          );
        }
        throw error;
      }

      const responseCode = stringValue(body.msg_cd);
      if (response.status === 429 || responseCode === "EGW00201") {
        this.#limiter.defer(request.kind, 2_000, true);
      } else if (responseCode === "EGW00215") {
        // Account-ledger limits are stricter than the general REST ceiling.
        this.#limiter.defer("account", 3_000);
      }
      const tokenExpired = response.status === 401 || responseCode === "EGW00123";
      if (tokenExpired && request.mutation !== true && !refreshedAfterAuthFailure) {
        await this.auth.forceRefreshAfterDefinitiveAuthFailure(token);
        return this.request(request, true);
      }

      if (!response.ok) {
        const message =
          stringValue(body.msg1) || `KIS REST returned HTTP ${response.status}`;
        const code = responseCode || `HTTP_${response.status}`;
        if (request.mutation === true && (response.status === 408 || response.status >= 500)) {
          throw new BrokerIndeterminateError(
            `${message}; reconcile orders before retrying`,
            code,
            redactSensitive(body),
          );
        }
        if (response.status === 429 || response.status >= 500) {
          throw new BrokerTransportError(message, code, redactSensitive(body));
        }
        throw new BrokerRejectedError(message, code, redactSensitive(body));
      }

      const rtCode = stringValue(body.rt_cd);
      if (rtCode !== "0") {
        throw new BrokerRejectedError(
          stringValue(body.msg1) || "KIS rejected the request",
          responseCode || rtCode || "KIS_REJECTED",
          redactSensitive(body),
        );
      }
      const result: KisRestResult = { body, status: response.status };
      const continuation = response.headers.get("tr_cont")?.trim();
      if (continuation !== undefined && continuation !== "") {
        result.trContinuation = continuation;
      }
      return result;
    } finally {
      clearTimeout(timeout);
    }
  }

  async createHashkey(body: JsonRecord, accessToken?: string): Promise<string> {
    const token = accessToken ?? (await this.auth.accessToken());
    await this.#limiter.acquire("query");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.#timeoutMs);
    try {
      const response = await this.#fetch(`${this.#baseUrl}${KIS_PATHS.hashkey}`, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          Accept: "application/json",
          authorization: `Bearer ${token}`,
          appkey: this.#credentials.appKey,
          appsecret: this.#credentials.appSecret,
          "User-Agent": "kstock-autotrader/0.1",
        },
        body: JSON.stringify(body),
      });
      const responseBody = await readJson(response);
      const hash = stringValue(responseBody.HASH);
      if (!response.ok || hash === "") {
        throw new BrokerRejectedError(
          stringValue(responseBody.msg1) || "KIS hashkey request was rejected",
          stringValue(responseBody.msg_cd) || "KIS_HASHKEY_REJECTED",
          redactSensitive(responseBody),
        );
      }
      return hash;
    } catch (error) {
      if (error instanceof BrokerRejectedError || error instanceof BrokerTransportError) {
        throw error;
      }
      throw new BrokerTransportError(
        "KIS hashkey endpoint was unreachable; no order was sent",
        "KIS_HASHKEY_TRANSPORT",
        error instanceof Error ? { name: error.name, message: error.message } : undefined,
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}
