import { BrokerAdapterError } from "@kstock/shared";

/** Official Kiwoom authentication-expiry return codes. */
export const KIWOOM_AUTH_RETRY_RETURN_CODES = new Set([8005, 8031, 8103]);

export class KiwoomProtocolError extends BrokerAdapterError {
  readonly retryable = false;
}
