export const BROKER_IDS = ["kiwoom", "koreainvestment"] as const;
export type BrokerId = (typeof BROKER_IDS)[number];
export type TradingEnvironment = "live" | "paper";
export type Market = "KOSPI";
export type Exchange = "KRX" | "NXT" | "SOR";

export interface AccountScope {
  brokerId: BrokerId;
  environment: TradingEnvironment;
  accountId: string;
}

export interface Instrument {
  symbol: string;
  name: string;
  market: Market;
  exchange: Exchange;
  active: boolean;
  listedDate?: string;
  delistedDate?: string;
  raw?: unknown;
}

export interface DailyBar {
  symbol: string;
  tradingDate: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  adjusted: boolean;
}

export interface MarketCalendarDay {
  tradingDate: string;
  isOpen: boolean;
}

export interface Quote {
  symbol: string;
  price: number;
  open?: number;
  high?: number;
  low?: number;
  cumulativeVolume: number;
  tradingDate: string;
  tradingTime: string;
  receivedAt: string;
  source: BrokerId;
  /** Market-data route used for this quote. SOR means a consolidated KRX/NXT feed. */
  exchange?: Exchange;
  /** True only when both the trading date and time came from broker payload fields. */
  brokerTimestampVerified?: boolean;
  stale?: boolean;
}

export type OrderSide = "buy" | "sell";
export type OrderType = "market" | "limit";
export type OrderStatus =
  | "QUEUED"
  | "SENDING"
  | "ACKED"
  | "PARTIALLY_FILLED"
  | "FILLED"
  | "CANCEL_REQUESTED"
  | "CANCELED"
  | "AMEND_REQUESTED"
  | "AMENDED"
  | "REJECTED"
  | "UNKNOWN";

export interface PlaceOrderRequest {
  clientOrderId: string;
  symbol: string;
  side: OrderSide;
  orderType: OrderType;
  quantity: number;
  limitPrice?: number;
  exchange: Exchange;
}

export interface AmendOrderRequest {
  clientOrderId: string;
  brokerOrderId: string;
  symbol: string;
  remainingQuantity: number;
  newLimitPrice: number;
  exchange: Exchange;
}

export interface CancelOrderRequest {
  clientOrderId: string;
  brokerOrderId: string;
  symbol: string;
  remainingQuantity: number;
  exchange: Exchange;
}

export interface OrderSubmissionResult {
  outcome: "ACCEPTED" | "REJECTED" | "INDETERMINATE";
  brokerOrderId?: string;
  originalBrokerOrderId?: string;
  message?: string;
  code?: string;
  raw?: unknown;
}

export interface BrokerPosition {
  symbol: string;
  name?: string;
  quantity: number;
  availableQuantity: number;
  averagePrice: number;
  currentPrice: number;
  marketValue: number;
  unrealizedPnl: number;
  unrealizedPnlBps: number;
}

export interface BrokerOrder {
  brokerOrderId: string;
  originalBrokerOrderId?: string;
  symbol: string;
  side: OrderSide;
  orderType: OrderType;
  orderedQuantity: number;
  filledQuantity: number;
  remainingQuantity: number;
  limitPrice?: number;
  status: OrderStatus;
  orderedAt: string;
  /** Original order route when the broker exposes it. */
  exchange?: Exchange;
  raw?: unknown;
}

export interface BrokerExecution {
  executionId: string;
  /**
   * True when the broker query does not provide a durable execution number
   * and the adapter has built a deterministic identity from order/time/price.
   * The repository may then correlate an exact durable fill from another
   * broker channel before inserting it again.
   */
  syntheticExecutionId?: boolean;
  brokerOrderId: string;
  symbol: string;
  side: OrderSide;
  quantity: number;
  price: number;
  executedAt: string;
  /** Execution venue or original order route when the broker exposes it. */
  exchange?: Exchange;
  /**
   * Some reconciliation APIs return an order-level cumulative fill snapshot,
   * not an individual execution. When present, the repository records only the
   * positive delta from fills already persisted for the order and trading day.
   */
  cumulativeQuantity?: number;
  cumulativeNotional?: number;
  raw?: unknown;
}

export interface AccountSnapshot {
  scope: AccountScope;
  cash: number;
  availableCash: number;
  totalEvaluation: number;
  realizedPnlToday: number;
  unrealizedPnl: number;
  positions: BrokerPosition[];
  openOrders: BrokerOrder[];
  fetchedAt: string;
}

export type ConnectionState =
  | "DISABLED"
  | "AUTHENTICATING"
  | "SYNCING"
  | "CONNECTED"
  | "DEGRADED"
  | "DISCONNECTED"
  | "ERROR";

export interface BrokerHealth {
  state: ConnectionState;
  restConnected: boolean;
  marketWebSocketConnected: boolean;
  accountWebSocketConnected: boolean;
  lastQuoteAt?: string;
  lastAccountEventAt?: string;
  lastError?: string;
  checkedAt: string;
}

export interface BrokerMarketStatus {
  state: "CLOSED" | "PREOPEN" | "OPEN" | "AFTER_HOURS";
  code: string;
  observedAt: string;
  /** Omitted by legacy adapters; legacy events are treated as KRX only. */
  exchange?: Exclude<Exchange, "SOR">;
}

export type BrokerEvent =
  | { type: "quote"; quote: Quote }
  | { type: "order"; order: BrokerOrder }
  | { type: "execution"; execution: BrokerExecution }
  | { type: "position"; position: BrokerPosition }
  | { type: "market-status"; status: BrokerMarketStatus }
  | { type: "health"; health: BrokerHealth }
  | { type: "error"; error: { message: string; code?: string; at: string } };

export interface BrokerCapabilities {
  supportsLive: boolean;
  supportsPaper: boolean;
  supportsAmend: boolean;
  supportsCancel: boolean;
  maxQuoteSubscriptions: number;
  quoteBatchSize?: number;
  queryRequestsPerSecond: number;
  orderRequestsPerSecond: number;
  clientOrderIdSupported: boolean;
}

export interface BrokerCredentials {
  appKey: string;
  appSecret: string;
  accountId: string;
  accountProductCode?: string;
  htsId?: string;
}

export interface CachedAccessToken {
  token: string;
  expiresAt: string;
  tokenType?: string;
}

export interface TokenStore {
  get(scope: AccountScope): Promise<CachedAccessToken | null>;
  set(scope: AccountScope, token: CachedAccessToken): Promise<void>;
  delete(scope: AccountScope): Promise<void>;
}
