export type BrokerId = "kiwoom" | "koreainvestment";

export type MarketSessionState =
  | "CLOSED"
  | "PREOPEN"
  | "OPEN"
  | "AFTER_HOURS"
  | "BREAK"
  | "HOLIDAY";

export type MarketSessionId =
  | "KRX_EQUITY"
  | "NXT_EQUITY"
  | "KRX_DERIVATIVES_DAY"
  | "KRX_DERIVATIVES_NIGHT";

export interface MarketVenueSession {
  id: MarketSessionId;
  label: string;
  kind: "equity" | "derivatives";
  state: MarketSessionState;
  phase: string;
  orderable: boolean;
  tradingDate: string;
  nextTransitionAt: string;
  checkedAt: string;
}

export interface DashboardResponse {
  engine: {
    state: "STARTING" | "RUNNING" | "BUY_PAUSED" | "HALTED" | "DEGRADED" | "ERROR";
    startedAt: string;
    emergencyHalt: boolean;
    globalAutoTradingEnabled: boolean;
    newBuysPaused: boolean;
  };
  market: {
    universeCount: number;
    buyEligibleCount: number;
    restrictedInstrumentCount: number;
    restrictionCounts: Record<string, number>;
    liveSubscriptionCount: number;
    rotatingScanCount: number;
    scanProgressPercent: number;
    scanMode: "WAITING_FOR_DATA" | "LIVE" | "LAST_SAVED";
    lastScanCompletedAt: string | null;
    lastScanQuoteAt: string | null;
    candidatesCount: number;
    lastUniverseSyncAt: string | null;
    sessions: MarketVenueSession[];
    session: {
      state: Exclude<MarketSessionState, "BREAK">;
      tradingDate: string;
      isTradingDay: boolean;
      nextTransitionAt: string;
      checkedAt: string;
    };
    dailyBarBackfill: { completed: number; total: number };
    regime: {
      enabled: boolean;
      status: "DISABLED" | "WAITING_FOR_DATA" | "NORMAL" | "WEAK";
      buyAllowed: boolean;
      reasonCode:
        | "FILTER_DISABLED"
        | "DAILY_BREADTH_NOT_READY"
        | "DAILY_BREADTH_WEAK"
        | "INTRADAY_BREADTH_NOT_READY"
        | "INTRADAY_BREADTH_WEAK"
        | "MARKET_HEALTHY";
      dailySampleCount: number;
      dailyAboveLongMaBps: number | null;
      intradaySampleCount: number;
      intradayAdvancingBps: number | null;
      checkedAt: string;
    };
  };
  pnl: {
    realized: number;
    unrealized: number;
    total: number;
  };
  brokerMetrics: Record<BrokerId, {
    pnl: { realized: number; unrealized: number; total: number };
    today: { orders: number; buys: number; sells: number };
  }>;
  today: { orders: number; buys: number; sells: number };
  brokers: BrokerDashboard[];
  candidates: CandidateRow[];
  positions: PositionRow[];
  orders: OrderRow[];
  executions: ExecutionRow[];
  errors: ErrorRow[];
}

export interface BrokerDashboard {
  brokerId: BrokerId;
  name: string;
  environment: "live" | "paper";
  enabled: boolean;
  autoTradingEnabled: boolean;
  newBuysPaused: boolean;
  orderRoute?: "KRX" | "NXT" | "SOR";
  resumeAfterRestart?: boolean;
  credentialsConfigured: boolean;
  maskedAccountId: string | null;
  strategyId: string;
  connectionState: string;
  connection: BrokerConnectionReadiness;
  liveSubscriptions: number;
  marketStatusConfirmed: boolean;
  orderWindowOpen: boolean;
  lastError: string | null;
  intraday?: {
    enabled: boolean;
    observedSymbols: number;
    readySymbols: number;
    requiredSeconds: number;
  };
}

export type BrokerConnectionStage =
  | "DISABLED"
  | "CREDENTIALS_REQUIRED"
  | "CONNECTING"
  | "AUTHENTICATING"
  | "ACCOUNT_SYNCING"
  | "WAITING_MARKET_STATUS"
  | "READY"
  | "DEGRADED"
  | "ERROR";

export interface BrokerConnectionReadiness {
  environment: "live" | "paper";
  stage: BrokerConnectionStage;
  credentialsStored: boolean;
  brokerAuthenticated: boolean;
  accountSynchronized: boolean;
  marketWebSocketConnected: boolean;
  accountWebSocketConnected: boolean;
  marketStatusConfirmed: boolean;
  orderWindowOpen: boolean;
  readyForOrders: boolean;
  runtimeState: string;
  message: string;
  lastError: string | null;
}

export interface CandidateRow {
  id: string;
  brokerId: BrokerId;
  symbol: string;
  name: string;
  action: string;
  price: number | null;
  reasonCodes: string[];
  generatedAt: string;
  source: "LIVE" | "LAST_SAVED";
}

export interface PositionRow {
  brokerId: BrokerId;
  environment: "live" | "paper";
  accountIdMasked: string;
  symbol: string;
  name: string;
  quantity: number;
  averagePrice: number;
  currentPrice: number;
  unrealizedPnl: number;
  unrealizedPnlBps: number;
}

export interface OrderRow {
  id: string;
  brokerId: BrokerId;
  environment: "live" | "paper";
  symbol: string;
  name: string;
  side: "buy" | "sell";
  orderType: "market" | "limit";
  quantity: number;
  filledQuantity: number;
  limitPrice: number | null;
  status: string;
  exchange?: "KRX" | "NXT" | "SOR";
  createdAt: string;
}

export interface ExecutionRow {
  id: string;
  brokerId: BrokerId;
  symbol: string;
  name: string;
  side: "buy" | "sell";
  quantity: number;
  price: number;
  executedAt: string;
}

export interface ErrorRow {
  id: number;
  brokerId: BrokerId | null;
  severity: string;
  code: string | null;
  message: string;
  createdAt: string;
}

export interface SettingsResponse {
  settings: {
    schemaVersion: 1;
    globalAutoTradingEnabled: boolean;
    emergencyHalt: boolean;
    newBuysPaused: boolean;
    staleQuoteMs: number;
    scanIntervalMs: number;
    quoteSweepIntervalMs: number;
    marketRegime: {
      enabled: boolean;
      longPeriod: number;
      minimumAboveLongMaBps: number;
      minimumIntradayAdvancingBps: number;
      minimumSampleSize: number;
    };
    brokers: Record<BrokerId, BrokerSettings>;
  };
  credentials: Record<BrokerId, Record<"live" | "paper", CredentialStatus>>;
  connections: Record<BrokerId, BrokerConnectionReadiness>;
  strategies: StrategySummary[];
}

export interface StrategyConfigField {
  key: string;
  label: string;
  kind: "number" | "percent";
  defaultValue: number;
  help: string;
  suffix?: string;
  min?: number;
  max?: number;
  step?: number;
}

export interface StrategySummary {
  id: string;
  name: string;
  version: string;
  description: string;
  defaultConfig: Record<string, number | string | boolean | null>;
  configFields: StrategyConfigField[];
}

export interface SaveCredentialsResponse extends SettingsResponse {
  ok: true;
  connected: boolean;
  connectionState: string;
  connection: BrokerConnectionReadiness;
  message: string;
}

export interface CredentialStatus {
  configured: boolean;
  source: "environment" | "os-keychain" | "encrypted-file" | null;
  maskedAccountId: string | null;
}

export type DerivativesCredentialConnectionState =
  | "NOT_CHECKED"
  | "VERIFYING"
  | "VERIFIED"
  | "FAILED";

export interface DerivativesCredentialResponse {
  credentials: {
    configured: boolean;
    source: "environment" | "os-keychain" | "encrypted-file" | null;
    maskedAccountId: string | null;
    accountProductCode: "03";
  };
  connection: {
    state: DerivativesCredentialConnectionState;
    authenticated: boolean;
    accountSynchronized: boolean;
    checkedAt: string | null;
    message: string;
  };
  account?: {
    maskedAccountId: string;
    accountProductCode: "03";
    positionCount: number;
    openOrderCount: number;
    observedAt: string;
    unavailableFields: string[];
  };
}

export interface DerivativesAutomationSettings {
  schemaVersion: 1;
  connectionEnabled: boolean;
  environment: "live" | "paper";
  autoTradingEnabled: boolean;
  resumeAfterRestart: boolean;
  emergencyHalt: boolean;
  newPositionsPaused: boolean;
  mode: "HEDGE" | "DIRECTIONAL" | "HEDGE_AND_DIRECTIONAL";
  contractSelection: "AUTO_MINI_KOSPI200" | "MANUAL";
  manualContractCode: string;
  allowNightSession: boolean;
  orderType: "MARKET" | "LIMIT";
  limitOffsetTicks: number;
  unfilledTimeoutSeconds: number;
  maxContracts: number;
  maxDailyLossKrw: number;
  maxMarginUsageBps: number;
  hedge: {
    enabled: boolean;
    hedgeRatioBps: number;
    minRebalanceContracts: number;
  };
  directional: {
    enabled: boolean;
    sideMode: "BOTH" | "LONG_ONLY" | "SHORT_ONLY";
    fastPeriod: number;
    slowPeriod: number;
    minimumGapBps: number;
    targetContracts: number;
  };
}

export interface DerivativesDashboardResponse {
  settings: DerivativesAutomationSettings;
  connection: {
    state: "DISABLED" | "CREDENTIALS_REQUIRED" | "CONNECTING" | "CONNECTED" | "DEGRADED" | "ERROR";
    authenticated: boolean;
    accountSynchronized: boolean;
    marketWebSocketConnected: boolean;
    accountNoticesConnected: boolean;
    checkedAt: string | null;
    message: string;
    lastError: string | null;
  };
  market: {
    activeSession: "DAY" | "NIGHT";
    sessions: MarketVenueSession[];
    orderWindowOpen: boolean;
  };
  account: null | {
    maskedAccountId: string;
    environment: "live" | "paper";
    productCode: "03";
    depositCash: number | null;
    orderableCash: number | null;
    initialMargin: number | null;
    maintenanceMargin: number | null;
    observedAt: string;
    unavailableFields: string[];
  };
  contract: null | {
    symbol: string;
    name: string;
    currentPrice: number | null;
    bidPrice: number | null;
    askPrice: number | null;
    cumulativeVolume: number | null;
    remainingDays: number | null;
    multiplierKrw: number;
    quoteReceivedAt: string | null;
  };
  equityExposureKrw: number | null;
  positions: Array<{
    symbol: string;
    name: string;
    direction: "LONG" | "SHORT";
    quantity: number;
    averagePrice: number;
    currentPrice: number | null;
    evaluationProfitLoss: number | null;
  }>;
  profitLoss: {
    realizedPnlKrw: number | null;
    cumulativeRealizedPnlKrw: number | null;
    unrealizedPnlKrw: number | null;
    totalPnlKrw: number | null;
  };
  brokerOpenOrders: Array<{
    brokerOrderId: string;
    symbol: string;
    side: "BUY" | "SELL";
    requestedQuantity: number;
    filledQuantity: number;
    remainingQuantity: number;
    orderPrice: number | null;
    averageFillPrice: number | null;
    status: string;
    session: "DAY" | "NIGHT";
    orderedAt: string | null;
  }>;
  orders: Array<{
    id: string;
    brokerOrderId: string | null;
    symbol: string;
    purpose: "HEDGE" | "DIRECTIONAL";
    action: "OPEN" | "CLOSE";
    direction: "LONG" | "SHORT";
    quantity: number;
    filledQuantity: number;
    remainingQuantity: number;
    limitPrice: number | null;
    status: string;
    orderedAt: string;
  }>;
  executions: Array<{
    executionId: string;
    brokerOrderId: string;
    symbol: string;
    side: "BUY" | "SELL";
    quantity: number;
    price: number;
    executedAt: string | null;
    session: "DAY" | "NIGHT";
  }>;
  purposeLedger: Array<{
    contractId: string;
    purpose: "HEDGE" | "DIRECTIONAL";
    signedQuantity: number;
    averagePrice: number;
    realizedPnlKrw: number;
    updatedAt: string;
  }>;
  hedge: {
    enabled: boolean;
    status: string;
    sourceEquityExposureKrw: number | null;
    targetQuantity: number | null;
    currentQuantity: number;
    reasons: readonly string[];
  };
  directional: {
    enabled: boolean;
    signal: string;
    fastAverage: number | null;
    slowAverage: number | null;
    gapBps: number | null;
    targetQuantity: number | null;
    currentQuantity: number;
    historyCount: number;
  };
  safety: {
    armed: boolean;
    newPositionsPaused: boolean;
    ledgerConsistent: boolean;
    ledgerBlockReason: string | null;
    readyForOrders: boolean;
    blockers: string[];
  };
  lastSyncAt: string | null;
}

export interface DerivativesSettingsResponse {
  settings: DerivativesAutomationSettings;
  runtime: DerivativesDashboardResponse;
  credentials: Record<"live" | "paper", CredentialStatus & { accountProductCode: "03" }>;
}

export interface BrokerSettings {
  enabled: boolean;
  autoTradingEnabled: boolean;
  newBuysPaused: boolean;
  orderRoute: "KRX" | "NXT" | "SOR";
  resumeAfterRestart: boolean;
  environment: "live" | "paper";
  strategyId: string;
  strategyConfig: Record<string, number | string | boolean | null>;
  orderPolicy: {
    orderType: "market" | "limit";
    limitOffsetBps: number;
    takeProfitEnabled: boolean;
    takeProfitBps: number;
    orderRetrySeconds?: number;
    signalEvaluationSeconds?: number;
    reentryCooldownSeconds?: number;
    estimatedRoundTripCostBps?: number;
    takeProfitAfterCosts?: boolean;
    maxHoldingMinutes?: number;
    timedExitOnlyWithoutNetProfit?: boolean;
    stopLossEnabled?: boolean;
    stopLossBps?: number;
    trailingProfitEnabled?: boolean;
    trailingActivationBps?: number;
    trailingDrawdownBps?: number;
    stagnationExitEnabled?: boolean;
    stagnationTradingDays?: number;
    stagnationMaxReturnBps?: number;
    reentryCooldownMinutes?: number;
    perTradeBudget: number;
    perSymbolLimit: number;
    accountInvestmentLimit: number;
    dailyInvestmentLimit: number;
    dailyInvestmentLimitEnabled?: boolean;
    sizeToAvailableBudget?: boolean;
    dailyMaxLoss: number;
    maxPositions: number;
    unfilledTimeoutSeconds: number;
    cancelRemainderOnTimeout: boolean;
  };
}
