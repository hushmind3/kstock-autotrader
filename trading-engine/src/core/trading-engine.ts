import { randomUUID } from "node:crypto";
import { KisRequestLimiter, KoreaInvestmentBrokerAdapter } from "@kstock/broker-kis";
import {
  KoreaInvestmentDerivativeAdapter,
  type DerivativeAccountSnapshot,
  type DerivativeSession,
} from "@kstock/broker-kis-derivatives";
import { KiwoomBrokerAdapter } from "@kstock/broker-kiwoom";
import {
  AppSettingsSchema,
  BROKER_IDS,
  StrategyConfigSchema,
  createDefaultSettings,
  isInstrumentBuyAllowed,
  koreanTradingDate,
  maskAccount,
  redactSensitive,
  readInstrumentSafetyMetadata,
  stableHash,
  toIsoDateTime,
  type AccountScope,
  type AppSettings,
  type BrokerAdapter,
  type BrokerCredentials,
  type BrokerEvent,
  type BrokerHealth,
  type BrokerId,
  type BrokerOrder,
  type BrokerPosition,
  type BrokerRuntimeSettings,
  type Exchange,
  type MarketCalendarDay,
  type Quote,
  type StrategyDecision,
  type TokenStore,
  type TradingEnvironment,
} from "@kstock/shared";
import {
  TradingRepository,
  type ErrorLogRecord,
  type OrderRecord,
  type SignalRecord,
} from "@kstock/database";
import { StrategyRegistry } from "@kstock/strategies";
import { CredentialStore, createTokenStore } from "../security/credential-store.js";
import { MarketClock, type MarketSession } from "./market-clock.js";
import {
  summarizeBrokerConnection,
  type BrokerConnectionReadiness,
} from "./broker-connection.js";
import { OrderDispatcher } from "./order-dispatcher.js";
import { evaluatePositionExitPolicy, positionExitPolicyKey } from "./exit-policy.js";
import { PositionLifecycle, verifiedQuoteObservedAt } from "./position-lifecycle.js";
import { IntradayTape } from "./intraday-tape.js";
import { MarketDataService, type MarketRuntimeView } from "../services/market-data-service.js";
import { DerivativesRuntime } from "../derivatives/runtime.js";

interface BrokerRuntime {
  adapter: BrokerAdapter;
  settings: BrokerRuntimeSettings;
  strategyConfigId: string;
  requiredDailyBars: number;
  intradayWindowSeconds: number;
  reconciled: boolean;
  recovering: boolean;
  marketStatusConfirmedDate: string | null;
  unsubscribe: () => void;
  orderTail: Promise<void>;
  reconcileTimer: NodeJS.Timeout | null;
  reconcilePromise: Promise<void> | null;
  accountEventVersion: number;
}

interface CandidateState {
  id: string;
  scope: AccountScope;
  symbol: string;
  name: string;
  action: "BUY" | "SELL";
  price: number;
  reasonCodes: string[];
  generatedAt: string;
  source: "LIVE" | "LAST_SAVED";
}

/**
 * Kiwoom's balance stream also publishes mark-to-market price/P&L changes.
 * Those updates do not change what the account can sell and must not make the
 * engine look unsynchronized on every price tick.  Only durable position-ledger
 * fields require an authoritative REST reconciliation before another order.
 */
export function positionLedgerChanged(
  current: BrokerPosition | null,
  incoming: BrokerPosition,
): boolean {
  if (current === null) {
    return incoming.quantity > 0 || incoming.availableQuantity > 0;
  }
  return current.quantity !== incoming.quantity
    || current.availableQuantity !== incoming.availableQuantity
    || current.averagePrice !== incoming.averagePrice;
}

/** An audited historical UNKNOWN row is harmless once nothing can still fill. */
export function hasUnresolvedUnknownOrders(
  orders: readonly Pick<OrderRecord, "remainingQuantity">[],
): boolean {
  return orders.some((order) => order.remainingQuantity > 0);
}

interface TradingEngineOptions {
  repository: TradingRepository;
  dataDirectory: string;
  externalStrategyDirectory?: string;
  credentialStore?: CredentialStorePort;
  brokerAdapterFactory?: BrokerAdapterFactory;
  derivativeAdapterFactory?: DerivativeAdapterFactory;
}

export interface BrokerAdapterFactoryInput {
  brokerId: BrokerId;
  settings: BrokerRuntimeSettings;
  credentials: BrokerCredentials;
  tokenStore: TokenStore;
}

export type BrokerAdapterFactory = (input: BrokerAdapterFactoryInput) => BrokerAdapter;

export interface DerivativeAccountVerifier {
  fetchAccountSnapshot(session: DerivativeSession): Promise<DerivativeAccountSnapshot>;
  disconnect?(): Promise<void>;
}

export interface DerivativeAdapterFactoryInput {
  environment: TradingEnvironment;
  credentials: BrokerCredentials;
  tokenStore: TokenStore;
}

export type DerivativeAdapterFactory = (
  input: DerivativeAdapterFactoryInput,
) => DerivativeAccountVerifier;

export interface DerivativeCredentialStatus {
  configured: boolean;
  source: "environment" | "encrypted-file" | "os-keychain" | null;
  maskedAccountId: string | null;
  accountProductCode: "03";
}

export interface CredentialStorePort {
  save(
    brokerId: BrokerId,
    environment: TradingEnvironment,
    credentials: BrokerCredentials,
  ): Promise<void>;
  get(
    brokerId: BrokerId,
    environment: TradingEnvironment,
  ): Promise<BrokerCredentials | null>;
  delete(brokerId: BrokerId, environment: TradingEnvironment): Promise<boolean>;
  status(brokerId: BrokerId, environment: TradingEnvironment): Promise<{
    configured: boolean;
    source: "environment" | "encrypted-file" | "os-keychain" | null;
    maskedAccountId: string | null;
  }>;
  saveDerivatives(
    environment: TradingEnvironment,
    credentials: BrokerCredentials,
  ): Promise<void>;
  getDerivatives(environment: TradingEnvironment): Promise<BrokerCredentials | null>;
  deleteDerivatives(environment: TradingEnvironment): Promise<boolean>;
  statusDerivatives(environment: TradingEnvironment): Promise<DerivativeCredentialStatus>;
}

export interface SaveCredentialsOptions {
  credentials: BrokerCredentials;
  connectNow: boolean;
}

export interface SaveDerivativeCredentialsOptions {
  accountId: string;
  accountProductCode: "03";
  htsId?: string;
  appKey?: string;
  appSecret?: string;
  reuseCashCredentials: boolean;
  connectNow: boolean;
}

export interface DerivativeCredentialConnection {
  state: "NOT_CHECKED" | "VERIFYING" | "VERIFIED" | "FAILED";
  authenticated: boolean;
  accountSynchronized: boolean;
  checkedAt: string | null;
  message: string;
}

export interface DerivativeCredentialAccountSummary {
  maskedAccountId: string;
  accountProductCode: "03";
  positionCount: number;
  openOrderCount: number;
  observedAt: string;
  unavailableFields: DerivativeAccountSnapshot["unavailableFields"];
}

export class CredentialConflictError extends Error {
  readonly statusCode = 409;

  constructor(message: string) {
    super(message);
    this.name = "CredentialConflictError";
  }
}

export class ControlConflictError extends Error {
  readonly statusCode = 409;

  constructor(message: string) {
    super(message);
    this.name = "ControlConflictError";
  }
}

interface PersistedMarketCalendar {
  syncedTradingDate: string;
  syncedAt: string;
  days: MarketCalendarDay[];
}

const BROKER_NAMES: Record<BrokerId, string> = {
  kiwoom: "키움증권",
  koreainvestment: "한국투자증권",
};

function scopeKey(scope: AccountScope): string {
  return `${scope.brokerId}:${scope.environment}:${scope.accountId}`;
}

function candidateKey(scope: AccountScope, symbol: string): string {
  return `${scopeKey(scope)}:${symbol}`;
}

function derivativeCredentialErrorEvidence(error: unknown): string {
  const rawMessage = error instanceof Error ? error.message : String(error);
  const rawCode = error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code ?? "")
    : "";
  return `${rawCode} ${rawMessage}`.toUpperCase();
}

function isDerivativeAccountBindingFailure(error: unknown): boolean {
  return derivativeCredentialErrorEvidence(error).includes("INPUT INVALID_CHECK_ACNO");
}

function derivativeCredentialFailureMessage(
  error: unknown,
  reusedCashApiCredentials = false,
): string {
  const evidence = derivativeCredentialErrorEvidence(error);

  if (evidence.includes("INPUT INVALID_CHECK_ACNO")) {
    return reusedCashApiCredentials
      ? "API 로그인은 성공했습니다. 계좌번호가 맞다면 현재 재사용 중인 현물계좌용 App Key에 이 별도 선물계좌가 등록되지 않은 상태입니다. 한투 Open API 신청정보의 ‘추가신청하기’에서 선물계좌를 신청한 뒤, 해당 계좌에 표시된 App Key·비밀키를 선물용 API 정보에 입력해 주세요. 계좌 비밀번호는 필요하지 않습니다."
      : "API 로그인은 성공했지만 한국투자증권이 현재 App Key와 선물계좌의 조합을 인정하지 않았습니다. 계좌번호가 맞다면 한투 Open API 신청정보에서 이 선물계좌의 신청 상태와 해당 계좌에 표시된 App Key·비밀키를 확인해 주세요. 계좌 비밀번호는 필요하지 않습니다.";
  }
  if (
    evidence.includes("TOKEN") ||
    evidence.includes("AUTH") ||
    evidence.includes("APPKEY") ||
    evidence.includes("APPSECRET")
  ) {
    return "한국투자증권 API 로그인에 실패했습니다. 실전용 App Key·비밀키와 Open API 신청 상태를 확인해 주세요.";
  }
  return "실제 선물 계좌 조회에 실패했습니다. API 권한과 선물 계좌번호를 확인해 주세요.";
}

function normalizeQuoteTradingDate(quote: Quote): Quote {
  if (/^\d{4}-\d{2}-\d{2}$/.test(quote.tradingDate)) return quote;
  if (!/^\d{8}$/.test(quote.tradingDate)) return quote;
  return {
    ...quote,
    tradingDate: `${quote.tradingDate.slice(0, 4)}-${quote.tradingDate.slice(4, 6)}-${quote.tradingDate.slice(6, 8)}`,
  };
}

function startOfKoreanTradingDate(tradingDate: string): string {
  return new Date(`${tradingDate}T00:00:00+09:00`).toISOString();
}

function compactTradingDate(tradingDate: string): string {
  return tradingDate.replaceAll("-", "");
}

function marketVenueSignature(session: MarketSession): string {
  return session.sessions
    .map((item) => `${item.id}:${item.state}:${item.orderable ? 1 : 0}`)
    .join("|");
}

export function didOrderRouteWindowChange(
  previous: MarketSession,
  current: MarketSession,
  route: Exchange,
): boolean {
  return previous.orderableExchanges.includes(route) !==
    current.orderableExchanges.includes(route);
}

/**
 * Kiwoom's 0s stream announces transitions but does not guarantee an initial
 * state snapshot when a client connects mid-session. A fresh ka10095 trade is
 * accepted only as positive OPEN evidence; it is never used to infer a close,
 * holiday, or pre-open state.
 */
export function isFreshKiwoomRegularSessionQuote(
  quote: Quote,
  now: Date,
  staleQuoteMs: number,
): boolean {
  if (
    quote.source !== "kiwoom" ||
    quote.brokerTimestampVerified !== true ||
    quote.stale === true ||
    !Number.isFinite(quote.price) ||
    quote.price <= 0 ||
    !Number.isFinite(quote.cumulativeVolume) ||
    quote.cumulativeVolume <= 0 ||
    quote.tradingDate !== koreanTradingDate(now) ||
    !/^\d{6}$/.test(quote.tradingTime) ||
    quote.tradingTime < "090000" ||
    quote.tradingTime > "153000"
  ) {
    return false;
  }
  const hours = Number(quote.tradingTime.slice(0, 2));
  const minutes = Number(quote.tradingTime.slice(2, 4));
  const seconds = Number(quote.tradingTime.slice(4, 6));
  if (hours > 23 || minutes > 59 || seconds > 59) return false;
  const brokerInstant = Date.parse(
    `${quote.tradingDate}T${quote.tradingTime.slice(0, 2)}:${quote.tradingTime.slice(2, 4)}:${quote.tradingTime.slice(4, 6)}+09:00`,
  );
  const receivedInstant = Date.parse(quote.receivedAt);
  const brokerAge = now.getTime() - brokerInstant;
  const receivedAge = now.getTime() - receivedInstant;
  return (
    Number.isFinite(brokerAge) &&
    Number.isFinite(receivedAge) &&
    brokerAge >= -5_000 &&
    brokerAge <= staleQuoteMs &&
    receivedAge >= -5_000 &&
    receivedAge <= staleQuoteMs
  );
}

/**
 * Accepts a quote as positive evidence that the broker feed is live right now.
 * The market clock still decides whether the selected KRX/NXT/SOR route is
 * orderable; this helper only validates the broker supplied date/time and
 * transport freshness. Local receipt time alone is deliberately insufficient.
 */
export function isFreshVerifiedBrokerQuote(
  quote: Quote,
  now: Date,
  staleQuoteMs: number,
): boolean {
  if (
    quote.brokerTimestampVerified !== true ||
    quote.stale === true ||
    !Number.isFinite(quote.price) ||
    quote.price <= 0 ||
    !Number.isFinite(quote.cumulativeVolume) ||
    quote.cumulativeVolume <= 0 ||
    quote.tradingDate !== koreanTradingDate(now) ||
    !/^\d{6}$/.test(quote.tradingTime)
  ) {
    return false;
  }
  const hours = Number(quote.tradingTime.slice(0, 2));
  const minutes = Number(quote.tradingTime.slice(2, 4));
  const seconds = Number(quote.tradingTime.slice(4, 6));
  if (hours > 23 || minutes > 59 || seconds > 59) return false;
  const brokerInstant = Date.parse(
    `${quote.tradingDate}T${quote.tradingTime.slice(0, 2)}:${quote.tradingTime.slice(2, 4)}:${quote.tradingTime.slice(4, 6)}+09:00`,
  );
  const receivedInstant = Date.parse(quote.receivedAt);
  const brokerAge = now.getTime() - brokerInstant;
  const receivedAge = now.getTime() - receivedInstant;
  return (
    Number.isFinite(brokerAge) &&
    Number.isFinite(receivedAge) &&
    brokerAge >= -5_000 &&
    brokerAge <= staleQuoteMs &&
    receivedAge >= -5_000 &&
    receivedAge <= staleQuoteMs
  );
}

function asBrokerOrder(order: OrderRecord): BrokerOrder {
  return {
    brokerOrderId: order.brokerOrderId ?? order.id,
    ...(order.originalBrokerOrderId ? { originalBrokerOrderId: order.originalBrokerOrderId } : {}),
    symbol: order.symbol,
    side: order.side,
    orderType: order.orderType,
    orderedQuantity: order.orderedQuantity,
    filledQuantity: order.filledQuantity,
    remainingQuantity: order.remainingQuantity,
    ...(order.limitPrice === null ? {} : { limitPrice: order.limitPrice }),
    status: order.status,
    orderedAt: order.orderedAt,
    exchange: order.exchange,
  };
}

function envBoolean(name: string, fallback = false): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  if (!value) return fallback;
  return value === "1" || value === "true" || value === "yes";
}

function envInteger(name: string): number | undefined {
  const value = process.env[name];
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

export class TradingEngine {
  readonly startedAt = toIsoDateTime();
  readonly #repository: TradingRepository;
  readonly #dataDirectory: string;
  readonly #credentialStore: CredentialStorePort;
  readonly #brokerAdapterFactory: BrokerAdapterFactory | undefined;
  readonly #derivativeAdapterFactory: DerivativeAdapterFactory | undefined;
  readonly #strategyRegistry = new StrategyRegistry();
  readonly #orderDispatcher: OrderDispatcher;
  readonly #positionLifecycle: PositionLifecycle;
  readonly #intradayTape: IntradayTape;
  readonly #intradayFocus = new Map<string, { selectedAt: number; symbols: string[] }>();
  readonly #intradayReadiness = new Map<string, { evaluatedAt: number; ready: boolean }>();
  readonly #marketClock = new MarketClock();
  readonly #instanceId = randomUUID();
  readonly #runtimes = new Map<BrokerId, BrokerRuntime>();
  readonly #derivativeCredentialConnections = new Map<
    TradingEnvironment,
    DerivativeCredentialConnection
  >();
  readonly #derivativeCredentialAccounts = new Map<
    TradingEnvironment,
    DerivativeCredentialAccountSummary
  >();
  readonly #candidates = new Map<string, CandidateState>();
  readonly #lastActions = new Map<string, StrategyDecision["action"]>();
  readonly #lastEvaluatedAt = new Map<string, number>();
  readonly #evaluating = new Set<string>();
  readonly #marketData: MarketDataService;
  readonly #derivatives: DerivativesRuntime;
  #settings: AppSettings;
  #marketSession: MarketSession;
  #leaseTimer: NodeJS.Timeout | null = null;
  #maintenanceTimer: NodeJS.Timeout | null = null;
  #sleepTimer: NodeJS.Timeout | null = null;
  #lastSleepTick = Date.now();
  #stopping = false;
  #leaseHealthy = true;
  #calendarSyncDate: string | null = null;
  readonly #kisRequestLimiters = new Map<string, KisRequestLimiter>();
  #lifecycleTail: Promise<void> = Promise.resolve();

  constructor(options: TradingEngineOptions) {
    this.#repository = options.repository;
    this.#dataDirectory = options.dataDirectory;
    this.#credentialStore = options.credentialStore ?? new CredentialStore(options.dataDirectory);
    this.#brokerAdapterFactory = options.brokerAdapterFactory;
    this.#derivativeAdapterFactory = options.derivativeAdapterFactory;
    this.#settings = this.loadSettings();
    const calendar = this.#repository.getRuntimeState<PersistedMarketCalendar>(null, "market-calendar");
    if (calendar?.days && Array.isArray(calendar.days)) {
      this.#marketClock.applyOfficialCalendar(calendar.days);
      this.#calendarSyncDate = calendar.syncedTradingDate;
    }
    this.#marketSession = this.#marketClock.current();
    this.#orderDispatcher = new OrderDispatcher(this.#repository);
    this.#positionLifecycle = new PositionLifecycle(this.#repository);
    this.#intradayTape = new IntradayTape(this.#repository);
    this.#marketData = new MarketDataService(this.#repository, {
      getRuntimes: () => this.marketRuntimes(),
      getQuoteSweepIntervalMs: () => this.#settings.quoteSweepIntervalMs,
      getMarketRegimeSettings: () => this.#settings.marketRegime,
      getLatestCompletedTradingDate: () =>
        this.#marketClock.previousTradingDate(koreanTradingDate()),
      onMarketRegimeChange: (current, previous) => {
        if (!previous.buyAllowed && current.buyAllowed) {
          // A BUY signal first seen while the market-wide gate was closed must
          // be evaluated again as soon as the gate reopens. Otherwise the
          // edge-trigger cache would keep a valid signal stuck in waiting
          // until it changed to HOLD and back to BUY.
          this.#lastActions.clear();
          this.#lastEvaluatedAt.clear();
        }
      },
      getPrioritySymbols: (scope) => this.prioritySymbols(scope),
      isMarketOpen: (adapter) => this.isRuntimeOrderWindowOpen(adapter),
      onQuote: (adapter, quote) => this.evaluateQuote(adapter, quote),
      onStoredQuote: (adapter, quote) =>
        this.evaluateQuote(adapter, quote, { snapshotOnly: true }),
      onError: (error, context, adapter) => this.recordError(error, context, adapter?.scope),
    });
    this.#derivatives = new DerivativesRuntime({
      repository: this.#repository,
      loadCredentials: (environment) => this.#credentialStore.getDerivatives(environment),
      createAdapter: (environment, credentials) => {
        const tokenStore = createTokenStore(this.#dataDirectory);
        return this.#derivativeAdapterFactory
          ? this.#derivativeAdapterFactory({ environment, credentials, tokenStore })
          : new KoreaInvestmentDerivativeAdapter({
              environment,
              credentials,
              tokenStore,
              requestLimiter: this.kisRequestLimiter(environment, credentials),
            });
      },
      getSessions: () => this.#marketSession.sessions.filter((session) => session.kind === "derivatives"),
      getEquityExposureKrw: () => this.derivativesEquityExposureKrw(),
      canMutate: () => this.#leaseHealthy && !this.#stopping,
      onCredentialStatus: ({ environment, connection, account }) => {
        this.#derivativeCredentialConnections.set(environment, connection);
        if (account) this.#derivativeCredentialAccounts.set(environment, account);
      },
      onError: (error, context, severity) => this.recordError(error, context, undefined, severity),
    });
    if (options.externalStrategyDirectory) {
      void this.#strategyRegistry
        .loadExternal(options.externalStrategyDirectory)
        .catch((error: unknown) => this.recordError(error, "external-strategy-load"));
    }
  }

  get settings(): AppSettings {
    return structuredClone(this.#settings);
  }

  get marketSession(): MarketSession {
    return { ...this.#marketSession };
  }

  async start(): Promise<void> {
    const acquired = this.#repository.acquireEngineLease({
      name: "trading-engine",
      ownerId: this.#instanceId,
      ttlMs: 30_000,
    });
    if (!acquired) throw new Error("Another trading-engine instance already owns the database lease");
    let restartPolicyChanged = false;
    for (const brokerId of BROKER_IDS) {
      const broker = this.#settings.brokers[brokerId];
      if (!broker.resumeAfterRestart && broker.autoTradingEnabled) {
        broker.autoTradingEnabled = false;
        broker.newBuysPaused = true;
        restartPolicyChanged = true;
      }
    }
    if (restartPolicyChanged) {
      this.#repository.setAppSettings(this.#settings);
      this.#repository.appendAudit({
        actor: "trading-engine",
        action: "RESTART_RESUME_POLICY_APPLIED",
      });
    }
    this.startLeaseHeartbeat();
    await this.rebuildRuntimes();
    await this.#derivatives.start();
    await this.#marketData.start();
    this.#marketClock.start((current, previous) => {
      const previousSession = this.#marketSession;
      this.#marketSession = current;
      this.invalidateConfirmationsForClosedOrReopenedRoutes(previousSession, current);
      this.#repository.setRuntimeState(null, "market-session", current);
      if (previous !== null) void this.handleMarketTransition(current, previousSession);
    });
    this.startMaintenance();
    this.startSleepDetection();
    this.#repository.appendAudit({
      actor: "trading-engine",
      action: "ENGINE_STARTED",
      payload: { instanceId: this.#instanceId, marketSession: this.#marketSession.state },
    });
  }

  async stop(): Promise<void> {
    if (this.#stopping) return;
    this.#stopping = true;
    this.#marketClock.stop();
    if (this.#leaseTimer) clearInterval(this.#leaseTimer);
    if (this.#maintenanceTimer) clearInterval(this.#maintenanceTimer);
    if (this.#sleepTimer) clearInterval(this.#sleepTimer);
    await this.#marketData.stop();
    await this.#derivatives.stop();
    await Promise.allSettled(
      [...this.#runtimes.values()].map(async (runtime) => {
        runtime.unsubscribe();
        if (runtime.reconcileTimer) clearTimeout(runtime.reconcileTimer);
        await runtime.adapter.disconnect();
      }),
    );
    this.#runtimes.clear();
    this.#intradayTape.flush();
    this.#repository.releaseEngineLease("trading-engine", this.#instanceId);
    this.#repository.appendAudit({ actor: "trading-engine", action: "ENGINE_STOPPED" });
  }

  async updateSettings(input: unknown): Promise<ReturnType<TradingEngine["settingsResponse"]>> {
    const parsed = AppSettingsSchema.parse(input);
    for (const brokerId of BROKER_IDS) {
      const broker = parsed.brokers[brokerId];
      const current = this.#settings.brokers[brokerId];
      const strategy = this.#strategyRegistry.get(broker.strategyId);
      broker.strategyConfig = StrategyConfigSchema.parse(
        strategy.validateConfig(broker.strategyConfig),
      );
      // Account arming is an audited runtime control, not an ordinary form
      // value. A settings tab left open in the browser must never reapply a
      // stale stop/start value when the user later saves strategy numbers.
      if (!broker.enabled || broker.environment !== current.environment) {
        broker.autoTradingEnabled = false;
        broker.newBuysPaused = true;
      } else {
        broker.autoTradingEnabled = current.autoTradingEnabled;
        broker.newBuysPaused = current.newBuysPaused;
      }
    }
    parsed.globalAutoTradingEnabled = this.#settings.globalAutoTradingEnabled;
    parsed.emergencyHalt = this.#settings.emergencyHalt;
    parsed.newBuysPaused = this.#settings.newBuysPaused;
    this.#settings = parsed;
    this.#repository.setAppSettings(parsed);
    await this.enqueueLifecycle(() => this.rebuildRuntimes());
    await this.#marketData.start();
    this.#repository.appendAudit({
      actor: "web-console",
      action: "SETTINGS_UPDATED",
      payload: redactSensitive(parsed),
    });
    return this.settingsResponse();
  }

  async saveCredentials(
    brokerId: BrokerId,
    environment: TradingEnvironment,
    options: SaveCredentialsOptions,
  ) {
    const currentStatus = await this.#credentialStore.status(brokerId, environment);
    if (currentStatus.source === "environment") {
      throw new CredentialConflictError(
        "환경변수로 관리되는 자격정보는 웹 화면에서 덮어쓸 수 없습니다.",
      );
    }

    await this.#credentialStore.save(brokerId, environment, options.credentials);
    await this.enqueueLifecycle(async () => {
      const brokerSettings = this.#settings.brokers[brokerId];
      // A new credential must never inherit a live auto-order state. Connecting
      // verifies authentication and restores the account ledger only; trading
      // still requires the user's separate, explicit resume action.
      brokerSettings.autoTradingEnabled = false;
      brokerSettings.newBuysPaused = true;
      if (options.connectNow) {
        brokerSettings.environment = environment;
        brokerSettings.enabled = true;
      }
      this.#repository.setAppSettings(this.#settings);
      if (options.connectNow) {
        await this.rebuildRuntimes();
        await this.#marketData.start();
      }
    });

    this.#repository.appendAudit({
      actor: "web-console",
      action: options.connectNow ? "CREDENTIALS_SAVED_AND_CONNECT_REQUESTED" : "CREDENTIALS_SAVED",
      payload: { brokerId, environment },
    });

    const broker = await this.brokerDashboard(brokerId);
    const response = await this.settingsResponse();
    const connectionState = String(broker.connectionState);
    const connection = broker.connection;
    // Kept for existing clients. `connected` now means that broker
    // authentication and account reconciliation actually succeeded; market
    // status readiness is reported separately in `connection`.
    const connected = options.connectNow &&
      connection.brokerAuthenticated &&
      connection.accountSynchronized;
    return {
      ok: true as const,
      connected,
      connectionState,
      connection,
      message: options.connectNow
        ? `${BROKER_NAMES[brokerId]}: ${connection.message}`
        : `${BROKER_NAMES[brokerId]} 자격정보를 안전하게 저장했습니다.`,
      ...response,
    };
  }

  async derivativeCredentialsStatus(environment: TradingEnvironment) {
    const credentials = await this.safeDerivativeCredentialStatus(environment);
    const connection = credentials.configured
      ? this.#derivativeCredentialConnections.get(environment) ?? {
          state: "NOT_CHECKED" as const,
          authenticated: false,
          accountSynchronized: false,
          checkedAt: null,
          message: "선물·옵션 계좌가 저장되어 있습니다. 연결 확인을 실행해 주세요.",
        }
      : {
          state: "NOT_CHECKED" as const,
          authenticated: false,
          accountSynchronized: false,
          checkedAt: null,
          message: "한국투자증권 선물·옵션 계좌를 먼저 저장해 주세요.",
        };
    return {
      brokerId: "koreainvestment" as const,
      market: "DERIVATIVES" as const,
      environment,
      credentials,
      connection,
      ...(this.#derivativeCredentialAccounts.get(environment)
        ? { account: this.#derivativeCredentialAccounts.get(environment)! }
        : {}),
    };
  }

  async saveDerivativeCredentials(
    environment: TradingEnvironment,
    options: SaveDerivativeCredentialsOptions,
  ) {
    const currentStatus = await this.#credentialStore.statusDerivatives(environment);
    if (currentStatus.source === "environment") {
      throw new CredentialConflictError(
        "환경변수로 관리되는 선물·옵션 계좌정보는 웹 화면에서 덮어쓸 수 없습니다.",
      );
    }

    const previousCredentials = currentStatus.configured
      ? await this.#credentialStore.getDerivatives(environment)
      : null;
    const explicitAppKey = options.appKey?.trim() ?? "";
    const explicitAppSecret = options.appSecret?.trim() ?? "";
    if ((explicitAppKey === "") !== (explicitAppSecret === "")) {
      throw new CredentialConflictError("API 키와 API 비밀키는 둘 다 입력해야 합니다.");
    }
    const cashCredentials = options.reuseCashCredentials
      ? await this.#credentialStore.get("koreainvestment", environment)
      : null;
    if (explicitAppKey === "" && !cashCredentials) {
      throw new CredentialConflictError(
        "재사용할 한국투자증권 현물 API 키가 없습니다. 현물 계좌를 먼저 저장하거나 API 키를 직접 입력해 주세요.",
      );
    }

    const compactAccountId = options.accountId.replaceAll("-", "");
    const accountId = compactAccountId.length === 10
      ? compactAccountId.slice(0, 8)
      : compactAccountId;
    const credentials: BrokerCredentials = {
      appKey: explicitAppKey || cashCredentials!.appKey,
      appSecret: explicitAppSecret || cashCredentials!.appSecret,
      accountId,
      accountProductCode: "03",
      ...((options.htsId?.trim() || cashCredentials?.htsId?.trim())
        ? { htsId: options.htsId?.trim() || cashCredentials?.htsId?.trim() }
        : {}),
    };

    const tokenIdentityChanged = !previousCredentials ||
      previousCredentials.appKey !== credentials.appKey ||
      previousCredentials.appSecret !== credentials.appSecret ||
      previousCredentials.accountId !== credentials.accountId ||
      previousCredentials.accountProductCode !== credentials.accountProductCode;
    if (tokenIdentityChanged) {
      const tokenStore = createTokenStore(this.#dataDirectory);
      const accountIds = new Set([
        ...(previousCredentials ? [`${previousCredentials.accountId}-03`] : []),
        `${credentials.accountId}-03`,
      ]);
      for (const scopedAccountId of accountIds) {
        await tokenStore.delete({
          brokerId: "koreainvestment",
          environment,
          accountId: scopedAccountId,
        });
      }
    }
    await this.#credentialStore.saveDerivatives(environment, credentials);

    this.#derivativeCredentialAccounts.delete(environment);
    let connection: DerivativeCredentialConnection = {
      state: "NOT_CHECKED",
      authenticated: false,
      accountSynchronized: false,
      checkedAt: null,
      message: "선물·옵션 계좌정보를 안전하게 저장했습니다.",
    };

    if (options.connectNow) {
      connection = (await this.verifyDerivativeAccount(
        environment,
        credentials,
        explicitAppKey === "",
      )).connection;
      if (!this.#derivativeAdapterFactory) {
        await this.#derivatives.credentialsChanged(environment);
      }
    } else {
      this.#derivativeCredentialConnections.set(environment, connection);
    }

    this.#repository.appendAudit({
      actor: "web-console",
      action: connection.state === "VERIFIED"
        ? "DERIVATIVES_CREDENTIALS_SAVED_AND_VERIFIED"
        : connection.state === "FAILED"
          ? "DERIVATIVES_CREDENTIALS_SAVED_VERIFICATION_FAILED"
          : "DERIVATIVES_CREDENTIALS_SAVED",
      payload: {
        brokerId: "koreainvestment",
        environment,
        accountProductCode: "03",
        reusedCashApiCredentials: explicitAppKey === "",
        verificationState: connection.state,
      },
    });
    const status = await this.derivativeCredentialsStatus(environment);
    return {
      ok: true as const,
      connected: connection.authenticated && connection.accountSynchronized,
      ...status,
      message: connection.message,
    };
  }

  async verifyDerivativeCredentials(environment: TradingEnvironment) {
    const credentials = await this.#credentialStore.getDerivatives(environment);
    if (!credentials) {
      throw new CredentialConflictError(
        "한국투자증권 선물·옵션 계좌를 먼저 저장해 주세요.",
      );
    }
    const cashCredentials = await this.#credentialStore.get("koreainvestment", environment);
    const reusesCashApiCredentials = cashCredentials !== null &&
      cashCredentials.appKey === credentials.appKey &&
      cashCredentials.appSecret === credentials.appSecret;
    const { connection } = await this.verifyDerivativeAccount(
      environment,
      credentials,
      reusesCashApiCredentials,
    );
    if (!this.#derivativeAdapterFactory) {
      await this.#derivatives.credentialsChanged(environment);
    }
    this.#repository.appendAudit({
      actor: "web-console",
      action: connection.state === "VERIFIED"
        ? "DERIVATIVES_CREDENTIALS_REVERIFIED"
        : "DERIVATIVES_CREDENTIALS_REVERIFICATION_FAILED",
      payload: {
        brokerId: "koreainvestment",
        environment,
        accountProductCode: "03",
        verificationState: connection.state,
      },
    });
    return {
      ok: true as const,
      connected: connection.authenticated && connection.accountSynchronized,
      ...(await this.derivativeCredentialsStatus(environment)),
      message: connection.message,
    };
  }

  private async verifyDerivativeAccount(
    environment: TradingEnvironment,
    credentials: BrokerCredentials,
    reusedCashApiCredentials = false,
  ): Promise<{
    connection: DerivativeCredentialConnection;
    account?: DerivativeCredentialAccountSummary;
  }> {
    const verifying: DerivativeCredentialConnection = {
      state: "VERIFYING",
      authenticated: false,
      accountSynchronized: false,
      checkedAt: null,
      message: "한국투자증권 API로 실제 선물 계좌를 조회하고 있습니다.",
    };
    this.#derivativeCredentialConnections.set(environment, verifying);
    this.#derivativeCredentialAccounts.delete(environment);
    let adapter: DerivativeAccountVerifier | undefined;
    try {
      const tokenStore = createTokenStore(this.#dataDirectory);
      adapter = this.#derivativeAdapterFactory
        ? this.#derivativeAdapterFactory({ environment, credentials, tokenStore })
        : new KoreaInvestmentDerivativeAdapter({
            environment,
            credentials,
            tokenStore,
            requestLimiter: this.kisRequestLimiter(environment, credentials),
          });
      const snapshot = await adapter.fetchAccountSnapshot("DAY");
      const connection: DerivativeCredentialConnection = {
        state: "VERIFIED",
        authenticated: true,
        accountSynchronized: true,
        checkedAt: toIsoDateTime(),
        message: "한국투자증권 API 인증과 실제 선물 계좌 조회를 확인했습니다.",
      };
      const account: DerivativeCredentialAccountSummary = {
        maskedAccountId: maskAccount(credentials.accountId),
        accountProductCode: "03",
        positionCount: snapshot.positions.length,
        openOrderCount: snapshot.openOrders.length,
        observedAt: snapshot.observedAt,
        unavailableFields: snapshot.unavailableFields,
      };
      this.#derivativeCredentialConnections.set(environment, connection);
      this.#derivativeCredentialAccounts.set(environment, account);
      return { connection, account };
    } catch (error) {
      const accountBindingFailure = isDerivativeAccountBindingFailure(error);
      const connection: DerivativeCredentialConnection = {
        state: "FAILED",
        // OPSQ2000 is returned only after the access token and request headers
        // have been accepted.  It is an account/App-Key binding failure, not a
        // login or account-password failure.
        authenticated: accountBindingFailure,
        accountSynchronized: false,
        checkedAt: toIsoDateTime(),
        message: derivativeCredentialFailureMessage(error, reusedCashApiCredentials),
      };
      this.#derivativeCredentialConnections.set(environment, connection);
      this.#derivativeCredentialAccounts.delete(environment);
      this.recordError(error, "derivatives-credential-verify", undefined, "warning");
      return { connection };
    } finally {
      await adapter?.disconnect?.().catch((error: unknown) => {
        this.recordError(error, "derivatives-credential-disconnect", undefined, "warning");
      });
    }
  }

  async deleteDerivativeCredentials(environment: TradingEnvironment) {
    const status = await this.#credentialStore.statusDerivatives(environment);
    if (status.source === "environment") {
      throw new CredentialConflictError(
        "환경변수로 관리되는 선물·옵션 계좌정보는 웹 화면에서 삭제할 수 없습니다.",
      );
    }
    const credentials = status.configured
      ? await this.#credentialStore.getDerivatives(environment)
      : null;
    const deleted = await this.#credentialStore.deleteDerivatives(environment);
    if (deleted && credentials) {
      await createTokenStore(this.#dataDirectory).delete({
        brokerId: "koreainvestment",
        environment,
        accountId: `${credentials.accountId}-03`,
      }).catch((error: unknown) => {
        this.recordError(error, "derivatives-credential-token-delete", undefined, "warning");
      });
    }
    this.#derivativeCredentialConnections.delete(environment);
    this.#derivativeCredentialAccounts.delete(environment);
    await this.#derivatives.credentialsChanged(environment);
    this.#repository.appendAudit({
      actor: "web-console",
      action: deleted ? "DERIVATIVES_CREDENTIALS_DELETED" : "DERIVATIVES_CREDENTIALS_DELETE_NOOP",
      payload: { brokerId: "koreainvestment", environment, accountProductCode: "03" },
    });
    return {
      ok: true as const,
      deleted,
      ...(await this.derivativeCredentialsStatus(environment)),
    };
  }

  async derivativesDashboard() {
    return this.#derivatives.snapshot();
  }

  async derivativesSettingsResponse() {
    return {
      settings: this.#derivatives.settings,
      runtime: this.#derivatives.snapshot(),
      credentials: {
        live: await this.safeDerivativeCredentialStatus("live"),
        paper: await this.safeDerivativeCredentialStatus("paper"),
      },
    };
  }

  async updateDerivativesSettings(input: unknown) {
    const settings = this.#derivatives.updateSettings(input);
    this.#repository.appendAudit({
      actor: "web-console",
      action: "DERIVATIVES_SETTINGS_UPDATED",
      payload: redactSensitive(settings),
    });
    return this.derivativesSettingsResponse();
  }

  async controlDerivatives(action: "start" | "halt" | "pause-new" | "resume-new") {
    try {
      await this.#derivatives.control(action);
    } catch (error) {
      throw new ControlConflictError(error instanceof Error ? error.message : String(error));
    }
    return this.derivativesDashboard();
  }

  async reconcileDerivatives() {
    await this.#derivatives.sync(false);
    return this.derivativesDashboard();
  }

  async deleteCredentials(brokerId: BrokerId, environment: TradingEnvironment) {
    const status = await this.#credentialStore.status(brokerId, environment);
    if (status.source === "environment") {
      throw new CredentialConflictError(
        "환경변수로 관리되는 자격정보는 웹 화면에서 삭제할 수 없습니다.",
      );
    }

    const credentials = status.configured
      ? await this.#credentialStore.get(brokerId, environment)
      : null;
    const deleted = await this.#credentialStore.delete(brokerId, environment);

    if (deleted && credentials) {
      try {
        await createTokenStore(this.#dataDirectory).delete({
          brokerId,
          environment,
          accountId: credentials.accountId,
        });
      } catch (error) {
        this.recordError(
          error,
          "credential-token-delete",
          { brokerId, environment, accountId: "redacted" },
          "warning",
        );
      }
    }

    const activeCredentialWasRemoved =
      deleted &&
      this.#settings.brokers[brokerId].environment === environment;
    if (activeCredentialWasRemoved) {
      await this.enqueueLifecycle(async () => {
        const brokerSettings = this.#settings.brokers[brokerId];
        brokerSettings.enabled = false;
        brokerSettings.autoTradingEnabled = false;
        brokerSettings.newBuysPaused = true;
        this.#repository.setAppSettings(this.#settings);
        await this.rebuildRuntimes();
        await this.#marketData.start();
      });
    }

    this.#repository.appendAudit({
      actor: "web-console",
      action: deleted ? "CREDENTIALS_DELETED" : "CREDENTIALS_DELETE_NOOP",
      payload: { brokerId, environment },
    });
    return {
      ok: true as const,
      deleted,
      ...(await this.settingsResponse()),
    };
  }

  async control(action: string, brokerId?: BrokerId): Promise<void> {
    if (action === "halt-all") {
      this.#settings.emergencyHalt = true;
      this.#settings.globalAutoTradingEnabled = false;
      this.#settings.newBuysPaused = true;
    } else if (action === "resume-global") {
      const enabled = BROKER_IDS.filter((id) => this.#settings.brokers[id].enabled);
      if (enabled.length === 0) {
        throw new ControlConflictError("먼저 사용할 증권사의 ‘연결 사용’을 켜고 설정을 저장해 주세요.");
      }
      for (const id of enabled) {
        this.assertBrokerCanArm(id);
      }
      if (this.#repository.listOutbox({ statuses: ["BLOCKED", "FAILED"], limit: 1 }).length > 0) {
        throw new ControlConflictError("확인이 필요한 이전 주문이 있어 전체 정지를 해제할 수 없습니다. 주문·체결 기록을 확인해 주세요.");
      }
      this.#settings.emergencyHalt = false;
      this.#settings.globalAutoTradingEnabled = true;
      this.#settings.newBuysPaused = false;
      // Conditions observed while halted must be eligible for a fresh risk
      // check on the next quote after an explicit resume.
      this.#lastActions.clear();
      this.#lastEvaluatedAt.clear();
    } else if (action === "pause-new-buys") {
      this.#settings.newBuysPaused = true;
    } else if (action === "resume-new-buys") {
      if (this.#settings.emergencyHalt || !this.#settings.globalAutoTradingEnabled) {
        throw new ControlConflictError("먼저 전체 안전 정지를 해제해 주세요.");
      }
      this.#settings.newBuysPaused = false;
      this.#lastActions.clear();
      this.#lastEvaluatedAt.clear();
    } else if (action === "pause-broker") {
      if (!brokerId) throw new ControlConflictError("정지할 증권사를 지정해 주세요.");
      this.#settings.brokers[brokerId].autoTradingEnabled = false;
      this.#settings.brokers[brokerId].newBuysPaused = true;
    } else if (action === "start-broker") {
      if (!brokerId) {
        throw new ControlConflictError("자동매매를 시작할 증권사를 지정해 주세요.");
      }
      this.assertBrokerCanArm(brokerId);
      const fullStopWasActive =
        this.#settings.emergencyHalt || !this.#settings.globalAutoTradingEnabled;
      const buyOnlyPauseWasActive =
        !fullStopWasActive && this.#settings.newBuysPaused;
      if (fullStopWasActive) {
        // Opening a global gate for one broker must not silently reactivate a
        // second broker that happened to retain stale per-broker ON flags.
        for (const otherBrokerId of BROKER_IDS) {
          if (otherBrokerId === brokerId) continue;
          this.#settings.brokers[otherBrokerId].autoTradingEnabled = false;
          this.#settings.brokers[otherBrokerId].newBuysPaused = true;
        }
      } else if (buyOnlyPauseWasActive) {
        // Preserve automatic selling on other brokers, but do not implicitly
        // resume their new buys when the operator starts only this broker.
        for (const otherBrokerId of BROKER_IDS) {
          if (otherBrokerId === brokerId) continue;
          this.#settings.brokers[otherBrokerId].newBuysPaused = true;
        }
      }
      this.#settings.emergencyHalt = false;
      this.#settings.globalAutoTradingEnabled = true;
      this.#settings.newBuysPaused = false;
      this.#settings.brokers[brokerId].autoTradingEnabled = true;
      this.#settings.brokers[brokerId].newBuysPaused = false;
      // Conditions observed while paused must pass strategy and risk checks
      // again. Orders remain blocked until both the session is OPEN and this
      // broker has confirmed today's official market status.
      this.#lastActions.clear();
      this.#lastEvaluatedAt.clear();
    } else {
      throw new ControlConflictError("지원하지 않는 자동매매 제어 동작입니다.");
    }
    this.#repository.setAppSettings(this.#settings);
    this.#repository.appendAudit({
      actor: "web-console",
      action: `CONTROL_${action.toUpperCase().replaceAll("-", "_")}`,
      ...(brokerId && this.#runtimes.get(brokerId)
        ? { scope: this.#runtimes.get(brokerId)?.adapter.scope }
        : {}),
      ...(action === "start-broker" && brokerId
        ? {
            payload: {
              brokerId,
              marketStatusConfirmed:
                this.#runtimes.get(brokerId)?.marketStatusConfirmedDate === koreanTradingDate(),
              marketSession: this.#marketSession.state,
            },
          }
        : {}),
    });
  }

  async settingsResponse() {
    const credentialEntries = await Promise.all(
      BROKER_IDS.flatMap((brokerId) =>
        (["live", "paper"] as const).map(async (environment) => ({
          brokerId,
          environment,
          status: await this.safeCredentialStatus(brokerId, environment),
        })),
      ),
    );
    const credentials = {
      kiwoom: { live: credentialEntries.find((row) => row.brokerId === "kiwoom" && row.environment === "live")?.status, paper: credentialEntries.find((row) => row.brokerId === "kiwoom" && row.environment === "paper")?.status },
      koreainvestment: { live: credentialEntries.find((row) => row.brokerId === "koreainvestment" && row.environment === "live")?.status, paper: credentialEntries.find((row) => row.brokerId === "koreainvestment" && row.environment === "paper")?.status },
    };
    const missing = { configured: false, source: null, maskedAccountId: null } as const;
    const activeCredentials = {
      kiwoom: this.#settings.brokers.kiwoom.environment === "live"
        ? credentials.kiwoom.live ?? missing
        : credentials.kiwoom.paper ?? missing,
      koreainvestment: this.#settings.brokers.koreainvestment.environment === "live"
        ? credentials.koreainvestment.live ?? missing
        : credentials.koreainvestment.paper ?? missing,
    };
    return {
      settings: this.settings,
      credentials: {
        kiwoom: { live: credentials.kiwoom.live ?? missing, paper: credentials.kiwoom.paper ?? missing },
        koreainvestment: { live: credentials.koreainvestment.live ?? missing, paper: credentials.koreainvestment.paper ?? missing },
      },
      connections: {
        kiwoom: this.brokerConnection("kiwoom", activeCredentials.kiwoom.configured),
        koreainvestment: this.brokerConnection(
          "koreainvestment",
          activeCredentials.koreainvestment.configured,
        ),
      },
      strategies: this.#strategyRegistry.list(),
    };
  }

  async dashboard() {
    const tradingDate = koreanTradingDate();
    const since = startOfKoreanTradingDate(tradingDate);
    const positions: Array<Record<string, unknown>> = [];
    const orders: Array<Record<string, unknown>> = [];
    const executions: Array<Record<string, unknown>> = [];
    const brokerMetrics: Record<BrokerId, {
      pnl: { realized: number; unrealized: number; total: number };
      today: { orders: number; buys: number; sells: number };
    }> = {
      kiwoom: { pnl: { realized: 0, unrealized: 0, total: 0 }, today: { orders: 0, buys: 0, sells: 0 } },
      koreainvestment: { pnl: { realized: 0, unrealized: 0, total: 0 }, today: { orders: 0, buys: 0, sells: 0 } },
    };
    let realized = 0;
    let unrealized = 0;

    for (const runtime of this.#runtimes.values()) {
      const scope = runtime.adapter.scope;
      const masked = maskAccount(scope.accountId);
      for (const position of this.#repository.listPositions(scope)) {
        positions.push({
          brokerId: scope.brokerId,
          environment: scope.environment,
          accountIdMasked: masked,
          symbol: position.symbol,
          name: position.name ?? this.#repository.getInstrument(position.symbol)?.name ?? "",
          quantity: position.quantity,
          averagePrice: position.averagePrice,
          currentPrice: position.currentPrice,
          unrealizedPnl: position.unrealizedPnl,
          unrealizedPnlBps: position.unrealizedPnlBps,
        });
      }
      const scopedOrders = this.#repository
        .listOrders(scope, { limit: 20_000 })
        .filter((order) => order.orderedAt >= since)
        .slice(0, 500);
      for (const order of scopedOrders) {
        orders.push({
          id: order.id,
          brokerId: scope.brokerId,
          environment: scope.environment,
          symbol: order.symbol,
          name: this.#repository.getInstrument(order.symbol)?.name ?? "",
          side: order.side,
          orderType: order.orderType,
          quantity: order.orderedQuantity,
          filledQuantity: order.filledQuantity,
          limitPrice: order.limitPrice,
          status: order.status,
          exchange: order.exchange,
          createdAt: order.createdAt,
        });
      }
      for (const fill of this.#repository.listFills(scope, { since, limit: 500 })) {
        executions.push({
          id: fill.id,
          brokerId: scope.brokerId,
          symbol: fill.symbol,
          name: this.#repository.getInstrument(fill.symbol)?.name ?? "",
          side: fill.side,
          quantity: fill.quantity,
          price: fill.price,
          executedAt: fill.executedAt,
        });
      }
      const pnl = this.#repository.getDailyPnl(scope, tradingDate);
      const brokerRealized = pnl?.realizedPnl ?? 0;
      const brokerUnrealized = pnl?.unrealizedPnl ?? 0;
      brokerMetrics[scope.brokerId] = {
        pnl: {
          realized: brokerRealized,
          unrealized: brokerUnrealized,
          total: brokerRealized + brokerUnrealized,
        },
        today: {
          orders: scopedOrders.length,
          buys: scopedOrders.filter((order) => order.side === "buy").length,
          sells: scopedOrders.filter((order) => order.side === "sell").length,
        },
      };
      realized += brokerRealized;
      unrealized += brokerUnrealized;
    }

    orders.sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));
    executions.sort((left, right) => String(right.executedAt).localeCompare(String(left.executedAt)));
    const errors = this.#repository.listErrors({ since, limit: 100 }).map((row) => this.errorRow(row));
    const brokerRows = await Promise.all(BROKER_IDS.map((brokerId) => this.brokerDashboard(brokerId)));
    const candidates = [...this.#candidates.values()]
      .sort((left, right) => right.generatedAt.localeCompare(left.generatedAt))
      .map((row) => ({
        id: row.id,
        brokerId: row.scope.brokerId,
        symbol: row.symbol,
        name: row.name,
        action: row.action,
        price: row.price,
        reasonCodes: row.reasonCodes,
        generatedAt: row.generatedAt,
        source: row.source,
      }));
    const marketMetrics = this.#marketData.metrics;
    return {
      engine: {
        state: this.engineState(),
        startedAt: this.startedAt,
        emergencyHalt: this.#settings.emergencyHalt,
        globalAutoTradingEnabled: this.#settings.globalAutoTradingEnabled,
        newBuysPaused: this.#settings.newBuysPaused,
      },
      market: {
        universeCount: marketMetrics.universeCount,
        buyEligibleCount: marketMetrics.buyEligibleCount,
        restrictedInstrumentCount: marketMetrics.restrictedInstrumentCount,
        restrictionCounts: marketMetrics.restrictionCounts,
        liveSubscriptionCount: marketMetrics.liveSubscriptionCount,
        rotatingScanCount: marketMetrics.rotatingScanCount,
        scanProgressPercent: marketMetrics.scanProgressPercent,
        scanMode: marketMetrics.scanMode,
        lastScanCompletedAt: marketMetrics.lastScanCompletedAt,
        lastScanQuoteAt: marketMetrics.lastScanQuoteAt,
        candidatesCount: candidates.length,
        lastUniverseSyncAt: marketMetrics.lastUniverseSyncAt,
        sessions: this.#marketSession.sessions,
        session: this.#marketSession,
        dailyBarBackfill: { completed: marketMetrics.backfillCompleted, total: marketMetrics.backfillTotal },
        regime: marketMetrics.marketRegime,
      },
      pnl: { realized, unrealized, total: realized + unrealized },
      brokerMetrics,
      today: {
        orders: orders.length,
        buys: orders.filter((row) => row.side === "buy").length,
        sells: orders.filter((row) => row.side === "sell").length,
      },
      brokers: brokerRows,
      candidates,
      positions,
      orders,
      executions,
      errors,
    };
  }

  async cancelOrder(orderId: string): Promise<void> {
    const match = this.findRuntimeOrder(orderId);
    if (!match) throw new Error("주문을 찾을 수 없습니다.");
    const { runtime, order } = match;
    if (!order.brokerOrderId || order.remainingQuantity <= 0) throw new Error("취소 가능한 잔량이 없습니다.");
    this.#repository.applyOrderEvent({
      scope: runtime.adapter.scope,
      orderId: order.id,
      dedupeKey: `manual:cancel-request:${randomUUID()}`,
      eventType: "CANCEL_REQUESTED",
      toStatus: "CANCEL_REQUESTED",
      eventAt: toIsoDateTime(),
    });
    const result = await runtime.adapter.cancelOrder({
      clientOrderId: randomUUID(),
      brokerOrderId: order.brokerOrderId,
      symbol: order.symbol,
      remainingQuantity: order.remainingQuantity,
      exchange: order.exchange,
    });
    if (result.outcome !== "ACCEPTED") await this.reconcileRuntime(runtime);
  }

  async amendOrder(orderId: string, newLimitPrice: number, remainingQuantity?: number): Promise<void> {
    const match = this.findRuntimeOrder(orderId);
    if (!match) throw new Error("주문을 찾을 수 없습니다.");
    const { runtime, order } = match;
    if (!order.brokerOrderId || order.remainingQuantity <= 0) throw new Error("정정 가능한 잔량이 없습니다.");
    this.#repository.applyOrderEvent({
      scope: runtime.adapter.scope,
      orderId: order.id,
      dedupeKey: `manual:amend-request:${randomUUID()}`,
      eventType: "AMEND_REQUESTED",
      toStatus: "AMEND_REQUESTED",
      eventAt: toIsoDateTime(),
    });
    const result = await runtime.adapter.amendOrder({
      clientOrderId: randomUUID(),
      brokerOrderId: order.brokerOrderId,
      symbol: order.symbol,
      remainingQuantity: remainingQuantity ?? order.remainingQuantity,
      newLimitPrice,
      exchange: order.exchange,
    });
    if (result.outcome === "ACCEPTED") {
      this.#repository.applyOrderEvent({
        scope: runtime.adapter.scope,
        orderId: order.id,
        dedupeKey: `manual:amended:${randomUUID()}`,
        eventType: "AMEND_ACCEPTED",
        toStatus: "AMENDED",
        eventAt: toIsoDateTime(),
        ...(result.brokerOrderId ? { brokerOrderId: result.brokerOrderId } : {}),
        originalBrokerOrderId: order.brokerOrderId,
      });
    } else {
      await this.reconcileRuntime(runtime);
    }
  }

  private loadSettings(): AppSettings {
    const persisted = this.#repository.getAppSettings();
    if (!persisted) {
      const defaults = createDefaultSettings();
      this.#repository.setAppSettings(defaults);
      return defaults;
    }
    const parsed = AppSettingsSchema.safeParse(persisted);
    if (parsed.success) return parsed.data;
    const safe = createDefaultSettings();
    this.#repository.setAppSettings(safe);
    this.#repository.appendError({
      severity: "critical",
      code: "SETTINGS_INVALID",
      message: "저장된 설정 검증에 실패해 안전 기본값으로 복구했습니다.",
      details: parsed.error.flatten(),
    });
    return safe;
  }

  private async rebuildRuntimes(): Promise<void> {
    await this.#marketData.stop();
    await Promise.allSettled(
      [...this.#runtimes.values()].map(async (runtime) => {
        runtime.unsubscribe();
        if (runtime.reconcileTimer) clearTimeout(runtime.reconcileTimer);
        await runtime.adapter.disconnect();
      }),
    );
    this.#runtimes.clear();
    this.#candidates.clear();
    this.#lastActions.clear();
    this.#lastEvaluatedAt.clear();
    const tokenStore = createTokenStore(this.#dataDirectory);

    for (const brokerId of BROKER_IDS) {
      const settings = this.#settings.brokers[brokerId];
      if (!settings.enabled) continue;
      const credentials = await this.#credentialStore.get(brokerId, settings.environment).catch((error: unknown) => {
        this.recordError(error, "credential-load", { brokerId, environment: settings.environment, accountId: "unconfigured" });
        return null;
      });
      if (!credentials) {
        this.#repository.appendError({
          severity: "warning",
          code: "CREDENTIALS_MISSING",
          message: `${BROKER_NAMES[brokerId]} ${settings.environment} 자격증명이 설정되지 않았습니다.`,
        });
        continue;
      }
      const adapter: BrokerAdapter = this.#brokerAdapterFactory
        ? this.#brokerAdapterFactory({ brokerId, settings, credentials, tokenStore })
        : brokerId === "kiwoom"
          ? new KiwoomBrokerAdapter({
              environment: settings.environment,
              credentials,
              tokenStore,
              quoteExchange: this.orderRoute(settings),
              ...(envInteger("KIWOOM_QUOTE_BATCH_SIZE")
                ? { quoteBatchSize: envInteger("KIWOOM_QUOTE_BATCH_SIZE") }
                : {}),
            })
          : new KoreaInvestmentBrokerAdapter({
              environment: settings.environment,
              credentials,
              tokenStore,
              quoteExchange: this.orderRoute(settings),
              requestLimiter: this.kisRequestLimiter(settings.environment, credentials),
              ...(credentials.htsId ? { htsId: credentials.htsId } : {}),
              useHashkey: envBoolean("KIS_USE_HASHKEY", false),
            });
      const strategy = this.#strategyRegistry.get(settings.strategyId);
      const validatedConfig = strategy.validateConfig(settings.strategyConfig);
      const configHash = stableHash(validatedConfig);
      const strategyConfigId = `strategy-${stableHash({ id: strategy.id, version: strategy.version, configHash }).slice(0, 40)}`;
      this.#repository.createStrategyConfigVersion({
        id: strategyConfigId,
        strategyId: strategy.id,
        strategyVersion: strategy.version,
        config: validatedConfig,
        configHash,
      });
      this.#repository.assignStrategy({
        scope: adapter.scope,
        strategyConfigId,
        enabled: settings.autoTradingEnabled,
      });
      const runtime: BrokerRuntime = {
        adapter,
        settings,
        strategyConfigId,
        requiredDailyBars: strategy.requirements(validatedConfig).minimumDailyBars,
        intradayWindowSeconds: strategy.requirements(validatedConfig).intradayWindowSeconds ?? 0,
        reconciled: false,
        // Keep dispatch fail-closed until account reconciliation and durable
        // outbox recovery have both completed.
        recovering: true,
        marketStatusConfirmedDate: null,
        unsubscribe: () => undefined,
        orderTail: Promise.resolve(),
        reconcileTimer: null,
        reconcilePromise: null,
        accountEventVersion: 0,
      };
      runtime.unsubscribe = adapter.onEvent((event) => this.handleBrokerEvent(runtime, event));
      this.#runtimes.set(brokerId, runtime);
      try {
        await adapter.connect();
        await this.refreshMarketCalendar(adapter).catch((error: unknown) =>
          this.recordError(error, "market-calendar-sync", adapter.scope, "warning"),
        );
        await this.reconcileRuntime(runtime);
        await this.recoverOutbox(runtime);
      } catch (error) {
        this.recordError(error, "broker-startup", adapter.scope, "critical");
      } finally {
        runtime.recovering = false;
        // Do not retain action debounce state created by quotes which arrived
        // while startup recovery was still blocking orders.
        this.#lastActions.clear();
        this.#lastEvaluatedAt.clear();
      }
    }
  }

  private marketRuntimes(): MarketRuntimeView[] {
    return [...this.#runtimes.values()]
      .filter((runtime) => runtime.adapter.getHealth().restConnected)
      .map((runtime) => ({ adapter: runtime.adapter, requiredDailyBars: runtime.requiredDailyBars }));
  }

  private orderRoute(settings: BrokerRuntimeSettings): Exchange {
    // Both brokers document KRX-only paper trading. Keep the stored live route
    // intact so switching back to live does not silently change the operator's
    // choice, but never send NXT/SOR to a paper endpoint.
    return settings.environment === "paper" ? "KRX" : settings.orderRoute;
  }

  private isRuntimeOrderWindowOpen(adapter: BrokerAdapter): boolean {
    const settings = this.#settings.brokers[adapter.scope.brokerId];
    return this.#marketSession.orderableExchanges.includes(this.orderRoute(settings));
  }

  /**
   * Validate the durable account ledger and raw broker transports needed to
   * arm automatic trading. Market hours and today's official market-status
   * event are deliberately not prerequisites here: an operator may arm the
   * engine before the open, while enqueueOrder and RiskManager remain the
   * final fail-closed order gates.
   */
  private assertBrokerCanArm(brokerId: BrokerId): BrokerRuntime {
    const brokerName = BROKER_NAMES[brokerId];
    if (!this.#settings.brokers[brokerId].enabled) {
      throw new ControlConflictError(
        `${brokerName}의 ‘연결 사용’을 먼저 켜고 설정을 저장해 주세요.`,
      );
    }
    const runtime = this.#runtimes.get(brokerId);
    if (!runtime) {
      throw new ControlConflictError(
        `${brokerName} 연결이 실행되지 않았습니다. API 정보를 저장하고 연결 상태를 확인해 주세요.`,
      );
    }
    const health = runtime.adapter.getHealth();
    if (!health.restConnected) {
      throw new ControlConflictError(
        `${brokerName} API 인증 연결이 완료되지 않았습니다.`,
      );
    }
    if (!health.marketWebSocketConnected) {
      throw new ControlConflictError(
        `${brokerName} 실시간 시세 연결이 완료되지 않았습니다.`,
      );
    }
    if (!health.accountWebSocketConnected) {
      throw new ControlConflictError(
        `${brokerName} 주문·체결 실시간 연결이 완료되지 않았습니다.`,
      );
    }
    if (health.state !== "CONNECTED") {
      throw new ControlConflictError(
        `${brokerName} 연결 상태가 불안정합니다. 연결이 정상으로 바뀐 뒤 다시 시도해 주세요.`,
      );
    }
    if (
      hasUnresolvedUnknownOrders(this.#repository.listOrders(runtime.adapter.scope, {
        statuses: ["UNKNOWN"],
        limit: 20_000,
      })) ||
      this.#repository.listOutbox({
        scope: runtime.adapter.scope,
        statuses: ["BLOCKED", "FAILED"],
        limit: 1,
      }).length > 0
    ) {
      throw new ControlConflictError(
        `${brokerName}에 결과를 확인해야 하는 이전 주문이 있습니다. 주문·체결 기록을 먼저 확인해 주세요.`,
      );
    }
    if (!runtime.reconciled) {
      throw new ControlConflictError(
        `${brokerName} 계좌 잔고·주문·체결 동기화가 아직 끝나지 않았습니다.`,
      );
    }
    return runtime;
  }

  private runtimeHealth(runtime: BrokerRuntime): BrokerHealth {
    const health = runtime.adapter.getHealth();
    if (runtime.recovering && health.state === "CONNECTED") {
      return {
        ...health,
        state: "DEGRADED",
        lastError: "절전 또는 서버 중단 뒤 계좌 원장을 다시 확인하고 있습니다.",
      };
    }
    if (!runtime.reconciled && health.state === "CONNECTED") {
      return { ...health, state: "DEGRADED", lastError: "계좌 원장 동기화가 완료되지 않았습니다." };
    }
    return health;
  }

  private reconcileRuntime(runtime: BrokerRuntime): Promise<void> {
    if (runtime.reconcilePromise) return runtime.reconcilePromise;
    const run = this.reconcileRuntimeOnce(runtime).finally(() => {
      if (runtime.reconcilePromise === run) runtime.reconcilePromise = null;
    });
    runtime.reconcilePromise = run;
    return run;
  }

  private async reconcileRuntimeOnce(runtime: BrokerRuntime): Promise<void> {
    let reconciliationFailed = false;
    let ledgerChangedDuringFetch = false;
    const accountEventVersion = runtime.accountEventVersion;
    const scope = runtime.adapter.scope;
    const tradingDate = koreanTradingDate();
    const fromDate = scope.brokerId === "koreainvestment"
      ? compactTradingDate(tradingDate)
      : tradingDate;
    const [snapshot, executions] = await Promise.all([
      runtime.adapter.fetchAccountSnapshot(),
      runtime.adapter.fetchExecutions(fromDate),
    ]);
    this.#repository.replacePositions({ scope, positions: snapshot.positions, fetchedAt: snapshot.fetchedAt });
    this.#repository.saveBalanceSnapshot({
      scope,
      cash: snapshot.cash,
      availableCash: snapshot.availableCash,
      totalEvaluation: snapshot.totalEvaluation,
      realizedPnlToday: snapshot.realizedPnlToday,
      unrealizedPnl: snapshot.unrealizedPnl,
      fetchedAt: snapshot.fetchedAt,
    });
    this.#repository.upsertDailyPnl({
      scope,
      tradingDate,
      realizedPnl: snapshot.realizedPnlToday,
      unrealizedPnl: snapshot.unrealizedPnl,
      totalPnl: snapshot.realizedPnlToday + snapshot.unrealizedPnl,
      totalEvaluation: snapshot.totalEvaluation,
    });
    for (const order of snapshot.openOrders) {
      const previous = this.#repository.findOrderByBrokerId(scope, order.brokerOrderId);
      const current = this.#repository.upsertReconciledOrder({ scope, brokerOrder: order });
      if (current.filledQuantity > (previous?.filledQuantity ?? 0)) ledgerChangedDuringFetch = true;
    }
    for (const execution of executions) {
      try {
        if (this.#repository.recordExecution({ scope, execution }).inserted) ledgerChangedDuringFetch = true;
      } catch (error) {
        reconciliationFailed = true;
        this.recordError(error, `execution-reconcile:${execution.executionId}`, scope);
      }
    }

    const remoteIds = new Set(snapshot.openOrders.map((order) => order.brokerOrderId));
    const missingBrokerOrders = this.#repository
      .listOpenOrders(scope)
      .filter(
        (order) =>
          order.brokerOrderId !== null && !remoteIds.has(order.brokerOrderId),
      );
    if (missingBrokerOrders.length > 0 && runtime.adapter.fetchOrderHistory) {
      try {
        const history = await runtime.adapter.fetchOrderHistory(fromDate);
        for (const order of history) {
          const previous = this.#repository.findOrderByBrokerId(scope, order.brokerOrderId);
          const current = this.#repository.upsertReconciledOrder({ scope, brokerOrder: order });
          if (current.filledQuantity > (previous?.filledQuantity ?? 0) ||
            (current.status !== previous?.status && ["FILLED", "CANCELED", "REJECTED"].includes(current.status))) {
            ledgerChangedDuringFetch = true;
          }
        }
        // Cancellation requests have their own broker order number. Resolve a
        // missing original order only when history explicitly confirms that
        // linked cancellation; a rejected/unconfirmed cancellation must never
        // be mistaken for a canceled original order.
        for (const cancellation of history) {
          if (
            cancellation.status !== "CANCELED" ||
            cancellation.originalBrokerOrderId === undefined
          ) continue;
          const original = missingBrokerOrders.find(
            (candidate) => candidate.brokerOrderId === cancellation.originalBrokerOrderId,
          );
          if (!original?.brokerOrderId) continue;
          const previous = this.#repository.getOrder(original.id, scope);
          if (previous?.status !== "CANCELED") ledgerChangedDuringFetch = true;
          this.#repository.upsertReconciledOrder({
            scope,
            brokerOrder: {
              brokerOrderId: original.brokerOrderId,
              symbol: original.symbol,
              side: original.side,
              orderType: original.orderType,
              orderedQuantity: original.orderedQuantity,
              filledQuantity: original.filledQuantity,
              remainingQuantity: 0,
              ...(original.limitPrice === null ? {} : { limitPrice: original.limitPrice }),
              status: "CANCELED",
              orderedAt: original.orderedAt,
              raw: {
                recovery: "confirmed-linked-cancellation",
                cancellationBrokerOrderId: cancellation.brokerOrderId,
              },
            },
          });
        }
      } catch (error) {
        reconciliationFailed = true;
        this.recordError(error, "order-history-reconcile", scope);
      }
    }
    for (const local of this.#repository.listOpenOrders(scope)) {
      if (!local.brokerOrderId || remoteIds.has(local.brokerOrderId)) continue;
      const refreshed = this.#repository.getOrder(local.id, scope);
      if (
        !refreshed ||
        refreshed.status === "FILLED" ||
        refreshed.status === "CANCELED" ||
        refreshed.status === "REJECTED"
      ) continue;
      this.#repository.applyOrderEvent({
        scope,
        orderId: refreshed.id,
        dedupeKey: `reconcile:unconfirmed:${tradingDate}:${refreshed.id}`,
        eventType:
          refreshed.status === "CANCEL_REQUESTED"
            ? "BROKER_CANCEL_UNCONFIRMED"
            : "BROKER_ORDER_MISSING",
        toStatus: "UNKNOWN",
        eventAt: toIsoDateTime(),
        raw: { brokerOrderId: refreshed.brokerOrderId },
      });
    }

    // A broker execution discovered without the original order quantity is
    // retained as UNKNOWN for audit accuracy.  Once its inferred remaining
    // quantity is zero it is historical, not an order that can still execute.
    // UNKNOWN rows with a positive remainder continue to block all ordering.
    const unresolved = hasUnresolvedUnknownOrders(
      this.#repository.listOrders(scope, { statuses: ["UNKNOWN"], limit: 20_000 }),
    );
    const blocked = this.#repository.listOutbox({ scope, statuses: ["BLOCKED", "FAILED"], limit: 1 }).length > 0;
    runtime.reconciled =
      !reconciliationFailed &&
      !ledgerChangedDuringFetch &&
      runtime.accountEventVersion === accountEventVersion &&
      !unresolved &&
      !blocked &&
      runtime.adapter.getHealth().state === "CONNECTED";
    if (runtime.reconciled) {
      this.#positionLifecycle.synchronize(
        scope,
        snapshot.positions,
        this.#repository.listFills(scope, { limit: 20_000 }),
        snapshot.fetchedAt,
      );
    } else if (ledgerChangedDuringFetch || runtime.accountEventVersion !== accountEventVersion) {
      // Parallel account/history reads are not an atomic broker snapshot. If a
      // new fill or terminal order was discovered, obtain another balance after
      // that observation before releasing the retry gate.
      this.scheduleReconcile(runtime);
    }
    this.#repository.appendHealthEvent(scope, this.runtimeHealth(runtime));
  }

  private async recoverOutbox(runtime: BrokerRuntime): Promise<void> {
    const pending = this.#repository.listOutbox({
      scope: runtime.adapter.scope,
      statuses: ["PENDING", "PROCESSING"],
      limit: 1_000,
    });
    for (const outbox of pending) {
      const order = this.#repository
        .listOrders(runtime.adapter.scope, { limit: 20_000 })
        .find((candidate) => candidate.intentId === outbox.aggregateId);
      if (!order) {
        this.#repository.failOutbox(outbox.id, "Order projection missing for persisted intent");
        runtime.reconciled = false;
        continue;
      }
      if (order.status !== "QUEUED") {
        if (order.status === "SENDING") {
          this.#repository.applyOrderEvent({
            scope: runtime.adapter.scope,
            orderId: order.id,
            dedupeKey: `recovery:unknown:${order.id}`,
            eventType: "RECOVERY_INDETERMINATE",
            toStatus: "UNKNOWN",
            eventAt: toIsoDateTime(),
          });
          this.#repository.blockOutbox(
            outbox.id,
            "Engine restarted after transmission began; broker acceptance is indeterminate",
          );
          runtime.reconciled = false;
        } else {
          this.#repository.markOutboxDone(outbox.id);
        }
        continue;
      }
      // A QUEUED row is an unsent intent. Replaying it after a restart would
      // bypass the current market session, quote freshness, balance and risk
      // checks, so expire it instead of ever transmitting stale work.
      this.#repository.applyOrderEvent({
        scope: runtime.adapter.scope,
        orderId: order.id,
        dedupeKey: `recovery:unsent-expired:${order.id}`,
        eventType: "RECOVERY_UNSENT_EXPIRED",
        toStatus: "REJECTED",
        eventAt: toIsoDateTime(),
      });
      if (order.intentId) {
        this.#repository.setRiskReservationStatus(order.intentId, "RELEASED");
      }
      this.#repository.markOutboxDone(outbox.id);
      this.#repository.appendAudit({
        actor: "trading-engine",
        action: "RECOVERY_UNSENT_ORDER_EXPIRED",
        scope: runtime.adapter.scope,
        entityType: "order",
        entityId: order.id,
      });
    }
  }

  private handleBrokerEvent(runtime: BrokerRuntime, event: BrokerEvent): void {
    try {
      if (event.type === "quote") {
        if (this.isRuntimeOrderWindowOpen(runtime.adapter) &&
          event.quote.source === runtime.adapter.scope.brokerId &&
          event.quote.exchange === this.orderRoute(runtime.settings)) {
          this.#intradayTape.observe(runtime.adapter.scope, event.quote);
        }
        void this.#marketData.handleRealtimeQuote(runtime.adapter, event.quote);
      } else if (event.type === "order") {
        const previous = this.#repository.findOrderByBrokerId(runtime.adapter.scope, event.order.brokerOrderId);
        const current = this.#repository.upsertReconciledOrder({ scope: runtime.adapter.scope, brokerOrder: event.order });
        if (
          current.filledQuantity > (previous?.filledQuantity ?? 0) ||
          (current.status !== previous?.status && ["FILLED", "CANCELED", "REJECTED"].includes(current.status))
        ) {
          // Order notifications may precede executions. Never retry against the
          // old balance merely because an order has disappeared from open orders.
          runtime.accountEventVersion += 1;
          runtime.reconciled = false;
          this.scheduleReconcile(runtime);
        }
      } else if (event.type === "execution") {
        if (!runtime.reconciled) {
          runtime.accountEventVersion += 1;
          this.scheduleReconcile(runtime);
          return;
        }
        const recorded = this.#repository.recordExecution({
          scope: runtime.adapter.scope,
          execution: event.execution,
        });
        // Brokers can replay the same execution notification. A duplicate is
        // already represented in both the durable fill ledger and the latest
        // account snapshot, so it must not repeatedly put the UI/order gate
        // back into ACCOUNT_SYNCING. A genuinely new fill still fails closed
        // until the authoritative account snapshot catches up.
        if (recorded.inserted) {
          runtime.accountEventVersion += 1;
          runtime.reconciled = false;
          this.scheduleReconcile(runtime);
        }
      } else if (event.type === "position") {
        const current = this.#repository.getPosition(
          runtime.adapter.scope,
          event.position.symbol,
        );
        if (positionLedgerChanged(current, event.position)) {
          runtime.accountEventVersion += 1;
          runtime.reconciled = false;
          this.scheduleReconcile(runtime);
        }
      } else if (event.type === "market-status") {
        const previousSession = this.#marketSession;
        const route = this.orderRoute(runtime.settings);
        const statusExchange = event.status.exchange ?? "KRX";
        const observedTradingDate = koreanTradingDate(new Date(event.status.observedAt));
        if (statusExchange === "KRX") {
          this.#marketClock.applyBrokerStatus(
            event.status.state,
            event.status.observedAt,
          );
        }
        this.#marketSession = this.#marketClock.current();
        this.invalidateConfirmationsForClosedOrReopenedRoutes(
          previousSession,
          this.#marketSession,
        );
        const statusIsRelevant = route === statusExchange || route === "SOR";
        if (
          statusIsRelevant &&
          event.status.state === "OPEN" &&
          this.isRuntimeOrderWindowOpen(runtime.adapter)
        ) {
          runtime.marketStatusConfirmedDate = observedTradingDate;
        } else if (
          route === statusExchange ||
          (route === "SOR" && !this.isRuntimeOrderWindowOpen(runtime.adapter))
        ) {
          // A KRX close must not erase NXT-only confirmation, nor SOR
          // confirmation while SOR can still route through NXT.
          runtime.marketStatusConfirmedDate = null;
        }
        this.#repository.setRuntimeState(
          null,
          "market-session",
          this.#marketSession,
        );
        if (marketVenueSignature(previousSession) !== marketVenueSignature(this.#marketSession)) {
          void this.handleMarketTransition(this.#marketSession, previousSession);
        }
        if (runtime.marketStatusConfirmedDate === observedTradingDate) {
          this.#lastActions.clear();
          this.#lastEvaluatedAt.clear();
        }
      } else if (event.type === "health") {
        this.#repository.appendHealthEvent(runtime.adapter.scope, event.health);
        if (event.health.state !== "CONNECTED") {
          if (!event.health.marketWebSocketConnected) this.#intradayTape.resetScope(runtime.adapter.scope);
          runtime.reconciled = false;
          runtime.marketStatusConfirmedDate = null;
          if (runtime.adapter.scope.brokerId === "kiwoom") {
            this.#marketClock.clearBrokerStatus();
            this.#marketSession = this.#marketClock.current();
            this.#repository.setRuntimeState(
              null,
              "market-session",
              this.#marketSession,
            );
          }
        } else if (!runtime.reconciled) {
          this.scheduleReconcile(runtime);
        }
      } else if (event.type === "error") {
        this.#repository.appendError({
          scope: runtime.adapter.scope,
          severity: "error",
          code: event.error.code,
          message: event.error.message,
          occurredAt: event.error.at,
        });
      }
    } catch (error) {
      this.recordError(error, `broker-event:${event.type}`, runtime.adapter.scope);
    }
  }

  private scheduleReconcile(runtime: BrokerRuntime): void {
    if (runtime.reconcileTimer || this.#stopping) return;
    runtime.reconcileTimer = setTimeout(() => {
      runtime.reconcileTimer = null;
      void this.reconcileRuntime(runtime).catch((error: unknown) => {
        runtime.reconciled = false;
        this.recordError(error, "scheduled-reconcile", runtime.adapter.scope);
      });
    }, 1_000);
    runtime.reconcileTimer.unref?.();
  }

  private async evaluateQuote(
    adapter: BrokerAdapter,
    rawQuote: Quote,
    options: { snapshotOnly?: boolean } = {},
  ): Promise<void> {
    const runtime = this.#runtimes.get(adapter.scope.brokerId);
    if (!runtime || scopeKey(runtime.adapter.scope) !== scopeKey(adapter.scope)) return;
    const snapshotOnly = options.snapshotOnly === true;
    const quote = normalizeQuoteTradingDate(rawQuote);
    if (
      quote.source !== adapter.scope.brokerId ||
      quote.exchange !== this.orderRoute(runtime.settings)
    ) {
      this.#candidates.delete(candidateKey(adapter.scope, quote.symbol));
      return;
    }
    if (!snapshotOnly) {
      this.confirmOrderWindowFromQuote(runtime, quote);
      if (!this.isRuntimeOrderWindowOpen(adapter)) return;
      if (quote.stale === true) return;
      const quoteAge = Date.now() - Date.parse(quote.receivedAt);
      if (!Number.isFinite(quoteAge) || quoteAge < -5_000 || quoteAge > this.#settings.staleQuoteMs) return;
      if (
        (quote.source === "kiwoom" || quote.brokerTimestampVerified === true) &&
        !isFreshVerifiedBrokerQuote(quote, new Date(), this.#settings.staleQuoteMs)
      ) return;
    }
    const key = candidateKey(adapter.scope, quote.symbol);
    if (this.#evaluating.has(key)) return;
    const evaluationTime = Date.now();
    const previousEvaluation = this.#lastEvaluatedAt.get(key);
    if (
      !snapshotOnly &&
      previousEvaluation !== undefined &&
      evaluationTime - previousEvaluation < (runtime.settings.orderPolicy.signalEvaluationSeconds === undefined
        ? this.#settings.scanIntervalMs : runtime.settings.orderPolicy.signalEvaluationSeconds * 1_000)
    ) return;
    if (!snapshotOnly) this.#lastEvaluatedAt.set(key, evaluationTime);
    this.#evaluating.add(key);
    try {
      const position = this.#repository.getPosition(adapter.scope, quote.symbol);
      const instrument = this.#repository.getInstrument(quote.symbol);
      if ((position?.quantity ?? 0) <= 0 && !isInstrumentBuyAllowed(instrument)) {
        this.#candidates.delete(key);
        if (!snapshotOnly) this.#lastActions.set(key, "HOLD");
        return;
      }
      let bars = [] as ReturnType<TradingRepository["listDailyBars"]>;
      let config: unknown = null;
      let decision: StrategyDecision;
      const canObservePosition = !snapshotOnly && runtime.reconciled && !runtime.recovering;
      const cycle = canObservePosition
        ? this.#positionLifecycle.observeQuote(adapter.scope, quote)
        : this.#positionLifecycle.get(adapter.scope, quote.symbol);
      const exitPolicy = runtime.settings.orderPolicy;
      const exitPolicyKey = positionExitPolicyKey(exitPolicy);
      const latchedExit = cycle?.exitPolicyKey === exitPolicyKey ? cycle.exitDecision : null;
      const latchStillEnabled = latchedExit?.reasonCodes.some((reason) =>
        reason === "STOP_LOSS_TRIGGERED" ? exitPolicy.stopLossEnabled
          : reason === "TAKE_PROFIT_TARGET_REACHED" ? exitPolicy.takeProfitEnabled
            : reason === "TRAILING_PROFIT_TRIGGERED" ? exitPolicy.trailingProfitEnabled
              : reason === "STAGNATION_EXIT_TRIGGERED" ? exitPolicy.stagnationExitEnabled
                : reason === "MAX_HOLDING_TIME_REACHED" ? exitPolicy.maxHoldingMinutes > 0 && !exitPolicy.timedExitOnlyWithoutNetProfit
                : false);
      const freshExitDecision = evaluatePositionExitPolicy({
        position,
        quote,
        orderPolicy: exitPolicy,
        ...(cycle?.peakPrice ? { peakPrice: cycle.peakPrice } : {}),
        ...(cycle?.openedAt ? {
          completedHoldingSessions: this.#marketClock.completedHoldingSessions(cycle.openedAt, new Date(quote.receivedAt)),
          heldForMs: Date.parse(verifiedQuoteObservedAt(quote) ?? quote.receivedAt) - Date.parse(cycle.openedAt),
        } : {}),
      });
      // A previous profit exit must never delay a new stop/time exit. Net-profit
      // exits and conditional time exits are rechecked at the current price.
      const urgentExit = freshExitDecision?.reasonCodes.some((reason) =>
        reason === "STOP_LOSS_TRIGGERED" || reason === "MAX_HOLDING_TIME_REACHED");
      const accountExitDecision = urgentExit ? freshExitDecision
        : (position?.quantity ?? 0) > 0 && latchStillEnabled ? latchedExit! : freshExitDecision;
      if (canObservePosition) {
        this.#positionLifecycle.rememberExit(adapter.scope, quote.symbol, accountExitDecision, exitPolicyKey);
      }
      if (accountExitDecision) {
        decision = accountExitDecision;
      } else {
        if (runtime.requiredDailyBars > 0 && !this.#marketData.isDailyBarsReady(quote.symbol)) return;
        const strategy = this.#strategyRegistry.get(runtime.settings.strategyId);
        config = strategy.validateConfig(runtime.settings.strategyConfig);
        bars = this.#repository.listDailyBars(quote.symbol, {
          limit: runtime.requiredDailyBars + 1,
        }).filter((bar) => bar.tradingDate < quote.tradingDate).slice(-runtime.requiredDailyBars);
        decision = strategy.evaluate(
          {
            symbol: quote.symbol,
            completedDailyBars: bars,
            quote,
            hasPosition: (position?.quantity ?? 0) > 0,
            ...(runtime.intradayWindowSeconds > 0 ? {
              recentTradeSamples: snapshotOnly ? [] : this.#intradayTape.samples(
                adapter.scope, this.orderRoute(runtime.settings), quote.symbol,
                new Date(evaluationTime), runtime.intradayWindowSeconds,
              ),
            } : {}),
          },
          config,
        );
      }
      if (runtime.intradayWindowSeconds > 0 && !snapshotOnly) {
        this.#intradayReadiness.set(key, { evaluatedAt: evaluationTime, ready: decision.action !== "NOT_READY" });
      }
      if ((position?.quantity ?? 0) <= 0) {
        decision = this.#positionLifecycle.filterReentry(
          adapter.scope, quote.symbol, decision,
          exitPolicy.reentryCooldownSeconds === undefined ? exitPolicy.reentryCooldownMinutes : exitPolicy.reentryCooldownSeconds / 60,
          verifiedQuoteObservedAt(quote) ?? quote.receivedAt, canObservePosition,
        );
      }
      if (!snapshotOnly) this.#lastActions.set(key, decision.action);
      if (decision.action === "BUY" || decision.action === "SELL") {
        const signalId = `signal-${stableHash({
          scope: adapter.scope,
          strategyConfigId: runtime.strategyConfigId,
          symbol: quote.symbol,
          action: decision.action,
          receivedAt: quote.receivedAt,
          metrics: decision.metrics,
          attemptWindow: Math.floor(evaluationTime / (exitPolicy.orderRetrySeconds * 1_000)),
        }).slice(0, 48)}`;
        const name = this.#repository.getInstrument(quote.symbol)?.name ?? "";
        this.#candidates.set(key, {
          id: signalId,
          scope: adapter.scope,
          symbol: quote.symbol,
          name,
          action: decision.action,
          price: quote.price,
          reasonCodes: decision.reasonCodes,
          generatedAt: quote.receivedAt,
          source: snapshotOnly ? "LAST_SAVED" : "LIVE",
        });
        const attemptKey = `automatic-order-attempt:${quote.symbol}`;
        const lastAttemptAt = this.#repository.getRuntimeState<number>(adapter.scope, attemptKey) ?? 0;
        const activeOrder = this.#repository.listOpenOrders(adapter.scope)
          .some((order) => order.symbol === quote.symbol);
        if (
          canObservePosition &&
          !activeOrder &&
          evaluationTime - lastAttemptAt >= exitPolicy.orderRetrySeconds * 1_000
        ) {
          // A canceled remainder or recovered connection must not leave an
          // unchanged SELL/BUY signal asleep forever. Re-evaluate at a bounded
          // rate; active-order and intent guards still prevent duplicate sends.
          this.#repository.setRuntimeState(adapter.scope, attemptKey, evaluationTime);
          const inserted = this.#repository.insertSignal({
            id: signalId,
            scope: adapter.scope,
            strategyConfigId: runtime.strategyConfigId,
            symbol: quote.symbol,
            action: decision.action,
            reasonCodes: decision.reasonCodes,
            metrics: decision.metrics,
            inputHash: stableHash({
              bars: bars.map((bar) => [bar.tradingDate, bar.close, bar.volume]),
              quote,
              config,
              accountExitPolicy: accountExitDecision !== null,
              positionAveragePrice: position?.averagePrice ?? null,
              attemptWindow: Math.floor(evaluationTime / (exitPolicy.orderRetrySeconds * 1_000)),
            }),
            observedAt: quote.receivedAt,
          });
          if (inserted.inserted && !runtime.recovering) {
            this.enqueueOrder(runtime, inserted.signal, quote);
          }
        }
      } else {
        this.#candidates.delete(key);
      }
    } catch (error) {
      this.recordError(error, `strategy-evaluate:${quote.symbol}`, adapter.scope);
    } finally {
      this.#evaluating.delete(key);
    }
  }

  private confirmOrderWindowFromQuote(runtime: BrokerRuntime, quote: Quote): void {
    const now = new Date();
    const tradingDate = koreanTradingDate(now);
    const route = this.orderRoute(runtime.settings);
    if (
      runtime.marketStatusConfirmedDate === tradingDate ||
      !runtime.reconciled ||
      !this.isRuntimeOrderWindowOpen(runtime.adapter) ||
      !this.#marketSession.isTradingDay ||
      quote.exchange !== route ||
      !isFreshVerifiedBrokerQuote(quote, now, this.#settings.staleQuoteMs)
    ) {
      return;
    }
    const health = runtime.adapter.getHealth();
    if (
      health.state !== "CONNECTED" ||
      !health.restConnected ||
      !health.marketWebSocketConnected ||
      !health.accountWebSocketConnected
    ) {
      return;
    }
    runtime.marketStatusConfirmedDate = tradingDate;
    this.#lastActions.clear();
    this.#lastEvaluatedAt.clear();
    this.#repository.appendAudit({
      actor: "market-clock",
      action: "BROKER_ORDER_WINDOW_CONFIRMED_FROM_FRESH_QUOTE",
      scope: runtime.adapter.scope,
      payload: {
        route,
        symbol: quote.symbol,
        tradingDate: quote.tradingDate,
        tradingTime: quote.tradingTime,
      },
    });
  }

  private enqueueOrder(runtime: BrokerRuntime, signal: SignalRecord, quote: Quote): void {
    runtime.orderTail = runtime.orderTail
      .then(async () => {
        const scope = runtime.adapter.scope;
        if (
          runtime.recovering ||
          !runtime.reconciled ||
          runtime.marketStatusConfirmedDate !== koreanTradingDate() ||
          !this.isRuntimeOrderWindowOpen(runtime.adapter)
        ) return;
        if (
          hasUnresolvedUnknownOrders(
            this.#repository.listOrders(scope, { statuses: ["UNKNOWN"], limit: 20_000 }),
          ) ||
          this.#repository.listOutbox({
            scope,
            statuses: ["BLOCKED", "FAILED"],
            limit: 1,
          }).length > 0
        ) {
          runtime.reconciled = false;
          return;
        }
        const tradingDate = koreanTradingDate();
        const since = startOfKoreanTradingDate(tradingDate);
        const positions = this.#repository.listPositions(scope);
        const openOrders = this.#repository.listOpenOrders(scope).map(asBrokerOrder);
        const fills = this.#repository.listFills(scope, { since, limit: 20_000 });
        const dailyInvestedAmount = fills
          .filter((fill) => fill.side === "buy")
          .reduce((sum, fill) => sum + fill.quantity * fill.price, 0);
        const pnl = this.#repository.getDailyPnl(scope, tradingDate);
        const balance = this.#repository.getLatestBalanceSnapshot(scope);
        const instrument = this.#repository.getInstrument(signal.symbol);
        const instrumentSafety = instrument
          ? readInstrumentSafetyMetadata(instrument)
          : {
              source: "instrument-not-found",
              buyAllowed: false,
              restrictionCodes: [] as string[],
            };
        const marketRegime = this.#marketData.metrics.marketRegime;
        const result = await this.#orderDispatcher.dispatch({
          adapter: runtime.adapter,
          appSettings: this.#settings,
          brokerSettings: this.#settings.brokers[scope.brokerId],
          signal,
          quote,
          health: this.runtimeHealth(runtime),
          riskContext: {
            positions,
            openOrders,
            dailyInvestedAmount,
            dailyTotalPnl: pnl?.totalPnl ?? 0,
            reservedAmount: this.#repository.getActiveReservedAmount(scope),
            availableCash: balance?.availableCash ?? null,
            instrumentBuyAllowed: instrumentSafety.buyAllowed,
            instrumentRestrictionCodes: instrumentSafety.restrictionCodes,
            marketRegimeBuyAllowed: marketRegime.buyAllowed,
            marketRegimeReasonCode: `MARKET_REGIME_${marketRegime.reasonCode}`,
            marketOpen: this.isRuntimeOrderWindowOpen(runtime.adapter),
          },
        });
        if (result.outcome === "INDETERMINATE") {
          runtime.reconciled = false;
          this.scheduleReconcile(runtime);
        }
      })
      .catch((error: unknown) => this.recordError(error, "order-dispatch", runtime.adapter.scope, "critical"));
  }

  private prioritySymbols(scope: AccountScope): string[] {
    const positions = this.#repository.listPositions(scope).map((row) => row.symbol);
    const orders = this.#repository.listOpenOrders(scope).map((row) => row.symbol);
    const candidates = [...this.#candidates.values()].filter((row) => scopeKey(row.scope) === scopeKey(scope));
    const runtime = this.#runtimes.get(scope.brokerId);
    if (runtime && runtime.intradayWindowSeconds > 0) {
      const focusKey = scopeKey(scope);
      let focus = this.#intradayFocus.get(focusKey);
      if (!focus || focus.symbols.length === 0 || Date.now() - focus.selectedAt >= 300_000) {
        const route = this.orderRoute(runtime.settings);
        const quotes = this.#repository.listLatestQuotes(scope.brokerId)
          .filter((quote) => quote.exchange === route && Number.isFinite(quote.price) && quote.price > 0 &&
            quote.cumulativeVolume > 0 && isInstrumentBuyAllowed(this.#repository.getInstrument(quote.symbol)))
          .sort((a, b) => b.price * b.cumulativeVolume - a.price * a.cumulativeVolume || a.symbol.localeCompare(b.symbol));
        focus = { selectedAt: Date.now(), symbols: quotes.slice(0, runtime.adapter.capabilities.maxQuoteSubscriptions).map((quote) => quote.symbol) };
        this.#intradayFocus.set(focusKey, focus);
      }
      return [...new Set([...positions, ...orders, "005930", ...focus.symbols])];
    }
    return [
      "005930",
      ...positions,
      ...orders,
      ...candidates.filter((row) => row.action === "SELL").map((row) => row.symbol),
      ...candidates.filter((row) => row.action === "BUY").map((row) => row.symbol),
    ];
  }

  private derivativesEquityExposureKrw(): number[] | null {
    const enabledBrokerIds = BROKER_IDS.filter((brokerId) => this.#settings.brokers[brokerId].enabled);
    if (enabledBrokerIds.length === 0) return null;
    const exposures: number[] = [];
    for (const brokerId of enabledBrokerIds) {
      const runtime = this.#runtimes.get(brokerId);
      if (
        !runtime
        || !runtime.reconciled
        || runtime.recovering
        || !runtime.adapter.getHealth().restConnected
      ) {
        return null;
      }
      const total = this.#repository
        .listPositions(runtime.adapter.scope)
        .reduce((sum, position) => sum + Math.max(0, Math.round(position.marketValue)), 0);
      if (!Number.isSafeInteger(total) || total < 0) return null;
      exposures.push(total);
    }
    return exposures;
  }

  private invalidateConfirmationsForClosedOrReopenedRoutes(
    previous: MarketSession,
    current: MarketSession,
  ): void {
    for (const runtime of this.#runtimes.values()) {
      const route = this.orderRoute(runtime.settings);
      if (didOrderRouteWindowChange(previous, current, route)) {
        runtime.marketStatusConfirmedDate = null;
        this.#intradayTape.resetScope(runtime.adapter.scope);
      }
    }
  }

  private async handleMarketTransition(current: MarketSession, previous: MarketSession): Promise<void> {
    this.#repository.appendAudit({
      actor: "market-clock",
      action: "MARKET_SESSION_CHANGED",
      payload: {
        previous: previous.state,
        current: current.state,
        tradingDate: current.tradingDate,
      },
    });
    if (current.state === "PREOPEN" || current.state === "OPEN" || current.state === "AFTER_HOURS") {
      for (const runtime of this.#runtimes.values()) {
        try {
          await this.refreshMarketCalendar(runtime.adapter);
        } catch (error) {
          this.recordError(
            error,
            "market-calendar-refresh",
            runtime.adapter.scope,
            "warning",
          );
        }
      }
      await this.reconcileAll();
    }
    if (current.state === "OPEN") {
      this.#lastActions.clear();
      this.#lastEvaluatedAt.clear();
    }
    // NXT has several opens and breaks per day. Adjust subscriptions and
    // replay closed-route quotes without reloading the entire KOSPI universe
    // and daily history at every boundary.
    await this.#marketData.refreshForSessionChange();
  }

  private async refreshMarketCalendar(adapter: BrokerAdapter): Promise<void> {
    if (!adapter.fetchMarketCalendar) return;
    const tradingDate = koreanTradingDate();
    if (this.#calendarSyncDate === tradingDate) return;
    const days = await adapter.fetchMarketCalendar(compactTradingDate(tradingDate), 370);
    this.#marketClock.applyOfficialCalendar(days);
    this.#calendarSyncDate = tradingDate;
    this.#marketSession = this.#marketClock.current();
    this.#repository.setRuntimeState<PersistedMarketCalendar>(null, "market-calendar", {
      syncedTradingDate: tradingDate,
      syncedAt: toIsoDateTime(),
      days,
    });
  }

  private async reconcileAll(): Promise<void> {
    for (const runtime of this.#runtimes.values()) {
      if (!runtime.adapter.getHealth().restConnected) continue;
      try {
        await this.reconcileRuntime(runtime);
      } catch (error) {
        runtime.reconciled = false;
        this.recordError(error, "account-reconcile", runtime.adapter.scope, "critical");
      }
    }
  }

  private startMaintenance(): void {
    this.#maintenanceTimer = setInterval(() => {
      void this.runMaintenance();
    }, 30_000);
    this.#maintenanceTimer.unref?.();
  }

  private async runMaintenance(): Promise<void> {
    if (this.#stopping) return;
    for (const runtime of this.#runtimes.values()) {
      if (!runtime.adapter.getHealth().restConnected) continue;
      try {
        await this.reconcileRuntime(runtime);
        if (!runtime.settings.orderPolicy.cancelRemainderOnTimeout) continue;
        const timeoutMs = runtime.settings.orderPolicy.unfilledTimeoutSeconds * 1_000;
        for (const order of this.#repository.listOpenOrders(runtime.adapter.scope)) {
          if (!order.brokerOrderId || order.remainingQuantity <= 0) continue;
          // Amend/cancel must use and obey the venue of the original order,
          // not a route the operator selected later.
          if (!this.#marketSession.orderableExchanges.includes(order.exchange)) continue;
          if (Date.now() - Date.parse(order.orderedAt) < timeoutMs) continue;
          if (order.status === "CANCEL_REQUESTED" || order.status === "UNKNOWN") continue;
          await this.cancelOrder(order.id);
        }
      } catch (error) {
        runtime.reconciled = false;
        this.recordError(error, "order-maintenance", runtime.adapter.scope);
      }
    }
  }

  private startLeaseHeartbeat(): void {
    this.#leaseTimer = setInterval(() => {
      const healthy = this.#repository.heartbeatEngineLease(
        "trading-engine",
        this.#instanceId,
        30_000,
      );
      if (!healthy) {
        this.#leaseHealthy = false;
        this.#settings.emergencyHalt = true;
        this.#settings.globalAutoTradingEnabled = false;
        this.#repository.setAppSettings(this.#settings);
        this.#repository.appendError({
          severity: "critical",
          code: "ENGINE_LEASE_LOST",
          message: "단일 엔진 lease를 잃어 모든 신규 주문을 차단했습니다.",
        });
      }
    }, 10_000);
    this.#leaseTimer.unref?.();
  }

  private startSleepDetection(): void {
    this.#lastSleepTick = Date.now();
    this.#sleepTimer = setInterval(() => {
      const now = Date.now();
      const drift = now - this.#lastSleepTick - 10_000;
      this.#lastSleepTick = now;
      if (drift <= 45_000) return;
      let policyChanged = false;
      const recovering: BrokerRuntime[] = [];
      for (const runtime of this.#runtimes.values()) {
        if (!runtime.settings.resumeAfterRestart && runtime.settings.autoTradingEnabled) {
          runtime.settings.autoTradingEnabled = false;
          runtime.settings.newBuysPaused = true;
          policyChanged = true;
          continue;
        }
        runtime.recovering = true;
        recovering.push(runtime);
      }
      if (policyChanged) this.#repository.setAppSettings(this.#settings);
      this.#repository.appendError({
        severity: "warning",
        code: "SYSTEM_RESUME_DETECTED",
        message: "절전 또는 런타임 정지를 감지해 주문을 잠시 차단하고 계좌를 재동기화합니다.",
        details: { driftMs: drift },
      });
      void (async () => {
        try {
          await this.reconcileAll();
          await this.#marketData.start();
        } finally {
          for (const runtime of recovering) runtime.recovering = false;
          // Quotes seen during recovery can be displayed as candidates, but
          // must be freshly evaluated after the durable ledger is healthy.
          this.#lastActions.clear();
          this.#lastEvaluatedAt.clear();
        }
      })().catch((error: unknown) => this.recordError(error, "system-resume-recovery"));
    }, 10_000);
    this.#sleepTimer.unref?.();
  }

  private engineState(): "RUNNING" | "BUY_PAUSED" | "HALTED" | "DEGRADED" | "ERROR" {
    if (!this.#leaseHealthy) return "ERROR";
    if (this.#settings.emergencyHalt || !this.#settings.globalAutoTradingEnabled) return "HALTED";
    const enabled = BROKER_IDS.filter((id) => this.#settings.brokers[id].enabled);
    if (enabled.some((id) => {
      const runtime = this.#runtimes.get(id);
      return !runtime || runtime.recovering || !runtime.reconciled || this.runtimeHealth(runtime).state !== "CONNECTED";
    })) return "DEGRADED";
    if (this.#settings.newBuysPaused) return "BUY_PAUSED";
    return "RUNNING";
  }

  private async brokerDashboard(brokerId: BrokerId) {
    const settings = this.#settings.brokers[brokerId];
    const runtime = this.#runtimes.get(brokerId);
    const credential = await this.safeCredentialStatus(brokerId, settings.environment);
    const health = runtime ? this.runtimeHealth(runtime) : null;
    const connection = this.brokerConnection(brokerId, credential.configured);
    const intradaySymbols = runtime && runtime.intradayWindowSeconds > 0
      ? this.prioritySymbols(runtime.adapter.scope).slice(0, runtime.adapter.capabilities.maxQuoteSubscriptions) : [];
    return {
      brokerId,
      name: BROKER_NAMES[brokerId],
      environment: settings.environment,
      enabled: settings.enabled,
      autoTradingEnabled: settings.autoTradingEnabled,
      newBuysPaused: settings.newBuysPaused,
      credentialsConfigured: credential.configured,
      maskedAccountId: credential.maskedAccountId,
      strategyId: settings.strategyId,
      intraday: {
        enabled: (runtime?.intradayWindowSeconds ?? 0) > 0,
        requiredSeconds: runtime?.intradayWindowSeconds ?? 0,
        observedSymbols: runtime ? intradaySymbols.filter((symbol) => this.#intradayTape.samples(
          runtime.adapter.scope, this.orderRoute(settings), symbol, new Date(), runtime.intradayWindowSeconds,
        ).length > 0).length : 0,
        readySymbols: runtime ? intradaySymbols.filter((symbol) => {
          const status = this.#intradayReadiness.get(candidateKey(runtime.adapter.scope, symbol));
          return status?.ready && Date.now() - status.evaluatedAt < 10_000;
        }).length : 0,
      },
      orderRoute: settings.orderRoute,
      resumeAfterRestart: settings.resumeAfterRestart,
      orderWindowOpen: runtime ? this.isRuntimeOrderWindowOpen(runtime.adapter) : false,
      connectionState: health?.state ?? (settings.enabled ? "CREDENTIALS_REQUIRED" : "DISABLED"),
      connection,
      liveSubscriptions: runtime
        ? Math.min(new Set(this.prioritySymbols(runtime.adapter.scope)).size, runtime.adapter.capabilities.maxQuoteSubscriptions)
        : 0,
      marketStatusConfirmed:
        runtime?.marketStatusConfirmedDate === koreanTradingDate(),
      // Only expose adapter/transport failures here. The aggregate runtime
      // health may be DEGRADED solely because official market status has not
      // arrived yet, which is a waiting state rather than an error.
      lastError: connection.lastError,
    };
  }

  private brokerConnection(
    brokerId: BrokerId,
    credentialsStored: boolean,
  ): BrokerConnectionReadiness {
    const settings = this.#settings.brokers[brokerId];
    const runtime = this.#runtimes.get(brokerId);
    return summarizeBrokerConnection({
      environment: settings.environment,
      enabled: settings.enabled,
      credentialsStored,
      // Surface startup/sleep recovery as DEGRADED until durable account and
      // outbox recovery is complete; raw adapter connectivity alone is not
      // order readiness.
      health: runtime ? this.runtimeHealth(runtime) : null,
      accountSynchronized: runtime?.reconciled ?? false,
      marketStatusConfirmed:
        runtime?.marketStatusConfirmedDate === koreanTradingDate(),
      orderWindowOpen: runtime ? this.isRuntimeOrderWindowOpen(runtime.adapter) : false,
    });
  }

  private errorRow(row: ErrorLogRecord) {
    return {
      id: row.id,
      brokerId: row.scope?.brokerId ?? null,
      severity: row.severity,
      code: row.code,
      message: row.message,
      createdAt: row.occurredAt,
    };
  }

  private findRuntimeOrder(orderId: string): { runtime: BrokerRuntime; order: OrderRecord } | null {
    for (const runtime of this.#runtimes.values()) {
      const order = this.#repository.getOrder(orderId, runtime.adapter.scope);
      if (order) return { runtime, order };
    }
    return null;
  }

  private kisRequestLimiter(
    environment: TradingEnvironment,
    credentials: BrokerCredentials,
  ): KisRequestLimiter {
    const key = `${environment}:${stableHash({
      appKey: credentials.appKey,
      appSecret: credentials.appSecret,
    })}`;
    const existing = this.#kisRequestLimiters.get(key);
    if (existing) return existing;

    // KIS applies the ceiling to one app key, not to each adapter instance.
    // Keep cash and derivatives on one serialized queue with headroom for the
    // broker's internal ledger limits and for a manual account refresh.
    const configuredLiveRate = envInteger("KIS_LIVE_REQUESTS_PER_SECOND");
    const requestsPerSecond = environment === "live"
      ? Math.min(configuredLiveRate ?? 5, 18)
      : 0.75;
    // KIS account-ledger TRs reject calls admitted on an exact one-second
    // boundary on some live accounts. Two-second spacing leaves deterministic
    // headroom while still completing both cash and derivatives recovery well
    // inside the 30-second maintenance interval.
    const accountRequestsPerSecond = environment === "live" ? 0.5 : 0.4;
    const created = new KisRequestLimiter(
      requestsPerSecond,
      requestsPerSecond,
      requestsPerSecond,
      accountRequestsPerSecond,
    );
    this.#kisRequestLimiters.set(key, created);
    return created;
  }

  private async safeCredentialStatus(brokerId: BrokerId, environment: TradingEnvironment) {
    try {
      return await this.#credentialStore.status(brokerId, environment);
    } catch {
      return { configured: false, source: null, maskedAccountId: null } as const;
    }
  }

  private async safeDerivativeCredentialStatus(
    environment: TradingEnvironment,
  ): Promise<DerivativeCredentialStatus> {
    try {
      return await this.#credentialStore.statusDerivatives(environment);
    } catch {
      return {
        configured: false,
        source: null,
        maskedAccountId: null,
        accountProductCode: "03",
      };
    }
  }

  private recordError(
    error: unknown,
    context: string,
    scope?: AccountScope,
    severity: "warning" | "error" | "critical" = "error",
  ): void {
    const message = error instanceof Error ? error.message : String(error);
    const brokerCode = error && typeof error === "object" && "code" in error &&
      typeof (error as { code?: unknown }).code === "string"
      ? (error as { code: string }).code.trim()
      : "";
    const brokerDetails = error && typeof error === "object" && "details" in error
      ? (error as { details?: unknown }).details
      : undefined;
    this.#repository.appendError({
      ...(scope ? { scope } : {}),
      severity,
      code: brokerCode || (error instanceof Error ? error.name : "UNKNOWN_ERROR"),
      message: `${context}: ${message}`,
      details: error instanceof Error
        ? redactSensitive({
            name: error.name,
            ...(brokerCode ? { brokerCode } : {}),
            ...(brokerDetails === undefined ? {} : { brokerDetails }),
          })
        : undefined,
    });
  }

  private enqueueLifecycle(operation: () => Promise<void>): Promise<void> {
    const run = this.#lifecycleTail.then(operation);
    this.#lifecycleTail = run.catch(() => undefined);
    return run;
  }
}
