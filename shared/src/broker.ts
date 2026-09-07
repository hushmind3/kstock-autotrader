import type {
  AccountScope,
  AccountSnapshot,
  AmendOrderRequest,
  BrokerCapabilities,
  BrokerCredentials,
  BrokerEvent,
  BrokerExecution,
  BrokerHealth,
  BrokerOrder,
  CancelOrderRequest,
  DailyBar,
  Exchange,
  Instrument,
  MarketCalendarDay,
  OrderSubmissionResult,
  PlaceOrderRequest,
  Quote,
  TokenStore,
  TradingEnvironment,
} from "./domain.js";

export interface BrokerAdapterOptions {
  environment: TradingEnvironment;
  credentials: BrokerCredentials;
  tokenStore: TokenStore;
  /** Market-data venue. SOR selects the broker's consolidated KRX/NXT feed. */
  quoteExchange?: Exchange;
  queryRequestsPerSecond?: number;
  orderRequestsPerSecond?: number;
}

export interface BrokerAdapter {
  readonly scope: AccountScope;
  readonly capabilities: BrokerCapabilities;

  connect(): Promise<void>;
  disconnect(): Promise<void>;
  getHealth(): BrokerHealth;
  onEvent(listener: (event: BrokerEvent) => void): () => void;

  fetchInstruments(): Promise<Instrument[]>;
  fetchMarketCalendar?(fromDate: string, requestedDays: number): Promise<MarketCalendarDay[]>;
  fetchDailyBars(symbol: string, requiredCount: number): Promise<DailyBar[]>;
  fetchQuote(symbol: string): Promise<Quote>;
  fetchQuotes?(symbols: string[]): Promise<Quote[]>;
  replaceQuoteSubscriptions(symbols: string[]): Promise<void>;

  placeOrder(request: PlaceOrderRequest): Promise<OrderSubmissionResult>;
  amendOrder(request: AmendOrderRequest): Promise<OrderSubmissionResult>;
  cancelOrder(request: CancelOrderRequest): Promise<OrderSubmissionResult>;

  fetchAccountSnapshot(): Promise<AccountSnapshot>;
  fetchOpenOrders(): Promise<BrokerOrder[]>;
  fetchOrderHistory?(fromDate: string): Promise<BrokerOrder[]>;
  fetchExecutions(fromDate: string): Promise<BrokerExecution[]>;
}

export abstract class BrokerAdapterError extends Error {
  abstract readonly retryable: boolean;
  constructor(
    message: string,
    readonly code?: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class BrokerRejectedError extends BrokerAdapterError {
  readonly retryable = false;
}

export class BrokerTransportError extends BrokerAdapterError {
  readonly retryable = true;
}

export class BrokerIndeterminateError extends BrokerAdapterError {
  readonly retryable = false;
}
