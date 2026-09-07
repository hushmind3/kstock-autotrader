import { randomUUID } from "node:crypto";
import {
  BrokerRejectedError,
  createDefaultDerivativesAutomationSettings,
  createDerivativesAccountKey,
  DerivativesAutomationSettingsSchema,
  koreanTradingDate,
  maskAccount,
  stableHash,
  toIsoDateTime,
  type BrokerCredentials,
  type DerivativesAccountKey,
  type DerivativesAutomationSettings,
  type DerivativesPositionPurpose,
  type OrderStatus,
  type TradingEnvironment,
} from "@kstock/shared";
import {
  type DerivativesOrderRecord,
  type DerivativesPositionRecord,
  type TradingRepository,
} from "@kstock/database";
import type {
  DerivativeAccountSnapshot,
  CancelDerivativeOrderRequest,
  DerivativeDailyBar,
  DerivativeExecution,
  DerivativeOrder,
  DerivativeOrderCapacity,
  DerivativeOrderSubmission,
  DerivativeQuote,
  DerivativeQuoteSubscription,
  DerivativeSession,
  IndexFutureContractQuote,
  KisDerivativeEvent,
  PlaceDerivativeOrderRequest,
} from "@kstock/broker-kis-derivatives";
import {
  planDirectionalMovingAverage,
  type DirectionalTrendPlan,
} from "./directional-planner.js";
import {
  planEquityExposureHedgeFromLedger,
  type EquityHedgePlan,
} from "./hedge-planner.js";

const SETTINGS_KEY = "derivatives-automation-settings";
const DAILY_PNL_BASELINE_KEY_PREFIX = "derivatives-daily-pnl-baseline";
const PRICE_SCALE = 100;
const MINI_KOSPI200_MULTIPLIER_KRW = 50_000;
const QUOTE_STALE_MS = 90_000;
const SYNC_INTERVAL_MS = 30_000;
const CONTRACT_REFRESH_MS = 60 * 60_000;
const HISTORY_REFRESH_MS = 15 * 60_000;

type DerivativeConnectionState =
  | "DISABLED"
  | "CREDENTIALS_REQUIRED"
  | "CONNECTING"
  | "CONNECTED"
  | "DEGRADED"
  | "ERROR";

export interface DerivativesVenueSession {
  id: "KRX_DERIVATIVES_DAY" | "KRX_DERIVATIVES_NIGHT" | string;
  orderable: boolean;
  state: string;
  phase: string;
  tradingDate: string;
  nextTransitionAt: string;
  checkedAt: string;
}

export interface DerivativeTradingAdapter {
  readonly environment: TradingEnvironment;
  readonly connected?: boolean;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  onEvent(listener: (event: KisDerivativeEvent) => void): () => void;
  fetchAccountSnapshot(session: DerivativeSession): Promise<DerivativeAccountSnapshot>;
  fetchOpenOrders(session: DerivativeSession, date?: string): Promise<DerivativeOrder[]>;
  fetchExecutions(
    session: DerivativeSession,
    fromDate?: string,
    toDate?: string,
  ): Promise<DerivativeExecution[]>;
  fetchQuote(
    symbol: string,
    instrumentKind: "INDEX_FUTURE",
    session?: DerivativeSession,
  ): Promise<DerivativeQuote>;
  fetchMiniKospi200Contracts(): Promise<IndexFutureContractQuote[]>;
  fetchDailyBars(symbol: string, fromDate: string, toDate: string): Promise<DerivativeDailyBar[]>;
  fetchOrderCapacity(input: {
    symbol: string;
    session: DerivativeSession;
    side: "BUY" | "SELL";
    orderType: "LIMIT" | "MARKET";
    limitPrice?: number;
  }): Promise<DerivativeOrderCapacity>;
  replaceQuoteSubscriptions(subscriptions: DerivativeQuoteSubscription[]): Promise<void>;
  placeOrder(request: PlaceDerivativeOrderRequest): Promise<DerivativeOrderSubmission>;
  cancelOrder(request: CancelDerivativeOrderRequest): Promise<DerivativeOrderSubmission>;
}

export function isDerivativeTradingAdapter(value: unknown): value is DerivativeTradingAdapter {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return [
    "connect",
    "disconnect",
    "onEvent",
    "fetchAccountSnapshot",
    "fetchOpenOrders",
    "fetchExecutions",
    "fetchQuote",
    "fetchMiniKospi200Contracts",
    "fetchDailyBars",
    "fetchOrderCapacity",
    "replaceQuoteSubscriptions",
    "placeOrder",
    "cancelOrder",
  ].every((key) => typeof candidate[key] === "function");
}

export interface DerivativesRuntimeOptions {
  repository: TradingRepository;
  loadCredentials(environment: TradingEnvironment): Promise<BrokerCredentials | null>;
  createAdapter(
    environment: TradingEnvironment,
    credentials: BrokerCredentials,
  ): unknown;
  getSessions(): DerivativesVenueSession[];
  getEquityExposureKrw(): number[] | null;
  canMutate(): boolean;
  onCredentialStatus?(input: {
    environment: TradingEnvironment;
    connection: {
      state: "NOT_CHECKED" | "VERIFYING" | "VERIFIED" | "FAILED";
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
      unavailableFields: DerivativeAccountSnapshot["unavailableFields"];
    };
  }): void;
  onError(error: unknown, context: string, severity?: "warning" | "error" | "critical"): void;
}

interface SelectedContract {
  id: string;
  symbol: string;
  name: string;
  currentPrice: number | null;
  bidPrice: number | null;
  askPrice: number | null;
  cumulativeVolume: number | null;
  remainingDays: number | null;
  expiryDate: string;
  multiplierKrw: number;
  priceScale: number;
  raw: Record<string, unknown>;
}

interface ConnectionView {
  state: DerivativeConnectionState;
  authenticated: boolean;
  accountSynchronized: boolean;
  marketWebSocketConnected: boolean;
  accountNoticesConnected: boolean;
  checkedAt: string | null;
  message: string;
  lastError: string | null;
}

export class DerivativesRuntime {
  readonly #repository: TradingRepository;
  readonly #options: DerivativesRuntimeOptions;
  #settings: DerivativesAutomationSettings;
  #adapter: DerivativeTradingAdapter | null = null;
  #accountKey: DerivativesAccountKey | null = null;
  #account: DerivativeAccountSnapshot | null = null;
  #contract: SelectedContract | null = null;
  #quote: DerivativeQuote | null = null;
  #executions: DerivativeExecution[] = [];
  #dailyBars: DerivativeDailyBar[] = [];
  #hedgePlan: EquityHedgePlan | null = null;
  #directionalPlan: DirectionalTrendPlan | null = null;
  #connection: ConnectionView;
  #ledgerConsistent = false;
  #ledgerBlockReason: string | null = null;
  #lastSyncAt: string | null = null;
  #lastContractRefreshAt = 0;
  #lastHistoryRefreshAt = 0;
  #timer: NodeJS.Timeout | null = null;
  #unsubscribe: (() => void) | null = null;
  #syncTail: Promise<void> = Promise.resolve();
  #stopping = false;

  constructor(options: DerivativesRuntimeOptions) {
    this.#repository = options.repository;
    this.#options = options;
    this.#settings = this.#loadSettings();
    this.#connection = this.#emptyConnection();
  }

  get settings(): DerivativesAutomationSettings {
    return structuredClone(this.#settings);
  }

  async start(): Promise<void> {
    this.#stopping = false;
    if (this.#settings.autoTradingEnabled && !this.#settings.resumeAfterRestart) {
      this.#settings.autoTradingEnabled = false;
      this.#settings.newPositionsPaused = true;
      this.#persistSettings();
    }
    await this.rebuild();
    this.#timer = setInterval(() => {
      void this.sync().catch((error: unknown) => this.#recordSyncFailure(error));
    }, SYNC_INTERVAL_MS);
    this.#timer.unref?.();
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    await this.#disconnect();
  }

  async rebuild(): Promise<void> {
    await this.#disconnect();
    this.#resetVolatileState();
    if (!this.#settings.connectionEnabled) {
      this.#connection = this.#emptyConnection("DISABLED", "선물 계좌 연결 사용이 꺼져 있습니다.");
      return;
    }
    const credentials = await this.#options.loadCredentials(this.#settings.environment);
    if (!credentials) {
      this.#connection = this.#emptyConnection(
        "CREDENTIALS_REQUIRED",
        "선물·옵션 자동매매 설정에서 계좌를 먼저 연결해 주세요.",
      );
      return;
    }
    const candidate = this.#options.createAdapter(this.#settings.environment, credentials);
    if (!isDerivativeTradingAdapter(candidate)) {
      this.#connection = this.#emptyConnection(
        "ERROR",
        "선물 주문 기능을 지원하는 어댑터를 시작하지 못했습니다.",
      );
      return;
    }
    this.#adapter = candidate;
    this.#connection = {
      ...this.#emptyConnection("CONNECTING", "한국투자증권 선물 API에 연결하고 있습니다."),
    };
    try {
      this.#unsubscribe = candidate.onEvent((event) => this.#handleEvent(event));
      await candidate.connect();
      this.#connection.authenticated = true;
      await this.sync();
    } catch (error) {
      this.#recordSyncFailure(error);
    }
  }

  async credentialsChanged(environment: TradingEnvironment): Promise<void> {
    if (environment !== this.#settings.environment) return;
    await this.rebuild();
  }

  updateSettings(input: unknown): DerivativesAutomationSettings {
    const parsed = DerivativesAutomationSettingsSchema.parse(input);
    // Saving risk/strategy values must never arm a live account. Arming and
    // halting are separate audited control actions.
    parsed.autoTradingEnabled = this.#settings.autoTradingEnabled;
    parsed.emergencyHalt = this.#settings.emergencyHalt;
    parsed.newPositionsPaused = this.#settings.newPositionsPaused;
    parsed.mode = strategyModeFor(parsed.hedge.enabled, parsed.directional.enabled, parsed.mode);
    const validated = DerivativesAutomationSettingsSchema.parse(parsed);
    const mustRebuild =
      validated.environment !== this.#settings.environment ||
      validated.connectionEnabled !== this.#settings.connectionEnabled ||
      validated.contractSelection !== this.#settings.contractSelection ||
      validated.manualContractCode !== this.#settings.manualContractCode;
    this.#settings = validated;
    this.#persistSettings();
    if (mustRebuild) {
      void this.rebuild().catch((error: unknown) => this.#recordSyncFailure(error));
    } else {
      void this.sync().catch((error: unknown) => this.#recordSyncFailure(error));
    }
    return this.settings;
  }

  async control(action: "start" | "halt" | "pause-new" | "resume-new"): Promise<void> {
    if (action === "halt") {
      this.#settings.autoTradingEnabled = false;
      this.#settings.emergencyHalt = true;
      this.#settings.newPositionsPaused = true;
    } else if (action === "start") {
      if (!this.#settings.hedge.enabled && !this.#settings.directional.enabled) {
        throw new Error("현물 보호 또는 상승·하락 추세매매 중 하나를 먼저 켜 주세요.");
      }
      if (!this.#adapter || !this.#connection.authenticated || !this.#connection.accountSynchronized) {
        await this.rebuild();
      } else {
        await this.sync(false);
      }
      if (!this.#connection.authenticated || !this.#connection.accountSynchronized) {
        throw new Error("실제 선물 계좌와 잔고를 먼저 정상 연결해 주세요.");
      }
      if (!this.#contract || !this.#quote) {
        throw new Error("거래할 미니 코스피200 선물과 실제 시세를 확인하지 못했습니다.");
      }
      if (!this.#ledgerConsistent) {
        throw new Error(this.#ledgerBlockReason ?? "기존 선물 포지션의 사용 목적을 먼저 확인해 주세요.");
      }
      this.#settings.autoTradingEnabled = true;
      this.#settings.emergencyHalt = false;
      this.#settings.newPositionsPaused = false;
    } else if (action === "pause-new") {
      this.#settings.newPositionsPaused = true;
    } else {
      if (!this.#settings.autoTradingEnabled || this.#settings.emergencyHalt) {
        throw new Error("먼저 선물 자동운용을 시작해 주세요.");
      }
      this.#settings.newPositionsPaused = false;
    }
    this.#persistSettings();
    this.#repository.appendAudit({
      actor: "web-console",
      action: `DERIVATIVES_CONTROL_${action.toUpperCase().replaceAll("-", "_")}`,
      payload: { environment: this.#settings.environment },
    });
    if (action === "start" || action === "resume-new") {
      void this.sync().catch((error: unknown) => this.#recordSyncFailure(error));
    }
  }

  async sync(evaluateOrders = true): Promise<void> {
    const run = this.#syncTail.catch(() => undefined).then(async () => {
      if (this.#stopping || !this.#adapter) return;
      const session = this.#activeSession();
      const snapshot = await this.#adapter.fetchAccountSnapshot(session);
      this.#account = snapshot;
      this.#accountKey = createDerivativesAccountKey({
        providerId: "koreainvestment",
        product: "derivatives",
        environment: this.#settings.environment,
        accountId: snapshot.accountId.replace(/-03$/, ""),
        accountProductCode: "03",
      });
      this.#repository.upsertDerivativesAccount({
        scope: {
          providerId: "koreainvestment",
          product: "derivatives",
          environment: this.#settings.environment,
          accountId: snapshot.accountId.replace(/-03$/, ""),
          accountProductCode: "03",
        },
        enabled: this.#settings.connectionEnabled,
        updatedAt: snapshot.observedAt,
      });
      // Capture the start-of-trading-day cumulative realized P&L before any
      // newly observed fills are reconciled. This makes the daily loss gate
      // survive process restarts without treating lifetime P&L as today's.
      this.#ensureDailyPnlBaseline();
      await this.#refreshContract(session);
      await this.#refreshQuote(session);
      await this.#reconcileAccount(snapshot, session);
      await this.#refreshHistory();
      this.#refreshPlans();
      this.#lastSyncAt = toIsoDateTime();
      this.#connection = {
        ...this.#connection,
        state: "CONNECTED",
        authenticated: true,
        accountSynchronized: true,
        checkedAt: this.#lastSyncAt,
        message: "실제 선물 계좌·잔고·미체결·체결을 동기화했습니다.",
        lastError: null,
      };
      this.#publishCredentialStatus();
      if (evaluateOrders) await this.#evaluateAndDispatch(session);
    });
    this.#syncTail = run;
    return run;
  }

  snapshot() {
    const sessions = this.#options.getSessions();
    const activeSession = this.#activeSession();
    const positionRows = this.#account?.positions.map((position) => ({
      symbol: position.symbol,
      name: position.name ?? "",
      direction: position.direction,
      quantity: position.quantity,
      averagePrice: position.averagePrice,
      currentPrice: position.currentPrice ?? null,
      evaluationProfitLoss: position.evaluationProfitLoss ?? null,
    })) ?? [];
    const orders = this.#account?.openOrders.map(publicOrder) ?? [];
    const accountKey = this.#accountKey;
    const storedOrders = accountKey
      ? this.#repository.listDerivativesOrders(accountKey, { limit: 100 }).map((order) => ({
          id: order.id,
          brokerOrderId: order.brokerOrderId,
          symbol: this.#repository.getDerivativesContract(order.contractId)?.contractCode ?? order.contractId,
          purpose: order.purpose,
          action: order.action,
          direction: order.direction,
          quantity: order.orderedQuantity,
          filledQuantity: order.filledQuantity,
          remainingQuantity: order.remainingQuantity,
          limitPrice: order.limitPriceTicks === null ? null : order.limitPriceTicks / PRICE_SCALE,
          status: order.status,
          orderedAt: order.orderedAt,
        }))
      : [];
    const purposeLedger = accountKey
      ? this.#repository.listDerivativesPurposeLedger(accountKey).map((row) => ({
          contractId: row.contractId,
          purpose: row.purpose,
          signedQuantity: row.signedQuantity,
          averagePrice: row.averagePriceTicks / PRICE_SCALE,
          realizedPnlKrw: row.realizedPnlKrw,
          updatedAt: row.updatedAt,
        }))
      : [];
    const blockers = this.#orderBlockers(activeSession);
    return {
      settings: this.settings,
      connection: { ...this.#connection },
      market: {
        activeSession,
        sessions,
        orderWindowOpen: this.#isOrderWindowOpen(activeSession),
      },
      account: this.#account
        ? {
            maskedAccountId: maskAccount(this.#account.accountId.replace(/-03$/, "")),
            environment: this.#settings.environment,
            productCode: "03" as const,
            depositCash: this.#account.depositCash ?? null,
            orderableCash: this.#account.orderableCash ?? null,
            initialMargin: this.#account.initialMargin ?? null,
            maintenanceMargin: this.#account.maintenanceMargin ?? null,
            observedAt: this.#account.observedAt,
            unavailableFields: this.#account.unavailableFields,
          }
        : null,
      contract: this.#contract
        ? {
            symbol: this.#contract.symbol,
            name: this.#contract.name,
            currentPrice: this.#quote?.price ?? this.#contract.currentPrice,
            bidPrice: this.#contract.bidPrice,
            askPrice: this.#contract.askPrice,
            cumulativeVolume: this.#contract.cumulativeVolume,
            remainingDays: this.#contract.remainingDays,
            multiplierKrw: this.#contract.multiplierKrw,
            quoteReceivedAt: this.#quote?.receivedAt ?? null,
          }
        : null,
      equityExposureKrw: this.#safeEquityExposureTotal(),
      positions: positionRows,
      brokerOpenOrders: orders,
      orders: storedOrders,
      executions: this.#executions.slice(0, 100).map((execution) => ({
        executionId: execution.executionId,
        brokerOrderId: execution.brokerOrderId,
        symbol: execution.symbol,
        side: execution.side,
        quantity: execution.quantity,
        price: execution.price,
        executedAt: execution.executedAt ?? null,
        session: execution.session,
      })),
      purposeLedger,
      profitLoss: this.#profitLoss(),
      hedge: this.#hedgePlan
        ? {
            enabled: this.#settings.hedge.enabled,
            status: this.#hedgePlan.status,
            sourceEquityExposureKrw: this.#hedgePlan.sourceEquityExposureKrw,
            targetQuantity: this.#hedgePlan.targetHedgeSignedQuantity,
            currentQuantity: this.#hedgePlan.existingHedgeSignedQuantity,
            reasons: this.#hedgePlan.reasons,
          }
        : {
            enabled: this.#settings.hedge.enabled,
            status: this.#settings.hedge.enabled ? "WAITING" : "DISABLED",
            sourceEquityExposureKrw: this.#safeEquityExposureTotal(),
            targetQuantity: null,
            currentQuantity: 0,
            reasons: [],
          },
      directional: this.#directionalPlan
        ? {
            enabled: this.#settings.directional.enabled,
            signal: this.#directionalPlan.signal,
            fastAverage: this.#directionalPlan.fastAverage,
            slowAverage: this.#directionalPlan.slowAverage,
            gapBps: this.#directionalPlan.gapBps,
            targetQuantity: this.#directionalPlan.targetDirectionalQuantity,
            currentQuantity: this.#directionalPlan.currentDirectionalQuantity,
            historyCount: this.#dailyBars.length,
          }
        : {
            enabled: this.#settings.directional.enabled,
            signal: this.#settings.directional.enabled ? "WAITING_FOR_HISTORY" : "DISABLED",
            fastAverage: null,
            slowAverage: null,
            gapBps: null,
            targetQuantity: null,
            currentQuantity: 0,
            historyCount: this.#dailyBars.length,
          },
      safety: {
        armed: this.#settings.autoTradingEnabled && !this.#settings.emergencyHalt,
        newPositionsPaused: this.#settings.newPositionsPaused,
        ledgerConsistent: this.#ledgerConsistent,
        ledgerBlockReason: this.#ledgerBlockReason,
        readyForOrders: blockers.length === 0,
        blockers,
      },
      lastSyncAt: this.#lastSyncAt,
    };
  }

  #loadSettings(): DerivativesAutomationSettings {
    const persisted = this.#repository.getRuntimeState<unknown>(null, SETTINGS_KEY);
    const parsed = DerivativesAutomationSettingsSchema.safeParse(persisted);
    if (parsed.success) {
      const normalized = {
        ...parsed.data,
        mode: strategyModeFor(
          parsed.data.hedge.enabled,
          parsed.data.directional.enabled,
          parsed.data.mode,
        ),
      };
      const validated = DerivativesAutomationSettingsSchema.parse(normalized);
      if (validated.mode !== parsed.data.mode) {
        this.#repository.setRuntimeState(null, SETTINGS_KEY, validated);
      }
      return validated;
    }
    const defaults = createDefaultDerivativesAutomationSettings();
    this.#repository.setRuntimeState(null, SETTINGS_KEY, defaults);
    return defaults;
  }

  #persistSettings(): void {
    this.#repository.setRuntimeState(null, SETTINGS_KEY, this.#settings);
  }

  #emptyConnection(
    state: DerivativeConnectionState = "CREDENTIALS_REQUIRED",
    message = "선물·옵션 계좌를 연결해 주세요.",
  ): ConnectionView {
    return {
      state,
      authenticated: false,
      accountSynchronized: false,
      marketWebSocketConnected: false,
      accountNoticesConnected: false,
      checkedAt: null,
      message,
      lastError: null,
    };
  }

  async #disconnect(): Promise<void> {
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    const adapter = this.#adapter;
    this.#adapter = null;
    await adapter?.disconnect().catch((error: unknown) => {
      this.#options.onError(error, "derivatives-runtime-disconnect", "warning");
    });
  }

  #resetVolatileState(): void {
    this.#accountKey = null;
    this.#account = null;
    this.#contract = null;
    this.#quote = null;
    this.#executions = [];
    this.#dailyBars = [];
    this.#hedgePlan = null;
    this.#directionalPlan = null;
    this.#ledgerConsistent = false;
    this.#ledgerBlockReason = null;
    this.#lastSyncAt = null;
    this.#lastContractRefreshAt = 0;
    this.#lastHistoryRefreshAt = 0;
  }

  #activeSession(): DerivativeSession {
    const sessions = this.#options.getSessions();
    const night = sessions.find((session) => session.id === "KRX_DERIVATIVES_NIGHT");
    if (this.#settings.allowNightSession && night?.orderable) return "NIGHT";
    return "DAY";
  }

  #isOrderWindowOpen(session: DerivativeSession): boolean {
    const id = session === "NIGHT" ? "KRX_DERIVATIVES_NIGHT" : "KRX_DERIVATIVES_DAY";
    return this.#options.getSessions().find((item) => item.id === id)?.orderable === true;
  }

  async #refreshContract(session: DerivativeSession): Promise<void> {
    if (!this.#adapter) return;
    if (this.#contract && Date.now() - this.#lastContractRefreshAt < CONTRACT_REFRESH_MS) return;
    const contracts = await this.#adapter.fetchMiniKospi200Contracts();
    const requested = this.#settings.contractSelection === "MANUAL"
      ? this.#settings.manualContractCode.toUpperCase()
      : null;
    const selected = requested
      ? contracts.find((contract) => contract.symbol === requested)
      : contracts.find((contract) => (contract.remainingDays ?? 99) > 2 && (contract.currentPrice ?? 0) > 0)
        ?? contracts.find((contract) => (contract.currentPrice ?? 0) > 0)
        ?? contracts[0];
    if (!selected) throw new Error("한국투자증권에서 거래 가능한 미니 코스피200 선물 월물을 받지 못했습니다.");
    if (requested && selected.symbol !== requested) {
      throw new Error("직접 입력한 종목이 현재 미니 코스피200 선물 목록에 없습니다.");
    }
    const remainingDays = selected.remainingDays ?? null;
    const expiry = new Date(Date.now() + Math.max(remainingDays ?? 90, 0) * 86_400_000);
    const expiryDate = expiry.toISOString().slice(0, 10);
    this.#contract = {
      id: `koreainvestment:${selected.symbol}`,
      symbol: selected.symbol,
      name: selected.name,
      currentPrice: selected.currentPrice ?? null,
      bidPrice: selected.bidPrice ?? null,
      askPrice: selected.askPrice ?? null,
      cumulativeVolume: selected.cumulativeVolume ?? null,
      remainingDays,
      expiryDate,
      multiplierKrw: MINI_KOSPI200_MULTIPLIER_KRW,
      priceScale: PRICE_SCALE,
      raw: selected.raw,
    };
    this.#repository.upsertDerivativesContract({
      contract: {
        id: this.#contract.id,
        providerId: "koreainvestment",
        contractCode: this.#contract.symbol,
        name: this.#contract.name,
        contractType: "FUTURE",
        underlyingCode: "KOSPI200",
        multiplierKrw: this.#contract.multiplierKrw,
        priceScale: this.#contract.priceScale,
        expiryDate: this.#contract.expiryDate,
        active: true,
        raw: this.#contract.raw,
      },
    });
    await this.#adapter.replaceQuoteSubscriptions([{
      symbol: this.#contract.symbol,
      instrumentKind: "INDEX_FUTURE",
      session,
    }]);
    this.#lastContractRefreshAt = Date.now();
  }

  async #refreshQuote(session: DerivativeSession): Promise<void> {
    if (!this.#adapter || !this.#contract) return;
    this.#quote = await this.#adapter.fetchQuote(this.#contract.symbol, "INDEX_FUTURE", session);
  }

  async #refreshHistory(): Promise<void> {
    if (!this.#adapter || !this.#contract || !this.#settings.directional.enabled) return;
    if (Date.now() - this.#lastHistoryRefreshAt < HISTORY_REFRESH_MS && this.#dailyBars.length > 0) return;
    const to = compactDate(new Date());
    const from = compactDate(new Date(Date.now() - 240 * 86_400_000));
    this.#dailyBars = await this.#adapter.fetchDailyBars(this.#contract.symbol, from, to);
    this.#lastHistoryRefreshAt = Date.now();
  }

  async #reconcileAccount(snapshot: DerivativeAccountSnapshot, session: DerivativeSession): Promise<void> {
    if (!this.#adapter || !this.#accountKey || !this.#contract) return;
    const positionRows = snapshot.positions.filter((position) => position.symbol === this.#contract?.symbol);
    const unmanagedPositions = snapshot.positions.filter(
      (position) => position.quantity > 0 && position.symbol !== this.#contract?.symbol,
    );
    const netQuantity = positionRows.reduce(
      (sum, position) => sum + (position.direction === "LONG" ? position.quantity : -position.quantity),
      0,
    );
    const grossQuantity = positionRows.reduce((sum, position) => sum + position.quantity, 0);
    const averagePrice = grossQuantity > 0
      ? positionRows.reduce((sum, position) => sum + position.averagePrice * position.quantity, 0) / grossQuantity
      : 0;
    const currentPrice = this.#quote?.price
      ?? positionRows.find((position) => position.currentPrice !== undefined)?.currentPrice
      ?? 0;
    const unrealizedPnl = positionRows.reduce(
      (sum, position) => sum + (position.evaluationProfitLoss ?? 0),
      0,
    );
    const existingPosition = this.#repository.getDerivativesPosition(this.#accountKey, this.#contract.id);
    this.#repository.upsertDerivativesPosition({
      accountKey: this.#accountKey,
      contractId: this.#contract.id,
      netQuantity,
      averagePriceTicks: Math.max(0, Math.round(averagePrice * PRICE_SCALE)),
      currentPriceTicks: Math.max(0, Math.round(currentPrice * PRICE_SCALE)),
      marginRequiredKrw: 0,
      unrealizedPnlKrw: Math.round(unrealizedPnl),
      brokerUpdatedAt: snapshot.observedAt,
      raw: {
        positions: positionRows.map((position) => position.raw),
        marginUnavailableAtPositionLevel: true,
      },
    });

    let ledger = this.#repository.listDerivativesPurposeLedger(this.#accountKey, this.#contract.id);
    if (!existingPosition && netQuantity === 0 && ledger.length === 0) {
      ledger = this.#repository.replaceDerivativesPurposeLedger({
        accountKey: this.#accountKey,
        contractId: this.#contract.id,
        allocations: [
          { purpose: "HEDGE", signedQuantity: 0, averagePriceTicks: 0, realizedPnlKrw: 0 },
          { purpose: "DIRECTIONAL", signedQuantity: 0, averagePriceTicks: 0, realizedPnlKrw: 0 },
        ],
      });
    }

    this.#executions = await this.#adapter.fetchExecutions(session);
    await this.#reconcileKnownOrders(snapshot.openOrders, this.#executions);
    await this.#cancelStaleOrders(snapshot.openOrders);
    const consistency = this.#repository.checkDerivativesPositionConsistency(this.#accountKey, this.#contract.id);
    const hasOffsettingPhysicalLots = grossQuantity !== Math.abs(netQuantity);
    this.#ledgerConsistent =
      consistency.consistent && unmanagedPositions.length === 0 && !hasOffsettingPhysicalLots;
    this.#ledgerBlockReason = unmanagedPositions.length > 0
      ? `자동운용 월물 외에 보유 중인 선물·옵션(${summarizeSymbols(unmanagedPositions.map((position) => position.symbol))})이 있어 주문을 막았습니다.`
      : hasOffsettingPhysicalLots
        ? "같은 월물의 매수·매도 포지션이 동시에 있어 순수량만으로 안전하게 구분할 수 없습니다."
        : consistency.consistent
          ? null
          : ledger.length === 0 && netQuantity !== 0
        ? "계좌에 이미 보유한 선물이 있습니다. 헤지용인지 추세매매용인지 확인하기 전에는 자동주문하지 않습니다."
        : `선물 실제 수량(${consistency.brokerNetQuantity})과 용도별 기록(${consistency.allocatedQuantity})이 달라 자동주문을 막았습니다.`;
  }

  async #reconcileKnownOrders(
    brokerOpenOrders: DerivativeOrder[],
    executions: DerivativeExecution[],
  ): Promise<void> {
    if (!this.#accountKey) return;
    const known = this.#repository.listDerivativesOrders(this.#accountKey, { limit: 5_000 });
    for (const execution of executions) {
      const order = this.#findKnownBrokerOrder(known, execution.brokerOrderId, execution.symbol);
      if (!order) continue;
      try {
        const current = this.#repository.getDerivativesOrder(order.id, this.#accountKey);
        const remainingQuantity = current
          ? Math.max(0, current.orderedQuantity - current.filledQuantity)
          : Math.max(0, order.orderedQuantity - order.filledQuantity);
        const incrementalQuantity = Math.min(execution.quantity, remainingQuantity);
        if (incrementalQuantity <= 0) continue;
        const recorded = this.#repository.recordDerivativesFill({
          id: `${this.#accountKey}:${execution.executionId}`,
          accountKey: this.#accountKey,
          orderId: order.id,
          brokerExecutionId: execution.executionId,
          brokerOrderId: execution.brokerOrderId,
          quantity: incrementalQuantity,
          priceTicks: Math.max(0, Math.round(execution.price * PRICE_SCALE)),
          executedAt: execution.executedAt ?? toIsoDateTime(),
          raw: execution.raw,
        });
        if (recorded.inserted) {
          this.#applyPurposeFill(
            order,
            incrementalQuantity,
            execution.price,
          );
        }
      } catch (error) {
        this.#options.onError(error, "derivatives-fill-reconcile", "critical");
      }
    }
    for (const order of known) {
      if (!order.brokerOrderId || isTerminal(order.status)) continue;
      const contractCode = this.#repository.getDerivativesContract(order.contractId)?.contractCode;
      const broker = brokerOpenOrders.find((candidate) =>
        candidate.brokerOrderId === order.brokerOrderId
        && (contractCode === undefined || candidate.symbol === contractCode),
      );
      if (!broker) {
        const current = this.#repository.getDerivativesOrder(order.id, this.#accountKey);
        if (current && !isTerminal(current.status) && current.brokerOrderId) {
          try {
            this.#repository.applyDerivativesOrderUpdate({
              accountKey: this.#accountKey,
              orderId: current.id,
              status: "UNKNOWN",
              brokerUpdatedAt: toIsoDateTime(),
              raw: {
                reconciliation: "BROKER_ORDER_ABSENT_FROM_OPEN_ORDERS",
                previousStatus: current.status,
              },
            });
          } catch (error) {
            this.#options.onError(error, "derivatives-order-missing-reconcile", "critical");
          }
        }
        continue;
      }
      const status = mapOrderStatus(broker.status);
      try {
        this.#repository.applyDerivativesOrderUpdate({
          accountKey: this.#accountKey,
          orderId: order.id,
          status,
          brokerOrderId: broker.brokerOrderId,
          originalBrokerOrderId: broker.originalBrokerOrderId,
          filledQuantity: broker.filledQuantity,
          remainingQuantity: broker.remainingQuantity,
          ...(broker.averageFillPrice === undefined
            ? {}
            : { averageFillPriceTicks: Math.round(broker.averageFillPrice * PRICE_SCALE) }),
          brokerUpdatedAt: broker.orderedAt ?? toIsoDateTime(),
          raw: broker.raw,
        });
      } catch (error) {
        this.#options.onError(error, "derivatives-order-reconcile", "warning");
      }
    }
  }

  #findKnownBrokerOrder(
    known: DerivativesOrderRecord[],
    brokerOrderId: string,
    symbol: string,
  ): DerivativesOrderRecord | undefined {
    return known.find((candidate) => {
      if (candidate.brokerOrderId !== brokerOrderId) return false;
      return this.#repository.getDerivativesContract(candidate.contractId)?.contractCode === symbol;
    });
  }

  async #cancelStaleOrders(brokerOpenOrders: DerivativeOrder[]): Promise<void> {
    if (!this.#adapter || !this.#accountKey || !this.#options.canMutate()) return;
    const thresholdMs = this.#settings.unfilledTimeoutSeconds * 1_000;
    const now = Date.now();
    const known = this.#repository.listOpenDerivativesOrders(this.#accountKey);
    for (const brokerOrder of brokerOpenOrders) {
      if (brokerOrder.remainingQuantity <= 0) continue;
      const order = this.#findKnownBrokerOrder(
        known,
        brokerOrder.brokerOrderId,
        brokerOrder.symbol,
      );
      if (!order || order.status === "CANCEL_REQUESTED") continue;
      const orderedAt = Date.parse(order.orderedAt);
      if (!Number.isFinite(orderedAt) || now - orderedAt < thresholdMs) continue;
      try {
        this.#repository.applyDerivativesOrderUpdate({
          accountKey: this.#accountKey,
          orderId: order.id,
          status: "CANCEL_REQUESTED",
          brokerUpdatedAt: toIsoDateTime(),
          raw: {
            cancellation: "UNFILLED_TIMEOUT",
            timeoutSeconds: this.#settings.unfilledTimeoutSeconds,
            remainingQuantity: brokerOrder.remainingQuantity,
          },
        });
        const submission = await this.#adapter.cancelOrder({
          brokerOrderId: brokerOrder.brokerOrderId,
          session: brokerOrder.session,
          cancelAllRemaining: true,
        });
        this.#repository.applyDerivativesOrderUpdate({
          accountKey: this.#accountKey,
          orderId: order.id,
          status: "CANCEL_REQUESTED",
          brokerUpdatedAt: submission.acceptedAt,
          raw: {
            cancellation: "UNFILLED_TIMEOUT_ACCEPTED",
            cancellationBrokerOrderId: submission.brokerOrderId,
            broker: submission.raw,
          },
        });
      } catch (error) {
        try {
          this.#repository.applyDerivativesOrderUpdate({
            accountKey: this.#accountKey,
            orderId: order.id,
            status: "UNKNOWN",
            brokerUpdatedAt: toIsoDateTime(),
            raw: {
              cancellation: "UNFILLED_TIMEOUT_UNKNOWN",
              message: error instanceof Error ? error.message : String(error),
            },
          });
        } catch (persistenceError) {
          this.#options.onError(
            persistenceError,
            "derivatives-stale-cancel-persist",
            "critical",
          );
        }
        this.#options.onError(error, "derivatives-stale-cancel", "critical");
      }
    }
  }

  #applyPurposeFill(order: DerivativesOrderRecord, quantity: number, price: number): void {
    if (!this.#accountKey) return;
    const rows = this.#repository.listDerivativesPurposeLedger(this.#accountKey, order.contractId);
    const byPurpose = new Map(rows.map((row) => [row.purpose, row]));
    const delta = signedOrderDelta(order.action, order.direction, quantity);
    const contract = this.#repository.getDerivativesContract(order.contractId);
    if (!contract) throw new Error(`선물 계약 정보를 찾지 못했습니다: ${order.contractId}`);
    if (!Number.isFinite(price) || price <= 0) {
      throw new RangeError("선물 체결가격이 올바르지 않아 손익 기록을 갱신하지 않았습니다.");
    }
    const fillPriceTicks = Math.round(price * contract.priceScale);
    const updated = (purpose: DerivativesPositionPurpose) => {
      const row = byPurpose.get(purpose);
      if (purpose !== order.purpose) {
        return {
          purpose,
          signedQuantity: row?.signedQuantity ?? 0,
          averagePriceTicks: row?.averagePriceTicks ?? 0,
          realizedPnlKrw: row?.realizedPnlKrw ?? 0,
        };
      }
      const applied = applyPurposeLedgerFill({
        signedQuantity: row?.signedQuantity ?? 0,
        averagePriceTicks: row?.averagePriceTicks ?? 0,
        realizedPnlKrw: row?.realizedPnlKrw ?? 0,
        signedFillQuantity: delta,
        fillPriceTicks,
        priceScale: contract.priceScale,
        contractMultiplierKrw: contract.multiplierKrw,
      });
      return {
        purpose,
        ...applied,
      };
    };
    this.#repository.replaceDerivativesPurposeLedger({
      accountKey: this.#accountKey,
      contractId: order.contractId,
      allocations: [updated("HEDGE"), updated("DIRECTIONAL")],
    });
  }

  #refreshPlans(): void {
    if (!this.#accountKey || !this.#contract || !this.#quote) {
      this.#hedgePlan = null;
      this.#directionalPlan = null;
      return;
    }
    const position = this.#repository.getDerivativesPosition(this.#accountKey, this.#contract.id);
    if (!position) return;
    const ledger = this.#repository.listDerivativesPurposeLedger(this.#accountKey, this.#contract.id);
    const hedgeQuantity = ledger
      .filter((row) => row.purpose === "HEDGE")
      .reduce((sum, row) => sum + row.signedQuantity, 0);
    const directionalQuantity = ledger
      .filter((row) => row.purpose === "DIRECTIONAL")
      .reduce((sum, row) => sum + row.signedQuantity, 0);
    this.#hedgePlan = this.#settings.hedge.enabled
      ? planEquityExposureHedgeFromLedger({
          equityExposureKrw: this.#options.getEquityExposureKrw(),
          futuresPriceTicks: Math.round(this.#quote.price * PRICE_SCALE),
          priceScale: PRICE_SCALE,
          contractMultiplierKrw: MINI_KOSPI200_MULTIPLIER_KRW,
          hedgeRatioBps: this.#settings.hedge.hedgeRatioBps,
          minRebalanceContracts: this.#settings.hedge.minRebalanceContracts,
          purposeLedger: ledger,
          brokerPosition: position,
        })
      : null;
    this.#directionalPlan = this.#settings.directional.enabled
      ? planDirectionalMovingAverage({
          bars: this.#dailyBars,
          fastPeriod: this.#settings.directional.fastPeriod,
          slowPeriod: this.#settings.directional.slowPeriod,
          minimumGapBps: this.#settings.directional.minimumGapBps,
          sideMode: this.#settings.directional.sideMode,
          targetContracts: this.#settings.directional.targetContracts,
          currentDirectionalQuantity: directionalQuantity,
          currentHedgeQuantity: hedgeQuantity,
          brokerNetQuantity: position.netQuantity,
        })
      : null;
  }

  async #evaluateAndDispatch(session: DerivativeSession): Promise<void> {
    const blockers = this.#orderBlockers(session);
    if (blockers.length > 0 || !this.#accountKey || !this.#contract || !this.#adapter) return;
    const plan = this.#nextOrderPlan();
    if (!plan) return;
    if (
      this.#settings.newPositionsPaused &&
      Math.abs(plan.targetPurpose) > Math.abs(plan.currentPurpose)
    ) return;
    await this.#dispatchOrder(session, plan);
  }

  #nextOrderPlan(): {
    purpose: DerivativesPositionPurpose;
    action: "OPEN" | "CLOSE";
    direction: "LONG" | "SHORT";
    quantity: number;
    currentPurpose: number;
    targetPurpose: number;
  } | null {
    if (!this.#accountKey || !this.#contract) return null;
    const ledger = this.#repository.listDerivativesPurposeLedger(this.#accountKey, this.#contract.id);
    const hedgeCurrent = ledger.find((row) => row.purpose === "HEDGE")?.signedQuantity ?? 0;
    const directionalCurrent = ledger.find((row) => row.purpose === "DIRECTIONAL")?.signedQuantity ?? 0;
    const hedgeAllowed = this.#settings.mode === "HEDGE" || this.#settings.mode === "HEDGE_AND_DIRECTIONAL";
    if (hedgeAllowed && this.#hedgePlan?.status === "ORDER_REQUIRED" && this.#hedgePlan.orders[0]) {
      return {
        ...this.#hedgePlan.orders[0],
        currentPurpose: hedgeCurrent,
        targetPurpose: this.#hedgePlan.targetHedgeSignedQuantity ?? hedgeCurrent,
      };
    }
    const directionalAllowed = this.#settings.mode === "DIRECTIONAL" || this.#settings.mode === "HEDGE_AND_DIRECTIONAL";
    if (directionalAllowed && this.#directionalPlan?.orders[0]) {
      return {
        ...this.#directionalPlan.orders[0],
        currentPurpose: directionalCurrent,
        targetPurpose: this.#directionalPlan.targetDirectionalQuantity,
      };
    }
    return null;
  }

  #positionLimitBlocker(): string | null {
    if (!this.#accountKey || !this.#contract) return null;
    const plan = this.#nextOrderPlan();
    const position = this.#repository.getDerivativesPosition(this.#accountKey, this.#contract.id);
    if (!plan || !position) return null;
    const nextNetQuantity = position.netQuantity
      + signedOrderDelta(plan.action, plan.direction, plan.quantity);
    if (!Number.isSafeInteger(nextNetQuantity)) {
      return "주문 후 선물 수량을 안전하게 계산할 수 없어 주문을 막았습니다.";
    }
    if (
      Math.abs(nextNetQuantity) > this.#settings.maxContracts
      && Math.abs(nextNetQuantity) >= Math.abs(position.netQuantity)
    ) {
      return `주문 후 실제 보유량 ${Math.abs(nextNetQuantity)}계약이 최대 ${this.#settings.maxContracts}계약을 넘습니다.`;
    }
    return null;
  }

  async #dispatchOrder(
    session: DerivativeSession,
    plan: {
      purpose: DerivativesPositionPurpose;
      action: "OPEN" | "CLOSE";
      direction: "LONG" | "SHORT";
      quantity: number;
      targetPurpose: number;
    },
  ): Promise<void> {
    if (!this.#adapter || !this.#accountKey || !this.#contract || !this.#quote) return;
    const side = (plan.action === "OPEN") === (plan.direction === "LONG") ? "BUY" : "SELL";
    const orderType = this.#settings.orderType;
    const tick = 0.02;
    const signedOffset = side === "BUY" ? this.#settings.limitOffsetTicks : -this.#settings.limitOffsetTicks;
    const limitPrice = orderType === "LIMIT"
      ? Math.max(tick, Math.round((this.#quote.price + signedOffset * tick) / tick) * tick)
      : undefined;
    if (plan.action === "OPEN") {
      const capacity = await this.#adapter.fetchOrderCapacity({
        symbol: this.#contract.symbol,
        session,
        side,
        orderType,
        ...(limitPrice === undefined ? {} : { limitPrice }),
      });
      if (capacity.orderableQuantity === undefined) {
        throw new Error("증권사가 주문가능수량을 주지 않아 신규 선물 주문을 막았습니다.");
      }
      if (capacity.orderableQuantity < plan.quantity) {
        throw new Error(`주문가능수량은 ${capacity.orderableQuantity}계약인데 ${plan.quantity}계약을 요청했습니다.`);
      }
    }
    const idempotencyKey = stableHash({
      accountKey: this.#accountKey,
      contractId: this.#contract.id,
      tradingDate: koreanTradingDate(),
      purpose: plan.purpose,
      action: plan.action,
      direction: plan.direction,
      quantity: plan.quantity,
      targetPurpose: plan.targetPurpose,
      hedgeInput: this.#hedgePlan?.sourceEquityExposureKrw,
      directionalGap: this.#directionalPlan?.gapBps,
    });
    const intentId = randomUUID();
    const created = this.#repository.createDerivativesOrderIntent({
      id: intentId,
      orderId: intentId,
      accountKey: this.#accountKey,
      idempotencyKey,
      clientOrderId: randomUUID(),
      contractId: this.#contract.id,
      action: plan.action,
      direction: plan.direction,
      purpose: plan.purpose,
      quantity: plan.quantity,
      ...(limitPrice === undefined ? {} : { limitPriceTicks: Math.round(limitPrice * PRICE_SCALE) }),
    });
    if (!created.created || created.order.status !== "QUEUED") return;
    this.#repository.applyDerivativesOrderUpdate({
      accountKey: this.#accountKey,
      orderId: created.order.id,
      status: "SENDING",
    });
    try {
      const submission = await this.#adapter.placeOrder({
        symbol: this.#contract.symbol,
        instrumentKind: "INDEX_FUTURE",
        session,
        direction: plan.direction,
        positionEffect: plan.action,
        quantity: plan.quantity,
        orderType,
        timeInForce: "DAY",
        ...(limitPrice === undefined ? {} : { limitPrice }),
      });
      this.#repository.applyDerivativesOrderUpdate({
        accountKey: this.#accountKey,
        orderId: created.order.id,
        status: "ACKED",
        brokerOrderId: submission.brokerOrderId,
        brokerUpdatedAt: submission.acceptedAt,
        raw: submission.raw,
      });
    } catch (error) {
      const status: OrderStatus = error instanceof BrokerRejectedError ? "REJECTED" : "UNKNOWN";
      this.#repository.applyDerivativesOrderUpdate({
        accountKey: this.#accountKey,
        orderId: created.order.id,
        status,
        brokerUpdatedAt: toIsoDateTime(),
        raw: { message: error instanceof Error ? error.message : String(error) },
      });
      this.#options.onError(
        error,
        "derivatives-order-dispatch",
        status === "UNKNOWN" ? "critical" : "error",
      );
    }
  }

  #orderBlockers(session: DerivativeSession): string[] {
    const blockers: string[] = [];
    if (!this.#settings.autoTradingEnabled || this.#settings.emergencyHalt) blockers.push("선물 자동운용이 꺼져 있습니다.");
    if (!this.#options.canMutate()) blockers.push("엔진 단일 실행 안전장치를 확인하지 못했습니다.");
    if (!this.#adapter || !this.#connection.authenticated) blockers.push("한국투자증권 선물 API 로그인이 필요합니다.");
    if (!this.#connection.accountSynchronized) blockers.push("선물 잔고·미체결 동기화가 필요합니다.");
    if (!this.#connection.marketWebSocketConnected) blockers.push("선물 실시간 시세 연결이 필요합니다.");
    if (!this.#connection.accountNoticesConnected) blockers.push("선물 주문·체결 실시간 연결이 필요합니다.");
    if (!this.#contract || !this.#quote) blockers.push("거래할 미니 코스피200 선물 시세가 없습니다.");
    if (this.#quote && Date.now() - Date.parse(this.#quote.receivedAt) > QUOTE_STALE_MS) blockers.push("선물 시세가 오래되어 새 주문을 막았습니다.");
    if (!this.#ledgerConsistent) blockers.push(this.#ledgerBlockReason ?? "선물 수량 기록이 일치하지 않습니다.");
    const hedgeMustBeHealthy = this.#settings.hedge.enabled
      && (this.#settings.mode === "HEDGE" || this.#settings.mode === "HEDGE_AND_DIRECTIONAL");
    if (hedgeMustBeHealthy && this.#hedgePlan?.blocked) {
      blockers.push(
        this.#hedgePlan.reasons.includes("INVALID_EQUITY_EXPOSURE")
          ? "연결된 모든 현물 계좌의 실제 보유금액을 확인하지 못해 헤지 주문을 막았습니다."
          : "현물 보호 계약 수를 안전하게 계산하지 못해 선물 주문을 막았습니다.",
      );
    }
    if (!this.#isOrderWindowOpen(session)) blockers.push("현재 선물 거래소 주문 시간이 아닙니다.");
    if (this.#account?.openOrders.some((order) => order.remainingQuantity > 0)) blockers.push("먼저 처리할 선물 미체결 주문이 있습니다.");
    if (this.#accountKey && this.#repository.listOpenDerivativesOrders(this.#accountKey).length > 0) blockers.push("엔진에서 처리 중인 선물 주문이 있습니다.");
    const positionLimitBlocker = this.#positionLimitBlocker();
    if (positionLimitBlocker) blockers.push(positionLimitBlocker);
    const profitLoss = this.#profitLoss();
    if (profitLoss.totalPnlKrw !== null && profitLoss.totalPnlKrw <= -this.#settings.maxDailyLossKrw) {
      blockers.push("설정한 선물 최대 손실에 도달했습니다.");
    }
    if (this.#account && this.#account.positions.length > 0 && profitLoss.unrealizedPnlKrw === null) {
      blockers.push("선물 평가손익을 확인할 수 없어 새 주문을 막았습니다.");
    }
    if (this.#account?.depositCash && this.#account.initialMargin !== undefined) {
      const usageBps = Math.round((this.#account.initialMargin / this.#account.depositCash) * 10_000);
      if (usageBps >= this.#settings.maxMarginUsageBps) blockers.push("설정한 증거금 사용 한도에 도달했습니다.");
    }
    return [...new Set(blockers)];
  }

  #handleEvent(event: KisDerivativeEvent): void {
    if (event.type === "connection") {
      this.#connection.marketWebSocketConnected = event.connected;
      this.#connection.accountNoticesConnected = event.accountNoticesConnected;
      if (!event.connected && this.#connection.state === "CONNECTED") {
        this.#connection.state = "DEGRADED";
        this.#connection.message = "선물 실시간 연결을 다시 시도하고 있습니다.";
      }
      return;
    }
    if (event.type === "quote" && event.quote.symbol === this.#contract?.symbol) {
      this.#quote = event.quote;
      return;
    }
    if (event.type === "execution" || event.type === "order") {
      void this.sync().catch((error: unknown) => this.#recordSyncFailure(error));
      return;
    }
    if (event.type === "error") {
      this.#connection.state = "DEGRADED";
      this.#connection.lastError = event.message;
      this.#options.onError(new Error(event.message), "derivatives-websocket", "warning");
    }
  }

  #recordSyncFailure(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.#connection = {
      ...this.#connection,
      state: this.#connection.authenticated ? "DEGRADED" : "ERROR",
      accountSynchronized: false,
      checkedAt: toIsoDateTime(),
      message: "선물 계좌 동기화에 실패해 실제 주문을 막았습니다.",
      lastError: message,
    };
    this.#publishCredentialStatus();
    this.#options.onError(error, "derivatives-runtime-sync", "error");
  }

  #publishCredentialStatus(): void {
    if (!this.#options.onCredentialStatus) return;
    const verified = this.#connection.authenticated && this.#connection.accountSynchronized;
    this.#options.onCredentialStatus({
      environment: this.#settings.environment,
      connection: {
        state: verified ? "VERIFIED" : this.#connection.state === "CONNECTING" ? "VERIFYING" : "FAILED",
        authenticated: this.#connection.authenticated,
        accountSynchronized: this.#connection.accountSynchronized,
        checkedAt: this.#connection.checkedAt,
        message: this.#connection.message,
      },
      ...(this.#account
        ? {
            account: {
              maskedAccountId: maskAccount(this.#account.accountId.replace(/-03$/, "")),
              accountProductCode: "03",
              positionCount: this.#account.positions.length,
              openOrderCount: this.#account.openOrders.length,
              observedAt: this.#account.observedAt,
              unavailableFields: this.#account.unavailableFields,
            },
          }
        : {}),
    });
  }

  #safeEquityExposureTotal(): number | null {
    const rows = this.#options.getEquityExposureKrw();
    if (rows === null) return null;
    if (rows.some((value) => !Number.isSafeInteger(value) || value < 0)) return null;
    const total = rows.reduce((sum, value) => sum + value, 0);
    return Number.isSafeInteger(total) ? total : null;
  }

  #profitLoss(): {
    realizedPnlKrw: number | null;
    cumulativeRealizedPnlKrw: number | null;
    unrealizedPnlKrw: number | null;
    totalPnlKrw: number | null;
  } {
    const cumulativeRealizedPnlKrw = this.#accountKey
      ? safeIntegerSum(
          this.#repository
            .listDerivativesPurposeLedger(this.#accountKey)
            .map((row) => row.realizedPnlKrw),
        )
      : null;
    const baseline = this.#dailyPnlBaseline();
    const realizedPnlKrw = cumulativeRealizedPnlKrw !== null && baseline !== null
      ? safeIntegerSum([cumulativeRealizedPnlKrw, -baseline])
      : null;
    const unrealizedPnlKrw = this.#account
      && this.#account.positions.every((position) => position.evaluationProfitLoss !== undefined)
      ? safeIntegerSum(
          this.#account.positions.map((position) => Math.round(position.evaluationProfitLoss ?? 0)),
        )
      : null;
    const totalPnlKrw = realizedPnlKrw !== null && unrealizedPnlKrw !== null
      ? safeIntegerSum([realizedPnlKrw, unrealizedPnlKrw])
      : null;
    return { realizedPnlKrw, cumulativeRealizedPnlKrw, unrealizedPnlKrw, totalPnlKrw };
  }

  #dailyPnlStateKey(): string | null {
    return this.#accountKey ? `${DAILY_PNL_BASELINE_KEY_PREFIX}:${this.#accountKey}` : null;
  }

  #dailyPnlBaseline(): number | null {
    const key = this.#dailyPnlStateKey();
    if (!key) return null;
    const value = this.#repository.getRuntimeState<unknown>(null, key);
    if (!value || typeof value !== "object") return null;
    const candidate = value as { tradingDate?: unknown; realizedPnlKrw?: unknown };
    return candidate.tradingDate === koreanTradingDate()
      && Number.isSafeInteger(candidate.realizedPnlKrw)
      ? candidate.realizedPnlKrw as number
      : null;
  }

  #ensureDailyPnlBaseline(): void {
    const key = this.#dailyPnlStateKey();
    if (!key || this.#dailyPnlBaseline() !== null) return;
    const realizedPnlKrw = safeIntegerSum(
      this.#repository
        .listDerivativesPurposeLedger(this.#accountKey!)
        .map((row) => row.realizedPnlKrw),
    );
    if (realizedPnlKrw === null) {
      throw new RangeError("선물 누적 확정손익이 안전한 숫자 범위를 벗어났습니다.");
    }
    this.#repository.setRuntimeState(null, key, {
      tradingDate: koreanTradingDate(),
      realizedPnlKrw,
      recordedAt: toIsoDateTime(),
    });
  }
}

function compactDate(value: Date): string {
  return value.toISOString().slice(0, 10).replaceAll("-", "");
}

function publicOrder(order: DerivativeOrder) {
  return {
    brokerOrderId: order.brokerOrderId,
    symbol: order.symbol,
    side: order.side,
    requestedQuantity: order.requestedQuantity,
    filledQuantity: order.filledQuantity,
    remainingQuantity: order.remainingQuantity,
    orderPrice: order.orderPrice ?? null,
    averageFillPrice: order.averageFillPrice ?? null,
    status: order.status,
    session: order.session,
    orderedAt: order.orderedAt ?? null,
  };
}

function mapOrderStatus(status: DerivativeOrder["status"]): OrderStatus {
  if (status === "OPEN") return "ACKED";
  return status;
}

function isTerminal(status: OrderStatus): boolean {
  return status === "FILLED" || status === "CANCELED" || status === "REJECTED";
}

function signedOrderDelta(
  action: "OPEN" | "CLOSE",
  direction: "LONG" | "SHORT",
  quantity: number,
): number {
  if (action === "OPEN") return direction === "LONG" ? quantity : -quantity;
  return direction === "LONG" ? -quantity : quantity;
}

export interface PurposeLedgerFillInput {
  signedQuantity: number;
  averagePriceTicks: number;
  realizedPnlKrw: number;
  signedFillQuantity: number;
  fillPriceTicks: number;
  priceScale: number;
  contractMultiplierKrw: number;
}

/** Applies one broker fill to one virtual-purpose position without losing cost basis. */
export function applyPurposeLedgerFill(input: PurposeLedgerFillInput): {
  signedQuantity: number;
  averagePriceTicks: number;
  realizedPnlKrw: number;
} {
  const integerFields = [
    input.signedQuantity,
    input.averagePriceTicks,
    input.realizedPnlKrw,
    input.signedFillQuantity,
    input.fillPriceTicks,
    input.priceScale,
    input.contractMultiplierKrw,
  ];
  if (integerFields.some((value) => !Number.isSafeInteger(value))) {
    throw new RangeError("Purpose-ledger fill values must be safe integers");
  }
  if (
    input.averagePriceTicks < 0
    || input.fillPriceTicks < 0
    || input.priceScale <= 0
    || input.contractMultiplierKrw <= 0
    || input.signedFillQuantity === 0
  ) {
    throw new RangeError("Purpose-ledger fill contains an invalid price, scale, multiplier, or quantity");
  }

  const signedQuantity = input.signedQuantity + input.signedFillQuantity;
  if (!Number.isSafeInteger(signedQuantity)) {
    throw new RangeError("Purpose-ledger quantity exceeds the safe integer range");
  }

  if (input.signedQuantity === 0) {
    return {
      signedQuantity,
      averagePriceTicks: input.fillPriceTicks,
      realizedPnlKrw: input.realizedPnlKrw,
    };
  }

  if (Math.sign(input.signedQuantity) === Math.sign(input.signedFillQuantity)) {
    const quantity = BigInt(Math.abs(signedQuantity));
    const weightedTicks = (
      BigInt(Math.abs(input.signedQuantity)) * BigInt(input.averagePriceTicks)
      + BigInt(Math.abs(input.signedFillQuantity)) * BigInt(input.fillPriceTicks)
    );
    return {
      signedQuantity,
      averagePriceTicks: safeBigIntToNumber((weightedTicks + quantity / 2n) / quantity),
      realizedPnlKrw: input.realizedPnlKrw,
    };
  }

  const closedQuantity = Math.min(
    Math.abs(input.signedQuantity),
    Math.abs(input.signedFillQuantity),
  );
  const directionSign = input.signedQuantity > 0 ? 1n : -1n;
  const realizedDelta = roundedBigIntRatio(
    BigInt(input.fillPriceTicks - input.averagePriceTicks)
      * directionSign
      * BigInt(closedQuantity)
      * BigInt(input.contractMultiplierKrw),
    BigInt(input.priceScale),
  );
  const realizedPnlKrw = safeBigIntToNumber(
    BigInt(input.realizedPnlKrw) + realizedDelta,
  );
  return {
    signedQuantity,
    averagePriceTicks: signedQuantity === 0
      ? 0
      : Math.sign(signedQuantity) === Math.sign(input.signedQuantity)
        ? input.averagePriceTicks
        : input.fillPriceTicks,
    realizedPnlKrw,
  };
}

function strategyModeFor(
  hedgeEnabled: boolean,
  directionalEnabled: boolean,
  fallback: DerivativesAutomationSettings["mode"],
): DerivativesAutomationSettings["mode"] {
  if (hedgeEnabled && directionalEnabled) return "HEDGE_AND_DIRECTIONAL";
  if (hedgeEnabled) return "HEDGE";
  if (directionalEnabled) return "DIRECTIONAL";
  return fallback;
}

function summarizeSymbols(symbols: string[]): string {
  const unique = [...new Set(symbols)].sort();
  return unique.length <= 3
    ? unique.join(", ")
    : `${unique.slice(0, 3).join(", ")} 외 ${unique.length - 3}개`;
}

function safeIntegerSum(values: number[]): number | null {
  let total = 0;
  for (const value of values) {
    if (!Number.isSafeInteger(value)) return null;
    total += value;
    if (!Number.isSafeInteger(total)) return null;
  }
  return total;
}

function roundedBigIntRatio(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new RangeError("Ratio denominator must be positive");
  const sign = numerator < 0n ? -1n : 1n;
  const absolute = numerator < 0n ? -numerator : numerator;
  return sign * ((absolute + denominator / 2n) / denominator);
}

function safeBigIntToNumber(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new RangeError("Purpose-ledger value exceeds the safe integer range");
  }
  return Number(value);
}
