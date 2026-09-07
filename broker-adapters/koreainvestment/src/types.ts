import type { BrokerAdapterOptions, Exchange } from "@kstock/shared";
import type { KisWebSocketUnsubscribeTrType } from "./constants.js";
import type { KisRequestLimiter } from "./rate-limiter.js";

export type JsonRecord = Record<string, unknown>;

export interface KisBrokerAdapterOptions extends BrokerAdapterOptions {
  /** KIS HTS user id. Required for H0STCNI0/H0STCNI9 account notices. */
  htsId?: string;
  useHashkey?: boolean;
  requestTimeoutMs?: number;
  webSocketUnsubscribeTrType?: KisWebSocketUnsubscribeTrType;
  masterUrl?: string;
  fetchImplementation?: typeof fetch;
  /** Share one limiter between cash and derivatives when they use the same KIS app key. */
  requestLimiter?: KisRequestLimiter;
}

export interface KisRestResult {
  body: JsonRecord;
  status: number;
  trContinuation?: string;
}

export interface KisAmendableOrder {
  branchOrderNumber: string;
  brokerOrderId: string;
  originalBrokerOrderId?: string;
  symbol: string;
  amendableQuantity: number;
  raw: JsonRecord;
}

export interface KisAdapterDiagnostics {
  environment: "live" | "paper";
  quoteExchange: Exchange;
  restBaseUrl: string;
  webSocketUrl: string;
  quoteSubscriptionCount: number;
  quoteSubscriptionLimit: number;
  accountNoticeConfigured: boolean;
  useHashkey: boolean;
  websocketUnsubscribeTrType: KisWebSocketUnsubscribeTrType;
}
