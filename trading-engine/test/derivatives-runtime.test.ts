import { afterEach, describe, expect, it, vi } from "vitest";
import { createInMemoryTradingRepository, type TradingRepository } from "@kstock/database";
import {
  createDerivativesAccountKey,
  createDefaultDerivativesAutomationSettings,
  type BrokerCredentials,
} from "@kstock/shared";
import type {
  DerivativeAccountSnapshot,
  DerivativeDailyBar,
  DerivativeExecution,
  DerivativeOrder,
  DerivativeOrderCapacity,
  DerivativeOrderSubmission,
  DerivativeQuoteSubscription,
  IndexFutureContractQuote,
  KisDerivativeEvent,
  PlaceDerivativeOrderRequest,
} from "@kstock/broker-kis-derivatives";
import {
  applyPurposeLedgerFill,
  DerivativesRuntime,
  type DerivativeTradingAdapter,
  type DerivativesVenueSession,
} from "../src/derivatives/runtime.js";

describe("derivatives purpose-ledger fill accounting", () => {
  it("keeps a weighted entry price when adding contracts", () => {
    expect(applyPurposeLedgerFill({
      signedQuantity: 2,
      averagePriceTicks: 35_000,
      realizedPnlKrw: 0,
      signedFillQuantity: 1,
      fillPriceTicks: 35_300,
      priceScale: 100,
      contractMultiplierKrw: 50_000,
    })).toEqual({
      signedQuantity: 3,
      averagePriceTicks: 35_100,
      realizedPnlKrw: 0,
    });
  });

  it("records long and short closing profit with the Mini-KOSPI200 multiplier", () => {
    const longClose = applyPurposeLedgerFill({
      signedQuantity: 3,
      averagePriceTicks: 35_100,
      realizedPnlKrw: 0,
      signedFillQuantity: -1,
      fillPriceTicks: 35_500,
      priceScale: 100,
      contractMultiplierKrw: 50_000,
    });
    const shortClose = applyPurposeLedgerFill({
      signedQuantity: -2,
      averagePriceTicks: 35_000,
      realizedPnlKrw: 0,
      signedFillQuantity: 2,
      fillPriceTicks: 34_500,
      priceScale: 100,
      contractMultiplierKrw: 50_000,
    });

    expect(longClose).toEqual({
      signedQuantity: 2,
      averagePriceTicks: 35_100,
      realizedPnlKrw: 200_000,
    });
    expect(shortClose).toEqual({
      signedQuantity: 0,
      averagePriceTicks: 0,
      realizedPnlKrw: 500_000,
    });
  });
});

const NOW = "2026-09-07T01:00:00.000Z";
const CREDENTIALS: BrokerCredentials = {
  appKey: "test-key",
  appSecret: "test-secret",
  accountId: "12345678",
  accountProductCode: "03",
  htsId: "test-user",
};

function openSessions(): DerivativesVenueSession[] {
  return [
    {
      id: "KRX_DERIVATIVES_DAY",
      orderable: true,
      state: "OPEN",
      phase: "DAY_SESSION",
      tradingDate: "2026-09-07",
      nextTransitionAt: "2026-09-07T06:45:00.000Z",
      checkedAt: NOW,
    },
    {
      id: "KRX_DERIVATIVES_NIGHT",
      orderable: false,
      state: "CLOSED",
      phase: "CLOSED",
      tradingDate: "2026-09-07",
      nextTransitionAt: "2026-09-07T08:50:00.000Z",
      checkedAt: NOW,
    },
  ];
}

function emptyAccount(overrides: Partial<DerivativeAccountSnapshot> = {}): DerivativeAccountSnapshot {
  return {
    session: "DAY",
    accountId: "12345678-03",
    accountProductCode: "03",
    currency: "KRW",
    depositCash: 50_000_000,
    orderableCash: 50_000_000,
    initialMargin: 0,
    maintenanceMargin: 0,
    positions: [],
    openOrders: [],
    observedAt: NOW,
    rawSummary: {},
    unavailableFields: [],
    ...overrides,
  };
}

function dailyBars(): DerivativeDailyBar[] {
  return Array.from({ length: 20 }, (_, index) => {
    const close = 300 + index;
    return {
      tradingDate: `202608${String(index + 1).padStart(2, "0")}`,
      open: close,
      high: close,
      low: close,
      close,
      volume: 1_000,
      raw: {},
    };
  });
}

class FakeDerivativeAdapter implements DerivativeTradingAdapter {
  readonly environment = "live" as const;
  readonly connected = true;
  readonly placeOrder = vi.fn(async (_request: PlaceDerivativeOrderRequest): Promise<DerivativeOrderSubmission> => ({
    brokerOrderId: "fake-order-1",
    acceptedAt: NOW,
    session: "DAY",
    raw: {},
  }));
  readonly fetchOrderCapacity = vi.fn(async (): Promise<DerivativeOrderCapacity> => ({
    symbol: "105V6000",
    side: "SELL",
    orderableQuantity: 10,
    orderableAmount: 100_000_000,
    raw: {},
    unavailableFields: [],
  }));
  readonly cancelOrder = vi.fn(async (): Promise<DerivativeOrderSubmission> => ({
    brokerOrderId: "fake-cancel-1",
    acceptedAt: NOW,
    session: "DAY",
    raw: {},
  }));
  readonly #account: DerivativeAccountSnapshot;
  readonly #webSocketConnected: boolean;
  readonly #accountNoticesConnected: boolean;
  #listener: ((event: KisDerivativeEvent) => void) | null = null;

  constructor(input: {
    account?: DerivativeAccountSnapshot;
    webSocketConnected?: boolean;
    accountNoticesConnected?: boolean;
  } = {}) {
    this.#account = input.account ?? emptyAccount();
    this.#webSocketConnected = input.webSocketConnected ?? true;
    this.#accountNoticesConnected = input.accountNoticesConnected ?? true;
  }

  async connect(): Promise<void> {
    this.#listener?.({
      type: "connection",
      connected: this.#webSocketConnected,
      accountNoticesConnected: this.#accountNoticesConnected,
      at: NOW,
    });
  }

  async disconnect(): Promise<void> {}

  onEvent(listener: (event: KisDerivativeEvent) => void): () => void {
    this.#listener = listener;
    return () => { this.#listener = null; };
  }

  async fetchAccountSnapshot(): Promise<DerivativeAccountSnapshot> {
    return structuredClone(this.#account);
  }

  async fetchOpenOrders(): Promise<DerivativeOrder[]> {
    return structuredClone(this.#account.openOrders);
  }

  async fetchExecutions(): Promise<DerivativeExecution[]> {
    return [];
  }

  async fetchQuote() {
    return {
      symbol: "105V6000",
      instrumentKind: "INDEX_FUTURE" as const,
      session: "DAY" as const,
      price: 350,
      receivedAt: new Date().toISOString(),
    };
  }

  async fetchMiniKospi200Contracts(): Promise<IndexFutureContractQuote[]> {
    return [{
      symbol: "105V6000",
      name: "미니코스피200 선물",
      currentPrice: 350,
      bidPrice: 349.98,
      askPrice: 350.02,
      cumulativeVolume: 1_000,
      remainingDays: 30,
      raw: {},
    }];
  }

  async fetchDailyBars(): Promise<DerivativeDailyBar[]> {
    return dailyBars();
  }

  async replaceQuoteSubscriptions(_subscriptions: DerivativeQuoteSubscription[]): Promise<void> {}
}

const runtimes: DerivativesRuntime[] = [];
const repositories: TradingRepository[] = [];

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.stop()));
  repositories.splice(0).forEach((repository) => repository.close());
});

function createRuntime(input: {
  adapter: FakeDerivativeAdapter;
  settings?: ReturnType<typeof createDefaultDerivativesAutomationSettings>;
  exposureKrw?: number;
  prepareRepository?: (repository: TradingRepository) => void;
}) {
  const repository = createInMemoryTradingRepository();
  repositories.push(repository);
  if (input.settings) {
    repository.setRuntimeState(null, "derivatives-automation-settings", input.settings);
  }
  input.prepareRepository?.(repository);
  const runtime = new DerivativesRuntime({
    repository,
    loadCredentials: async () => CREDENTIALS,
    createAdapter: () => input.adapter,
    getSessions: openSessions,
    getEquityExposureKrw: () => [input.exposureKrw ?? 20_000_000],
    canMutate: () => true,
    onError: vi.fn(),
  });
  runtimes.push(runtime);
  return { runtime, repository };
}

function seedSelectedContractPosition(
  repository: TradingRepository,
  signedQuantity: number,
  purpose: "HEDGE" | "DIRECTIONAL" = "DIRECTIONAL",
) {
  const accountKey = createDerivativesAccountKey({
    providerId: "koreainvestment",
    product: "derivatives",
    environment: "live",
    accountId: "12345678",
    accountProductCode: "03",
  });
  repository.upsertDerivativesAccount({
    scope: {
      providerId: "koreainvestment",
      product: "derivatives",
      environment: "live",
      accountId: "12345678",
      accountProductCode: "03",
    },
    enabled: true,
    updatedAt: NOW,
  });
  repository.upsertDerivativesContract({
    contract: {
      id: "koreainvestment:105V6000",
      providerId: "koreainvestment",
      contractCode: "105V6000",
      name: "미니코스피200 선물",
      contractType: "FUTURE",
      underlyingCode: "KOSPI200",
      multiplierKrw: 50_000,
      priceScale: 100,
      expiryDate: "2026-10-08",
      active: true,
      raw: {},
    },
    updatedAt: NOW,
  });
  repository.upsertDerivativesPosition({
    accountKey,
    contractId: "koreainvestment:105V6000",
    netQuantity: signedQuantity,
    averagePriceTicks: signedQuantity === 0 ? 0 : 35_000,
    currentPriceTicks: 35_000,
    marginRequiredKrw: 0,
    unrealizedPnlKrw: 0,
    brokerUpdatedAt: NOW,
    raw: {},
  });
  repository.replaceDerivativesPurposeLedger({
    accountKey,
    contractId: "koreainvestment:105V6000",
    allocations: [
      {
        purpose: "HEDGE",
        signedQuantity: purpose === "HEDGE" ? signedQuantity : 0,
        averagePriceTicks: purpose === "HEDGE" && signedQuantity !== 0 ? 35_000 : 0,
        realizedPnlKrw: 0,
      },
      {
        purpose: "DIRECTIONAL",
        signedQuantity: purpose === "DIRECTIONAL" ? signedQuantity : 0,
        averagePriceTicks: purpose === "DIRECTIONAL" && signedQuantity !== 0 ? 35_000 : 0,
        realizedPnlKrw: 0,
      },
    ],
    updatedAt: NOW,
  });
  return accountKey;
}

function seedAcknowledgedOrder(repository: TradingRepository, brokerOrderId: string) {
  const accountKey = seedSelectedContractPosition(repository, 0);
  repository.createDerivativesOrderIntent({
    id: `intent-${brokerOrderId}`,
    orderId: `order-${brokerOrderId}`,
    accountKey,
    idempotencyKey: `key-${brokerOrderId}`,
    clientOrderId: `client-${brokerOrderId}`,
    contractId: "koreainvestment:105V6000",
    action: "OPEN",
    direction: "LONG",
    purpose: "DIRECTIONAL",
    quantity: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  repository.applyDerivativesOrderUpdate({
    accountKey,
    orderId: `order-${brokerOrderId}`,
    status: "ACKED",
    brokerOrderId,
    brokerUpdatedAt: "2026-01-01T00:00:01.000Z",
  });
  return accountKey;
}

function armedHedgeSettings() {
  const settings = createDefaultDerivativesAutomationSettings();
  settings.autoTradingEnabled = true;
  settings.newPositionsPaused = false;
  settings.mode = "HEDGE";
  settings.hedge.enabled = true;
  return settings;
}

describe("derivatives runtime order safety", () => {
  it("does not arm or send an order merely because strategy settings were saved", async () => {
    const adapter = new FakeDerivativeAdapter();
    const { runtime } = createRuntime({ adapter });
    await runtime.start();

    const saved = runtime.updateSettings({
      ...runtime.settings,
      mode: "HEDGE",
      hedge: { ...runtime.settings.hedge, enabled: true },
    });
    await runtime.sync();

    expect(saved.autoTradingEnabled).toBe(false);
    expect(runtime.snapshot().safety).toMatchObject({
      armed: false,
      readyForOrders: false,
    });
    expect(runtime.snapshot().safety.blockers).toContain("선물 자동운용이 꺼져 있습니다.");
    expect(adapter.fetchOrderCapacity).not.toHaveBeenCalled();
    expect(adapter.placeOrder).not.toHaveBeenCalled();
  });

  it("fails closed when market quotes work but order/execution notices are disconnected", async () => {
    const adapter = new FakeDerivativeAdapter({ accountNoticesConnected: false });
    const { runtime } = createRuntime({ adapter, settings: armedHedgeSettings() });

    await runtime.start();
    await runtime.sync();

    const snapshot = runtime.snapshot();
    expect(snapshot.safety.armed).toBe(true);
    expect(snapshot.connection).toMatchObject({
      authenticated: true,
      accountSynchronized: true,
      marketWebSocketConnected: true,
      accountNoticesConnected: false,
    });
    expect(snapshot.safety.blockers).toContain("선물 주문·체결 실시간 연결이 필요합니다.");
    expect(adapter.fetchOrderCapacity).not.toHaveBeenCalled();
    expect(adapter.placeOrder).not.toHaveBeenCalled();
  });

  it("fails closed when a pre-existing contract position has no HEDGE/DIRECTIONAL allocation", async () => {
    const adapter = new FakeDerivativeAdapter({
      account: emptyAccount({
        positions: [{
          symbol: "105V6000",
          name: "미니코스피200 선물",
          direction: "SHORT",
          quantity: 1,
          averagePrice: 350,
          currentPrice: 350,
          evaluationProfitLoss: 0,
          raw: {},
        }],
      }),
    });
    const { runtime } = createRuntime({ adapter, settings: armedHedgeSettings() });

    await runtime.start();
    await runtime.sync();

    const snapshot = runtime.snapshot();
    expect(snapshot.safety.ledgerConsistent).toBe(false);
    expect(snapshot.safety.ledgerBlockReason).toContain("이미 보유한 선물");
    expect(snapshot.safety.readyForOrders).toBe(false);
    expect(adapter.fetchOrderCapacity).not.toHaveBeenCalled();
    expect(adapter.placeOrder).not.toHaveBeenCalled();
  });

  it("blocks every order when the account holds a different, unmanaged futures contract", async () => {
    const adapter = new FakeDerivativeAdapter({
      account: emptyAccount({
        positions: [{
          symbol: "105V7000",
          name: "다른 월물 미니코스피200 선물",
          direction: "LONG",
          quantity: 1,
          averagePrice: 351,
          currentPrice: 352,
          evaluationProfitLoss: 50_000,
          raw: {},
        }],
      }),
    });
    const { runtime } = createRuntime({ adapter, settings: armedHedgeSettings() });

    await runtime.start();
    await runtime.sync();

    const snapshot = runtime.snapshot();
    expect(snapshot.safety.ledgerConsistent).toBe(false);
    expect(snapshot.safety.ledgerBlockReason).toContain("자동운용 월물 외");
    expect(snapshot.safety.ledgerBlockReason).toContain("105V7000");
    expect(adapter.fetchOrderCapacity).not.toHaveBeenCalled();
    expect(adapter.placeOrder).not.toHaveBeenCalled();
  });

  it("applies maxContracts to the resulting broker net position, not just this order quantity", async () => {
    const settings = createDefaultDerivativesAutomationSettings();
    settings.autoTradingEnabled = true;
    settings.newPositionsPaused = false;
    settings.mode = "DIRECTIONAL";
    settings.maxContracts = 2;
    settings.directional = {
      enabled: true,
      sideMode: "BOTH",
      fastPeriod: 3,
      slowPeriod: 5,
      minimumGapBps: 20,
      targetContracts: 3,
    };
    const adapter = new FakeDerivativeAdapter({
      account: emptyAccount({
        positions: [{
          symbol: "105V6000",
          name: "미니코스피200 선물",
          direction: "LONG",
          quantity: 2,
          averagePrice: 350,
          currentPrice: 350,
          evaluationProfitLoss: 0,
          raw: {},
        }],
      }),
    });
    const { runtime } = createRuntime({
      adapter,
      settings,
      prepareRepository: (repository) => { seedSelectedContractPosition(repository, 2); },
    });

    await runtime.start();
    await runtime.sync();

    expect(runtime.snapshot().directional).toMatchObject({
      signal: "LONG",
      currentQuantity: 2,
      targetQuantity: 3,
    });
    expect(runtime.snapshot().safety.blockers).toContain(
      "주문 후 실제 보유량 3계약이 최대 2계약을 넘습니다.",
    );
    expect(adapter.fetchOrderCapacity).not.toHaveBeenCalled();
    expect(adapter.placeOrder).not.toHaveBeenCalled();
  });

  it("cancels a broker-confirmed order after the configured unfilled timeout", async () => {
    const brokerOrder: DerivativeOrder = {
      brokerOrderId: "broker-stale-1",
      symbol: "105V6000",
      side: "BUY",
      requestedQuantity: 1,
      filledQuantity: 0,
      remainingQuantity: 1,
      status: "OPEN",
      session: "DAY",
      orderedAt: "2026-01-01T00:00:00.000Z",
      raw: {},
    };
    const adapter = new FakeDerivativeAdapter({
      account: emptyAccount({ openOrders: [brokerOrder] }),
    });
    let accountKey: ReturnType<typeof seedAcknowledgedOrder>;
    const { runtime, repository } = createRuntime({
      adapter,
      prepareRepository: (target) => { accountKey = seedAcknowledgedOrder(target, brokerOrder.brokerOrderId); },
    });

    await runtime.start();

    expect(adapter.cancelOrder).toHaveBeenCalledOnce();
    expect(adapter.cancelOrder).toHaveBeenCalledWith({
      brokerOrderId: "broker-stale-1",
      session: "DAY",
      cancelAllRemaining: true,
    });
    expect(repository.getDerivativesOrder("order-broker-stale-1", accountKey!)).toMatchObject({
      status: "CANCEL_REQUESTED",
      brokerOrderId: "broker-stale-1",
    });
  });

  it("marks an acknowledged engine order UNKNOWN when it disappears from open orders without a fill", async () => {
    const adapter = new FakeDerivativeAdapter();
    let accountKey: ReturnType<typeof seedAcknowledgedOrder>;
    const { runtime, repository } = createRuntime({
      adapter,
      prepareRepository: (target) => { accountKey = seedAcknowledgedOrder(target, "broker-missing-1"); },
    });

    await runtime.start();

    expect(repository.getDerivativesOrder("order-broker-missing-1", accountKey!)).toMatchObject({
      status: "UNKNOWN",
      brokerOrderId: "broker-missing-1",
    });
    expect(runtime.snapshot().safety.blockers).toContain("엔진에서 처리 중인 선물 주문이 있습니다.");
    expect(adapter.placeOrder).not.toHaveBeenCalled();
  });
});
