import type {
  BrokerCredentials,
  TokenStore,
  TradingEnvironment,
} from "@kstock/shared";
import type { KisRequestLimiter } from "@kstock/broker-kis";

export type DerivativeSession = "DAY" | "NIGHT";
export type DerivativeInstrumentKind =
  | "INDEX_FUTURE"
  | "INDEX_OPTION"
  | "STOCK_FUTURE"
  | "STOCK_OPTION"
  | "COMMODITY_FUTURE";
export type DerivativeDirection = "LONG" | "SHORT";
export type DerivativePositionEffect = "OPEN" | "CLOSE";
export type DerivativeOrderType = "LIMIT" | "MARKET" | "BEST";
export type DerivativeTimeInForce = "DAY" | "IOC" | "FOK";

export interface KisDerivativeAdapterOptions {
  environment: TradingEnvironment;
  credentials: BrokerCredentials;
  tokenStore: TokenStore;
  htsId?: string;
  fetchImplementation?: typeof fetch;
  requestTimeoutMs?: number;
  queryRequestsPerSecond?: number;
  orderRequestsPerSecond?: number;
  /** Shared with the cash adapter for the same KIS app key. */
  requestLimiter?: KisRequestLimiter;
  useHashkey?: boolean;
  websocketUnsubscribeTrType?: "0" | "2";
}

export interface DerivativePosition {
  symbol: string;
  name?: string;
  direction: DerivativeDirection;
  quantity: number;
  averagePrice: number;
  currentPrice?: number;
  evaluationProfitLoss?: number;
  raw: Record<string, unknown>;
}

export interface DerivativeOrder {
  brokerOrderId: string;
  originalBrokerOrderId?: string;
  symbol: string;
  side: "BUY" | "SELL";
  requestedQuantity: number;
  filledQuantity: number;
  remainingQuantity: number;
  orderPrice?: number;
  averageFillPrice?: number;
  status: "OPEN" | "PARTIALLY_FILLED" | "FILLED" | "CANCELED" | "REJECTED";
  session: DerivativeSession;
  orderedAt?: string;
  raw: Record<string, unknown>;
}

export interface DerivativeExecution {
  brokerOrderId: string;
  executionId: string;
  symbol: string;
  side: "BUY" | "SELL";
  quantity: number;
  price: number;
  executedAt?: string;
  session: DerivativeSession;
  raw: Record<string, unknown>;
}

export interface DerivativeAccountSnapshot {
  session: DerivativeSession;
  accountId: string;
  accountProductCode: "03";
  currency: "KRW";
  depositCash?: number;
  orderableCash?: number;
  initialMargin?: number;
  maintenanceMargin?: number;
  positions: DerivativePosition[];
  openOrders: DerivativeOrder[];
  observedAt: string;
  rawSummary: Record<string, unknown>;
  /** Missing optional figures are named here instead of being synthesized. */
  unavailableFields: Array<"depositCash" | "orderableCash" | "initialMargin" | "maintenanceMargin">;
}

export interface PlaceDerivativeOrderRequest {
  symbol: string;
  instrumentKind: DerivativeInstrumentKind;
  session: DerivativeSession;
  direction: DerivativeDirection;
  positionEffect: DerivativePositionEffect;
  quantity: number;
  orderType: DerivativeOrderType;
  timeInForce?: DerivativeTimeInForce;
  limitPrice?: number;
  contactPhone?: string;
}

export interface AmendDerivativeOrderRequest {
  brokerOrderId: string;
  session: DerivativeSession;
  quantity: number;
  orderType: DerivativeOrderType;
  timeInForce?: DerivativeTimeInForce;
  limitPrice?: number;
  amendAllRemaining?: boolean;
}

export interface CancelDerivativeOrderRequest {
  brokerOrderId: string;
  session: DerivativeSession;
  quantity?: number;
  cancelAllRemaining?: boolean;
}

export interface DerivativeOrderSubmission {
  brokerOrderId: string;
  acceptedAt: string;
  session: DerivativeSession;
  side?: "BUY" | "SELL";
  positionEffect?: DerivativePositionEffect;
  direction?: DerivativeDirection;
  raw: Record<string, unknown>;
}

export interface DerivativeQuoteSubscription {
  symbol: string;
  instrumentKind: DerivativeInstrumentKind;
  session: DerivativeSession;
}

export interface DerivativeQuote {
  symbol: string;
  instrumentKind: DerivativeInstrumentKind;
  session: DerivativeSession;
  price: number;
  open?: number;
  high?: number;
  low?: number;
  cumulativeVolume?: number;
  tradingTime?: string;
  receivedAt: string;
}

/** One currently listed Mini-KOSPI200 future returned by KIS's official board API. */
export interface IndexFutureContractQuote {
  symbol: string;
  name: string;
  currentPrice?: number;
  bidPrice?: number;
  askPrice?: number;
  cumulativeVolume?: number;
  remainingDays?: number;
  raw: Record<string, unknown>;
}

export interface DerivativeDailyBar {
  tradingDate: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  raw: Record<string, unknown>;
}

export interface DerivativeOrderCapacity {
  symbol: string;
  side: "BUY" | "SELL";
  orderableQuantity?: number;
  orderableAmount?: number;
  raw: Record<string, unknown>;
  unavailableFields: Array<"orderableQuantity" | "orderableAmount">;
}

export type KisDerivativeEvent =
  | { type: "quote"; quote: DerivativeQuote }
  | { type: "order"; order: DerivativeOrder }
  | { type: "execution"; execution: DerivativeExecution }
  | { type: "connection"; connected: boolean; accountNoticesConnected: boolean; at: string }
  | { type: "error"; message: string; code?: string; at: string };
