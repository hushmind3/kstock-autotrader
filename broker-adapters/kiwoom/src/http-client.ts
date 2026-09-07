import {
  BrokerIndeterminateError,
  BrokerRejectedError,
  BrokerTransportError,
} from "@kstock/shared";

import { KiwoomTokenManager } from "./auth.js";
import {
  KIWOOM_AUTH_RETRY_RETURN_CODES,
  KiwoomProtocolError,
} from "./errors.js";
import {
  asRecord,
  brokerNumber,
  redactText,
  stringAt,
  type UnknownRecord,
} from "./normalization.js";
import {
  KiwoomRateLimiter,
  type KiwoomRequestKind,
} from "./rate-limiter.js";

export interface KiwoomContinuation {
  contYn: string;
  nextKey: string;
}

export interface KiwoomPostRequest {
  apiId: string;
  path: string;
  body: UnknownRecord;
  kind: KiwoomRequestKind;
  continuation?: KiwoomContinuation;
}

export interface KiwoomPostResponse {
  body: UnknownRecord;
  continuation?: KiwoomContinuation;
}

export interface KiwoomHttpClientOptions {
  baseUrl: string;
  tokenManager: KiwoomTokenManager;
  rateLimiter: KiwoomRateLimiter;
  requestTimeoutMs?: number;
  fetchImplementation?: typeof fetch;
}

/**
 * Thin transport for Kiwoom's uniform POST APIs.
 *
 * Order calls are deliberately never retried here. Once bytes may have reached
 * the broker, a timeout/connection loss has an unknowable outcome and must be
 * reconciled against order/execution queries by the caller.
 */
export class KiwoomHttpClient {
  private readonly fetchImplementation: typeof fetch;
  private readonly requestTimeoutMs: number;

  constructor(private readonly options: KiwoomHttpClientOptions) {
    this.fetchImplementation = options.fetchImplementation ?? fetch;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 15_000;
  }

  async post(request: KiwoomPostRequest): Promise<KiwoomPostResponse> {
    return this.options.rateLimiter.run(request.kind, request.apiId, async () =>
      this.execute(request, false, false),
    );
  }

  private async execute(
    request: KiwoomPostRequest,
    refreshedAfterUnauthorized: boolean,
    retriedAfterRateLimit: boolean,
  ): Promise<KiwoomPostResponse> {
    const token = await this.options.tokenManager.getAccessToken(
      refreshedAfterUnauthorized,
    );
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    timeout.unref?.();

    let response: Response;
    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json;charset=UTF-8",
        authorization: `Bearer ${token}`,
        "api-id": request.apiId,
      };
      if (request.continuation !== undefined) {
        headers["cont-yn"] = request.continuation.contYn;
        headers["next-key"] = request.continuation.nextKey;
      }
      response = await this.fetchImplementation(
        `${this.options.baseUrl}${request.path}`,
        {
          method: "POST",
          headers,
          body: JSON.stringify(request.body),
          signal: controller.signal,
        },
      );
    } catch (error) {
      throw this.transportFailure(request, error);
    } finally {
      clearTimeout(timeout);
    }

    if (response.status === 401 && !refreshedAfterUnauthorized) {
      // Queries can be replayed safely after refreshing an expired token.
      // Orders cannot: a nonstandard gateway response could hide acceptance.
      if (request.kind === "order") {
        throw new BrokerIndeterminateError(
          "Kiwoom returned an authentication failure for an order; reconcile the order state before retrying.",
          "ORDER_AUTH_INDETERMINATE",
        );
      }
      await this.options.tokenManager.invalidate();
      return this.options.rateLimiter.run(request.kind, request.apiId, async () =>
        this.execute(request, true, retriedAfterRateLimit),
      );
    }

    const parsed = await safeJson(response);
    const body = asRecord(parsed);
    const returnCode = body === undefined ? undefined : brokerNumber(body.return_code);
    const returnMessage = body === undefined ? undefined : stringAt(body, "return_msg");

    if (!response.ok) {
      const message = redactText(
        returnMessage || `Kiwoom HTTP request failed with status ${response.status}.`,
        this.options.tokenManager.sensitiveValues,
      );
      if (request.kind === "order" && response.status >= 500) {
        throw new BrokerIndeterminateError(
          "Kiwoom returned a server error for an order; reconcile the order state before retrying.",
          `HTTP_${response.status}_ORDER_INDETERMINATE`,
        );
      }
      if (response.status >= 500) {
        throw new BrokerTransportError(message, `HTTP_${response.status}`);
      }
      throw new BrokerRejectedError(
        message,
        returnCode === undefined ? `HTTP_${response.status}` : String(returnCode),
      );
    }

    if (body === undefined) {
      if (request.kind === "order") {
        throw new BrokerIndeterminateError(
          "Kiwoom returned a malformed success response for an order; reconcile the order state before retrying.",
          "ORDER_MALFORMED_RESPONSE",
        );
      }
      throw new KiwoomProtocolError(
        "Kiwoom returned a malformed JSON response.",
        "MALFORMED_RESPONSE",
      );
    }

    if (
      returnCode !== undefined &&
      KIWOOM_AUTH_RETRY_RETURN_CODES.has(returnCode) &&
      !refreshedAfterUnauthorized
    ) {
      // A non-zero response is a definitive rejection, so an order was not
      // accepted. Invalidate its token for the next operation, but never replay
      // the order automatically. Read-only queries are safe to retry once.
      if (request.kind === "order") {
        void this.options.tokenManager.invalidate().catch(() => undefined);
      } else {
        await this.options.tokenManager.invalidate();
        return this.options.rateLimiter.run(request.kind, request.apiId, async () =>
          this.execute(request, true, retriedAfterRateLimit),
        );
      }
    }

    const flowLimited =
      returnCode === 5 &&
      /(?:허용된\s*(?:API\s*)?요청|유량)/.test(returnMessage ?? "");
    if (flowLimited) {
      this.options.rateLimiter.defer(request.kind, request.apiId, 1_500);
      if (request.kind !== "order" && !retriedAfterRateLimit) {
        return this.options.rateLimiter.run(request.kind, request.apiId, async () =>
          this.execute(request, refreshedAfterUnauthorized, true),
        );
      }
    }

    if (returnCode !== undefined && returnCode !== 0) {
      throw new BrokerRejectedError(
        redactText(
          returnMessage || "Kiwoom rejected the request.",
          this.options.tokenManager.sensitiveValues,
        ),
        String(returnCode),
      );
    }

    const contYn = response.headers.get("cont-yn")?.trim();
    const nextKey = response.headers.get("next-key")?.trim();
    const continuation =
      contYn !== undefined && contYn !== "" && contYn !== "N" && nextKey !== undefined && nextKey !== ""
        ? { contYn, nextKey }
        : undefined;
    return {
      body,
      ...(continuation === undefined ? {} : { continuation }),
    };
  }

  private transportFailure(
    request: KiwoomPostRequest,
    error: unknown,
  ): BrokerTransportError | BrokerIndeterminateError {
    const timeout = error instanceof DOMException && error.name === "AbortError";
    const details =
      error instanceof Error
        ? {
            name: error.name,
            message: redactText(
              error.message,
              this.options.tokenManager.sensitiveValues,
            ),
          }
        : undefined;
    if (request.kind === "order") {
      return new BrokerIndeterminateError(
        "The Kiwoom order transport ended without a definitive response; reconcile before retrying.",
        timeout ? "ORDER_TIMEOUT_INDETERMINATE" : "ORDER_TRANSPORT_INDETERMINATE",
        details,
      );
    }
    return new BrokerTransportError(
      timeout ? "Kiwoom request timed out." : "Failed to reach the Kiwoom REST API.",
      timeout ? "REQUEST_TIMEOUT" : "TRANSPORT_ERROR",
      details,
    );
  }
}

async function safeJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}
