import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInMemoryTradingRepository, type TradingRepository } from "@kstock/database";
import {
  createDefaultSettings,
  type AccountSnapshot,
  type AccountScope,
  type AppSettings,
  type BrokerAdapter,
  type BrokerCredentials,
  type BrokerExecution,
  type BrokerEvent,
  type BrokerHealth,
  type BrokerId,
  type BrokerOrder,
  BrokerRejectedError,
  type Quote,
  type TradingEnvironment,
} from "@kstock/shared";
import type { FastifyInstance } from "fastify";
import { createApiServer } from "../src/api/server.js";
import { TradingEngine, type CredentialStorePort } from "../src/core/trading-engine.js";
import { createTokenStore } from "../src/security/credential-store.js";

let engine: TradingEngine | null = null;
let repository: TradingRepository | null = null;
let api: FastifyInstance | null = null;

class MemoryCredentialStore implements CredentialStorePort {
  readonly values = new Map<string, BrokerCredentials>();
  readonly derivativeValues = new Map<TradingEnvironment, BrokerCredentials>();
  environmentManaged = false;

  private key(brokerId: BrokerId, environment: TradingEnvironment): string {
    return `${brokerId}:${environment}`;
  }

  async save(
    brokerId: BrokerId,
    environment: TradingEnvironment,
    credentials: BrokerCredentials,
  ): Promise<void> {
    this.values.set(this.key(brokerId, environment), structuredClone(credentials));
  }

  async get(
    brokerId: BrokerId,
    environment: TradingEnvironment,
  ): Promise<BrokerCredentials | null> {
    return structuredClone(this.values.get(this.key(brokerId, environment)) ?? null);
  }

  async delete(brokerId: BrokerId, environment: TradingEnvironment): Promise<boolean> {
    return this.values.delete(this.key(brokerId, environment));
  }

  async status(brokerId: BrokerId, environment: TradingEnvironment) {
    const credentials = this.values.get(this.key(brokerId, environment));
    if (this.environmentManaged) {
      return {
        configured: true,
        source: "environment" as const,
        maskedAccountId: "****5678",
      };
    }
    return credentials
      ? {
          configured: true,
          source: "encrypted-file" as const,
          maskedAccountId: `****${credentials.accountId.slice(-4)}`,
        }
      : { configured: false, source: null, maskedAccountId: null };
  }

  async saveDerivatives(
    environment: TradingEnvironment,
    credentials: BrokerCredentials,
  ): Promise<void> {
    this.derivativeValues.set(environment, structuredClone(credentials));
  }

  async getDerivatives(environment: TradingEnvironment): Promise<BrokerCredentials | null> {
    return structuredClone(this.derivativeValues.get(environment) ?? null);
  }

  async deleteDerivatives(environment: TradingEnvironment): Promise<boolean> {
    return this.derivativeValues.delete(environment);
  }

  async statusDerivatives(environment: TradingEnvironment) {
    const credentials = this.derivativeValues.get(environment);
    if (this.environmentManaged) {
      return {
        configured: true,
        source: "environment" as const,
        maskedAccountId: "****5678",
        accountProductCode: "03" as const,
      };
    }
    return credentials
      ? {
          configured: true,
          source: "encrypted-file" as const,
          maskedAccountId: `****${credentials.accountId.slice(-4)}`,
          accountProductCode: "03" as const,
        }
      : {
          configured: false,
          source: null,
          maskedAccountId: null,
          accountProductCode: "03" as const,
        };
  }
}

class ConnectedMemoryBrokerAdapter implements BrokerAdapter {
  readonly scope: AccountScope;
  readonly capabilities = {
    supportsLive: true,
    supportsPaper: true,
    supportsAmend: true,
    supportsCancel: true,
    maxQuoteSubscriptions: 100,
    quoteBatchSize: 100,
    queryRequestsPerSecond: 5,
    orderRequestsPerSecond: 5,
    clientOrderIdSupported: true,
  };
  readonly #health: BrokerHealth;
  readonly #listeners = new Set<(event: BrokerEvent) => void>();

  constructor(
    brokerId: BrokerId,
    accountId: string,
    health: Partial<BrokerHealth> = {},
  ) {
    this.scope = { brokerId, environment: "live", accountId };
    this.#health = {
      state: "CONNECTED",
      restConnected: true,
      marketWebSocketConnected: true,
      accountWebSocketConnected: true,
      checkedAt: "2026-09-03T00:00:00.000Z",
      ...health,
    };
  }

  async connect() {}
  async disconnect() {}
  getHealth(): BrokerHealth { return { ...this.#health }; }
  onEvent(listener: (event: BrokerEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
  emit(event: BrokerEvent): void {
    for (const listener of this.#listeners) listener(event);
  }
  async fetchInstruments() { return []; }
  async fetchDailyBars() { return []; }
  async fetchQuote(): Promise<Quote> {
    throw new Error("이 테스트에서는 현재가를 조회하지 않습니다.");
  }
  async fetchQuotes() { return []; }
  async replaceQuoteSubscriptions() {}
  async placeOrder() { return { outcome: "REJECTED" as const }; }
  async amendOrder() { return { outcome: "REJECTED" as const }; }
  async cancelOrder() { return { outcome: "REJECTED" as const }; }
  async fetchAccountSnapshot(): Promise<AccountSnapshot> {
    return {
      scope: this.scope,
      cash: 1_000_000,
      availableCash: 1_000_000,
      totalEvaluation: 1_000_000,
      realizedPnlToday: 0,
      unrealizedPnl: 0,
      positions: [],
      openOrders: [],
      fetchedAt: "2026-09-03T00:00:00.000Z",
    };
  }
  async fetchOpenOrders(): Promise<BrokerOrder[]> { return []; }
  async fetchExecutions(): Promise<BrokerExecution[]> { return []; }
}

async function startConnectedEngine(
  health: Partial<BrokerHealth> = {},
  configureSettings?: (settings: AppSettings) => void,
): Promise<{
  credentialStore: MemoryCredentialStore;
  adapters: Record<BrokerId, ConnectedMemoryBrokerAdapter>;
}> {
  const credentialStore = new MemoryCredentialStore();
  const adapters = {
    kiwoom: new ConnectedMemoryBrokerAdapter("kiwoom", "12345678", health),
    koreainvestment: new ConnectedMemoryBrokerAdapter(
      "koreainvestment",
      "87654321",
      health,
    ),
  };
  repository = createInMemoryTradingRepository();
  const settings = createDefaultSettings();
  settings.brokers.kiwoom.enabled = true;
  settings.brokers.kiwoom.environment = "live";
  configureSettings?.(settings);
  repository.setAppSettings(settings);
  await credentialStore.save("kiwoom", "live", {
    appKey: "stored-test-key",
    appSecret: "stored-test-secret",
    accountId: adapters.kiwoom.scope.accountId,
  });
  await credentialStore.save("koreainvestment", "live", {
    appKey: "stored-kis-test-key",
    appSecret: "stored-kis-test-secret",
    accountId: adapters.koreainvestment.scope.accountId,
    accountProductCode: "01",
    htsId: "test-user",
  });
  engine = new TradingEngine({
    repository,
    dataDirectory: path.join(tmpdir(), `kstock-api-arm-${randomUUID()}`),
    credentialStore,
    brokerAdapterFactory: ({ brokerId }) => adapters[brokerId],
  });
  await engine.start();
  api = await createApiServer(engine, "integration-test-admin-token-32-characters");
  return { credentialStore, adapters };
}

afterEach(async () => {
  if (api) await api.close();
  if (engine) await engine.stop();
  repository?.close();
  api = null;
  engine = null;
  repository = null;
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("trading-engine API integration", () => {
  it("starts fail-closed and serves real persisted state without broker fixtures", async () => {
    repository = createInMemoryTradingRepository();
    engine = new TradingEngine({ repository, dataDirectory: path.join(tmpdir(), "kstock-api-integration") });
    await engine.start();
    const token = "integration-test-admin-token-32-characters";
    api = await createApiServer(engine, token);

    const health = await api.inject({ method: "GET", url: "/health" });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toMatchObject({ ok: true, service: "kstock-trading-engine" });

    const unauthorized = await api.inject({ method: "GET", url: "/api/dashboard" });
    expect(unauthorized.statusCode).toBe(401);

    const dashboard = await api.inject({
      method: "GET",
      url: "/api/dashboard",
      headers: { "x-kstock-admin-token": token },
    });
    expect(dashboard.statusCode).toBe(200);
    expect(dashboard.json()).toMatchObject({
      engine: {
        state: "HALTED",
        emergencyHalt: true,
        globalAutoTradingEnabled: false,
      },
      market: { universeCount: 0, candidatesCount: 0 },
      today: { orders: 0, buys: 0, sells: 0 },
      candidates: [],
      positions: [],
      orders: [],
      executions: [],
    });

    const settings = await api.inject({
      method: "GET",
      url: "/api/settings",
      headers: { "x-kstock-admin-token": token },
    });
    expect(settings.statusCode).toBe(200);
    expect(settings.json().settings.brokers.kiwoom.enabled).toBe(false);
    expect(settings.json().settings.brokers.koreainvestment.enabled).toBe(false);

    const resumeWithoutBroker = await api.inject({
      method: "POST",
      url: "/api/control",
      headers: {
        "x-kstock-admin-token": token,
        "content-type": "application/json",
      },
      payload: { action: "resume-global" },
    });
    expect(resumeWithoutBroker.statusCode).toBe(409);
    expect(resumeWithoutBroker.json().message).toContain("연결 사용");

    const resumeBuysWhileHalted = await api.inject({
      method: "POST",
      url: "/api/control",
      headers: {
        "x-kstock-admin-token": token,
        "content-type": "application/json",
      },
      payload: { action: "resume-new-buys" },
    });
    expect(resumeBuysWhileHalted.statusCode).toBe(409);
    expect(resumeBuysWhileHalted.json().message).toContain("전체 안전 정지");

    const startWithoutBroker = await api.inject({
      method: "POST",
      url: "/api/control",
      headers: {
        "x-kstock-admin-token": token,
        "content-type": "application/json",
      },
      payload: { action: "start-broker" },
    });
    expect(startWithoutBroker.statusCode).toBe(409);
    expect(startWithoutBroker.json().message).toBe("자동매매를 시작할 증권사를 지정해 주세요.");
  }, 10_000);

  it("arms one broker before market-status confirmation while preserving final order gates", async () => {
    await startConnectedEngine({}, (settings) => {
      settings.brokers.koreainvestment.enabled = true;
      settings.brokers.koreainvestment.environment = "live";
      // Simulate stale per-broker flags left from a previous run while the
      // global emergency gate is currently closed.
      settings.brokers.koreainvestment.autoTradingEnabled = true;
      settings.brokers.koreainvestment.newBuysPaused = false;
    });
    const headers = {
      "x-kstock-admin-token": "integration-test-admin-token-32-characters",
      "content-type": "application/json",
    };

    const before = await api!.inject({
      method: "GET",
      url: "/api/settings",
      headers,
    });
    const staleSettings = before.json().settings;
    const beforeConnection = before.json().connections.kiwoom;
    expect(beforeConnection).toMatchObject({
      brokerAuthenticated: true,
      accountSynchronized: true,
      marketWebSocketConnected: true,
      accountWebSocketConnected: true,
      marketStatusConfirmed: false,
      readyForOrders: false,
    });
    expect(beforeConnection.stage).toBe(
      beforeConnection.orderWindowOpen ? "WAITING_MARKET_STATUS" : "READY",
    );

    const started = await api!.inject({
      method: "POST",
      url: "/api/control",
      headers,
      payload: { action: "start-broker", brokerId: "kiwoom" },
    });
    expect(started.statusCode).toBe(200);
    expect(started.json()).toEqual({ ok: true });

    const armed = await api!.inject({
      method: "GET",
      url: "/api/settings",
      headers,
    });
    const armedPayload = armed.json();
    expect(armedPayload).toMatchObject({
      settings: {
        emergencyHalt: false,
        globalAutoTradingEnabled: true,
        newBuysPaused: false,
        brokers: {
          kiwoom: { autoTradingEnabled: true, newBuysPaused: false },
          // Opening global gates for Kiwoom must not revive stale flags on KIS.
          koreainvestment: { autoTradingEnabled: false, newBuysPaused: true },
        },
      },
      connections: {
        kiwoom: {
          marketStatusConfirmed: false,
          readyForOrders: false,
        },
      },
    });
    expect(armedPayload.connections.kiwoom.stage).toBe(
      armedPayload.connections.kiwoom.orderWindowOpen
        ? "WAITING_MARKET_STATUS"
        : "READY",
    );
    expect(repository!.getAppSettings()).toMatchObject({
      emergencyHalt: false,
      globalAutoTradingEnabled: true,
      newBuysPaused: false,
      brokers: {
        kiwoom: { autoTradingEnabled: true, newBuysPaused: false },
        koreainvestment: { autoTradingEnabled: false, newBuysPaused: true },
      },
    });
    expect(
      repository!.listAuditLog({ limit: 20 }).find(
        (row) => row.action === "CONTROL_START_BROKER",
      ),
    ).toMatchObject({
      scope: { brokerId: "kiwoom", environment: "live" },
      payload: { brokerId: "kiwoom", marketStatusConfirmed: false },
    });

    const savedFromStaleTab = await api!.inject({
      method: "PUT",
      url: "/api/settings",
      headers,
      payload: { ...staleSettings, scanIntervalMs: 6_000 },
    });
    expect(savedFromStaleTab.statusCode).toBe(200);
    expect(engine!.settings).toMatchObject({
      emergencyHalt: false,
      globalAutoTradingEnabled: true,
      newBuysPaused: false,
      scanIntervalMs: 6_000,
      brokers: {
        kiwoom: { autoTradingEnabled: true, newBuysPaused: false },
      },
    });

    await api!.inject({
      method: "POST",
      url: "/api/control",
      headers,
      payload: { action: "halt-all" },
    });
    const resumedBeforeOpen = await api!.inject({
      method: "POST",
      url: "/api/control",
      headers,
      payload: { action: "resume-global" },
    });
    expect(resumedBeforeOpen.statusCode).toBe(200);
    expect(engine!.settings).toMatchObject({
      emergencyHalt: false,
      globalAutoTradingEnabled: true,
      newBuysPaused: false,
    });
  });

  it("preserves other broker flags when all global gates were already open", async () => {
    await startConnectedEngine({}, (settings) => {
      settings.emergencyHalt = false;
      settings.globalAutoTradingEnabled = true;
      settings.newBuysPaused = false;
      settings.brokers.koreainvestment.enabled = true;
      settings.brokers.koreainvestment.environment = "live";
      settings.brokers.koreainvestment.autoTradingEnabled = true;
      settings.brokers.koreainvestment.newBuysPaused = false;
    });

    const response = await api!.inject({
      method: "POST",
      url: "/api/control",
      headers: {
        "x-kstock-admin-token": "integration-test-admin-token-32-characters",
        "content-type": "application/json",
      },
      payload: { action: "start-broker", brokerId: "kiwoom" },
    });

    expect(response.statusCode).toBe(200);
    expect(engine!.settings.brokers.koreainvestment).toMatchObject({
      autoTradingEnabled: true,
      newBuysPaused: false,
    });
  });

  it("keeps a once-armed account running after an engine restart when automatic recovery is enabled", async () => {
    const { credentialStore, adapters } = await startConnectedEngine({}, (settings) => {
      settings.brokers.kiwoom.resumeAfterRestart = true;
    });
    const headers = {
      "x-kstock-admin-token": "integration-test-admin-token-32-characters",
      "content-type": "application/json",
    };
    const started = await api!.inject({
      method: "POST",
      url: "/api/control",
      headers,
      payload: { action: "start-broker", brokerId: "kiwoom" },
    });
    expect(started.statusCode).toBe(200);

    await api!.close();
    api = null;
    await engine!.stop();
    engine = new TradingEngine({
      repository: repository!,
      dataDirectory: path.join(tmpdir(), `kstock-api-restart-${randomUUID()}`),
      credentialStore,
      brokerAdapterFactory: ({ brokerId }) => adapters[brokerId],
    });
    await engine.start();
    api = await createApiServer(engine, "integration-test-admin-token-32-characters");

    expect(engine.settings).toMatchObject({
      emergencyHalt: false,
      globalAutoTradingEnabled: true,
      newBuysPaused: false,
      brokers: {
        kiwoom: {
          autoTradingEnabled: true,
          newBuysPaused: false,
          resumeAfterRestart: true,
        },
      },
    });
    expect(
      repository!.listAuditLog({ limit: 100 }).filter(
        (row) => row.action === "CONTROL_START_BROKER",
      ),
    ).toHaveLength(1);
  }, 10_000);

  it("keeps other brokers sell-enabled but buy-paused when only the global buy gate was closed", async () => {
    await startConnectedEngine({}, (settings) => {
      settings.emergencyHalt = false;
      settings.globalAutoTradingEnabled = true;
      settings.newBuysPaused = true;
      settings.brokers.koreainvestment.enabled = true;
      settings.brokers.koreainvestment.environment = "live";
      settings.brokers.koreainvestment.autoTradingEnabled = true;
      settings.brokers.koreainvestment.newBuysPaused = false;
    });

    const response = await api!.inject({
      method: "POST",
      url: "/api/control",
      headers: {
        "x-kstock-admin-token": "integration-test-admin-token-32-characters",
        "content-type": "application/json",
      },
      payload: { action: "start-broker", brokerId: "kiwoom" },
    });

    expect(response.statusCode).toBe(200);
    expect(engine!.settings).toMatchObject({
      newBuysPaused: false,
      brokers: {
        kiwoom: { autoTradingEnabled: true, newBuysPaused: false },
        koreainvestment: { autoTradingEnabled: true, newBuysPaused: true },
      },
    });
  });

  it("refuses to arm when the order and execution stream is not connected", async () => {
    await startConnectedEngine({ accountWebSocketConnected: false });

    const response = await api!.inject({
      method: "POST",
      url: "/api/control",
      headers: {
        "x-kstock-admin-token": "integration-test-admin-token-32-characters",
        "content-type": "application/json",
      },
      payload: { action: "start-broker", brokerId: "kiwoom" },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().message).toContain("주문·체결 실시간 연결");
    const resumeGlobal = await api!.inject({
      method: "POST",
      url: "/api/control",
      headers: {
        "x-kstock-admin-token": "integration-test-admin-token-32-characters",
        "content-type": "application/json",
      },
      payload: { action: "resume-global" },
    });
    expect(resumeGlobal.statusCode).toBe(409);
    expect(resumeGlobal.json().message).toContain("주문·체결 실시간 연결");
    expect(engine!.settings).toMatchObject({
      emergencyHalt: true,
      globalAutoTradingEnabled: false,
      brokers: {
        kiwoom: { autoTradingEnabled: false, newBuysPaused: true },
      },
    });
    expect(
      repository!.listAuditLog({ limit: 20 }).some(
        (row) => row.action === "CONTROL_START_BROKER",
      ),
    ).toBe(false);
  });

  it("refuses to arm while a previous order result remains unknown", async () => {
    const { adapters } = await startConnectedEngine();
    repository!.upsertReconciledOrder({
      scope: adapters.kiwoom.scope,
      brokerOrder: {
        brokerOrderId: "unknown-order-1",
        symbol: "005930",
        side: "buy",
        orderType: "market",
        orderedQuantity: 1,
        filledQuantity: 0,
        remainingQuantity: 1,
        status: "UNKNOWN",
        orderedAt: "2026-09-03T00:00:00.000Z",
      },
    });

    const response = await api!.inject({
      method: "POST",
      url: "/api/control",
      headers: {
        "x-kstock-admin-token": "integration-test-admin-token-32-characters",
        "content-type": "application/json",
      },
      payload: { action: "start-broker", brokerId: "kiwoom" },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().message).toContain("결과를 확인해야 하는 이전 주문");
    expect(engine!.settings.emergencyHalt).toBe(true);
  });

  it("allows arming when an audited UNKNOWN execution has no remaining quantity", async () => {
    const { adapters } = await startConnectedEngine();
    repository!.upsertReconciledOrder({
      scope: adapters.kiwoom.scope,
      brokerOrder: {
        brokerOrderId: "historical-unknown-zero-remainder",
        symbol: "005930",
        side: "buy",
        orderType: "market",
        orderedQuantity: 2,
        filledQuantity: 2,
        remainingQuantity: 0,
        status: "UNKNOWN",
        orderedAt: "2026-09-03T00:00:00.000Z",
      },
    });

    const response = await api!.inject({
      method: "POST",
      url: "/api/control",
      headers: {
        "x-kstock-admin-token": "integration-test-admin-token-32-characters",
        "content-type": "application/json",
      },
      payload: { action: "start-broker", brokerId: "kiwoom" },
    });

    expect(response.statusCode).toBe(200);
    expect(engine!.settings.brokers.kiwoom.autoTradingEnabled).toBe(true);
  });

  it("does not mark the account unsynchronized for a replayed execution notification", async () => {
    const { adapters } = await startConnectedEngine();
    const execution: BrokerExecution = {
      executionId: "2026-09-03:replayed-fill",
      brokerOrderId: "historical-replayed-order",
      symbol: "005930",
      side: "buy",
      quantity: 2,
      price: 70_000,
      executedAt: "2026-09-03T00:01:00.000Z",
    };
    expect(repository!.recordExecution({
      scope: adapters.kiwoom.scope,
      execution,
    }).inserted).toBe(true);

    // Kiwoom may replay an already-durable fill after account subscription.
    adapters.kiwoom.emit({ type: "execution", execution });

    const response = await api!.inject({
      method: "GET",
      url: "/api/settings",
      headers: {
        "x-kstock-admin-token": "integration-test-admin-token-32-characters",
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().connections.kiwoom).toMatchObject({
      accountSynchronized: true,
      stage: expect.not.stringMatching(/ACCOUNT_SYNCING/),
    });
  });

  it("validates, stores and deletes credentials without ever returning secrets", async () => {
    const credentialStore = new MemoryCredentialStore();
    repository = createInMemoryTradingRepository();
    engine = new TradingEngine({
      repository,
      dataDirectory: path.join(tmpdir(), `kstock-api-credentials-${randomUUID()}`),
      credentialStore,
    });
    await engine.start();
    const token = "integration-test-admin-token-32-characters";
    api = await createApiServer(engine, token);
    const headers = {
      "x-kstock-admin-token": token,
      "content-type": "application/json",
    };

    const invalid = await api.inject({
      method: "POST",
      url: "/api/credentials/koreainvestment/paper",
      headers,
      payload: {
        appKey: "invalid-key",
        appSecret: "must-never-be-returned",
        accountId: "12345678",
        connectNow: false,
      },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.body).not.toContain("must-never-be-returned");
    expect(credentialStore.values.size).toBe(0);

    const invalidKiwoomAccount = await api.inject({
      method: "POST",
      url: "/api/credentials/kiwoom/live",
      headers,
      payload: {
        appKey: "kiwoom-key-that-must-stay-secret",
        appSecret: "kiwoom-secret-that-must-stay-secret",
        accountId: "123456789",
        connectNow: false,
      },
    });
    expect(invalidKiwoomAccount.statusCode).toBe(400);
    expect(invalidKiwoomAccount.body).not.toContain("kiwoom-key-that-must-stay-secret");
    expect(invalidKiwoomAccount.body).not.toContain("kiwoom-secret-that-must-stay-secret");
    expect(credentialStore.values.size).toBe(0);

    const saved = await api.inject({
      method: "POST",
      url: "/api/credentials/kiwoom/paper",
      headers,
      payload: {
        appKey: "kiwoom-key-that-must-stay-secret",
        appSecret: "kiwoom-secret-that-must-stay-secret",
        accountId: "12345678",
        connectNow: false,
      },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.body).not.toContain("kiwoom-key-that-must-stay-secret");
    expect(saved.body).not.toContain("kiwoom-secret-that-must-stay-secret");
    expect(saved.body).not.toContain('"accountId":"12345678"');
    expect(saved.json()).toMatchObject({
      ok: true,
      connected: false,
      connection: {
        stage: "DISABLED",
        credentialsStored: true,
        brokerAuthenticated: false,
        accountSynchronized: false,
        marketStatusConfirmed: false,
        readyForOrders: false,
      },
      settings: {
        emergencyHalt: true,
        globalAutoTradingEnabled: false,
        brokers: {
          kiwoom: {
            enabled: false,
            autoTradingEnabled: false,
            newBuysPaused: true,
          },
        },
      },
      credentials: {
        kiwoom: {
          paper: {
            configured: true,
            source: "encrypted-file",
            maskedAccountId: "****5678",
          },
        },
      },
    });

    const removed = await api.inject({
      method: "DELETE",
      url: "/api/credentials/kiwoom/paper",
      headers: { "x-kstock-admin-token": token },
    });
    expect(removed.statusCode).toBe(200);
    expect(removed.json()).toMatchObject({
      ok: true,
      deleted: true,
      credentials: { kiwoom: { paper: { configured: false } } },
    });
    expect(credentialStore.values.size).toBe(0);
  });

  it("keeps the KIS derivatives account separate while safely reusing cash API credentials", async () => {
    vi.stubEnv("KSTOCK_MASTER_KEY", "integration-test-master-key-32-characters-long");
    const credentialStore = new MemoryCredentialStore();
    await credentialStore.save("koreainvestment", "live", {
      appKey: "shared-live-kis-key-never-return",
      appSecret: "shared-live-kis-secret-never-return",
      accountId: "11112222",
      accountProductCode: "01",
      htsId: "cash-operator",
    });
    const verifiedCredentials: BrokerCredentials[] = [];
    repository = createInMemoryTradingRepository();
    engine = new TradingEngine({
      repository,
      dataDirectory: path.join(tmpdir(), `kstock-api-derivatives-${randomUUID()}`),
      credentialStore,
      derivativeAdapterFactory: ({ credentials }) => {
        verifiedCredentials.push(structuredClone(credentials));
        return {
          async fetchAccountSnapshot(session) {
            return {
              session,
              accountId: "87654321-03",
              accountProductCode: "03",
              currency: "KRW",
              positions: [{
                symbol: "101V9000",
                direction: "LONG",
                quantity: 1,
                averagePrice: 400,
                raw: {},
              }],
              openOrders: [],
              observedAt: "2026-09-03T01:02:03.000Z",
              rawSummary: {},
              unavailableFields: ["maintenanceMargin"],
            };
          },
        };
      },
    });
    await engine.start();
    const token = "integration-test-admin-token-32-characters";
    api = await createApiServer(engine, token);
    const headers = {
      "x-kstock-admin-token": token,
      "content-type": "application/json",
    };

    const before = await api.inject({
      method: "GET",
      url: "/api/derivatives/credentials/koreainvestment/live",
      headers,
    });
    expect(before.statusCode).toBe(200);
    expect(before.json()).toMatchObject({
      market: "DERIVATIVES",
      credentials: { configured: false, accountProductCode: "03" },
      connection: { state: "NOT_CHECKED", authenticated: false, accountSynchronized: false },
    });

    const invalidProduct = await api.inject({
      method: "POST",
      url: "/api/derivatives/credentials/koreainvestment/live",
      headers,
      payload: {
        reuseCashCredentials: true,
        accountId: "87654321",
        accountProductCode: "01",
        appSecret: "invalid-secret-never-return",
        connectNow: false,
      },
    });
    expect(invalidProduct.statusCode).toBe(400);
    expect(invalidProduct.body).not.toContain("invalid-secret-never-return");

    const saved = await api.inject({
      method: "POST",
      url: "/api/derivatives/credentials/koreainvestment/live",
      headers,
      payload: {
        reuseCashCredentials: true,
        accountId: "87654321-03",
        accountProductCode: "03",
        connectNow: true,
      },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.body).not.toContain("shared-live-kis-key-never-return");
    expect(saved.body).not.toContain("shared-live-kis-secret-never-return");
    expect(saved.body).not.toContain('"accountId":"87654321"');
    expect(saved.json()).toMatchObject({
      ok: true,
      connected: true,
      brokerId: "koreainvestment",
      market: "DERIVATIVES",
      environment: "live",
      credentials: {
        configured: true,
        source: "encrypted-file",
        maskedAccountId: "****4321",
        accountProductCode: "03",
      },
      connection: {
        state: "VERIFIED",
        authenticated: true,
        accountSynchronized: true,
      },
      account: {
        maskedAccountId: "****4321",
        accountProductCode: "03",
        positionCount: 1,
        openOrderCount: 0,
        observedAt: "2026-09-03T01:02:03.000Z",
        unavailableFields: ["maintenanceMargin"],
      },
    });
    expect(verifiedCredentials).toEqual([{
      appKey: "shared-live-kis-key-never-return",
      appSecret: "shared-live-kis-secret-never-return",
      accountId: "87654321",
      accountProductCode: "03",
      htsId: "cash-operator",
    }]);
    expect(await credentialStore.get("koreainvestment", "live")).toMatchObject({
      accountId: "11112222",
      accountProductCode: "01",
    });
    expect(engine.settings.brokers.koreainvestment.enabled).toBe(false);

    const status = await api.inject({
      method: "GET",
      url: "/api/derivatives/credentials/koreainvestment/live",
      headers,
    });
    expect(status.json().connection.state).toBe("VERIFIED");
    expect(status.json().account).toMatchObject({
      maskedAccountId: "****4321",
      accountProductCode: "03",
      positionCount: 1,
      openOrderCount: 0,
    });

    const reverified = await api.inject({
      method: "POST",
      url: "/api/derivatives/credentials/koreainvestment/live/verify",
      headers: { "x-kstock-admin-token": token },
    });
    expect(reverified.statusCode).toBe(200);
    expect(reverified.json()).toMatchObject({
      connected: true,
      connection: { state: "VERIFIED" },
      account: { maskedAccountId: "****4321", positionCount: 1, openOrderCount: 0 },
    });

    const removed = await api.inject({
      method: "DELETE",
      url: "/api/derivatives/credentials/koreainvestment/live",
      headers: { "x-kstock-admin-token": token },
    });
    expect(removed.statusCode).toBe(200);
    expect(removed.json()).toMatchObject({
      ok: true,
      deleted: true,
      credentials: { configured: false, accountProductCode: "03" },
      connection: { state: "NOT_CHECKED" },
    });
    expect(await credentialStore.get("koreainvestment", "live")).not.toBeNull();
  });

  it("explains a broker-rejected derivatives account number in Korean", async () => {
    const credentialStore = new MemoryCredentialStore();
    await credentialStore.save("koreainvestment", "live", {
      appKey: "shared-live-kis-key-never-return",
      appSecret: "shared-live-kis-secret-never-return",
      accountId: "11112222",
      accountProductCode: "01",
    });
    repository = createInMemoryTradingRepository();
    engine = new TradingEngine({
      repository,
      dataDirectory: path.join(tmpdir(), `kstock-api-derivatives-rejection-${randomUUID()}`),
      credentialStore,
      derivativeAdapterFactory: () => ({
        async fetchAccountSnapshot() {
          throw new BrokerRejectedError(
            "ERROR : INPUT INVALID_CHECK_ACNO",
            "OPSQ2000",
            { msg_cd: "OPSQ2000" },
          );
        },
      }),
    });
    await engine.start();
    const token = "integration-test-admin-token-32-characters";
    api = await createApiServer(engine, token);

    const response = await api.inject({
      method: "POST",
      url: "/api/derivatives/credentials/koreainvestment/live",
      headers: {
        "x-kstock-admin-token": token,
        "content-type": "application/json",
      },
      payload: {
        reuseCashCredentials: true,
        accountId: "87654321",
        accountProductCode: "03",
        connectNow: true,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      connected: false,
      connection: {
        state: "FAILED",
        authenticated: true,
        accountSynchronized: false,
        message: expect.stringContaining("추가신청하기"),
      },
    });
    expect(response.json().connection.message).toContain("계좌 비밀번호는 필요하지 않습니다");
    const recordedError = repository!.listErrors({ limit: 10 })[0];
    expect(recordedError?.code).toBe("OPSQ2000");
    expect(recordedError?.details).toMatchObject({
      name: "BrokerRejectedError",
      brokerCode: "OPSQ2000",
      brokerDetails: { msg_cd: "OPSQ2000" },
    });
    expect(response.body).not.toContain("shared-live-kis-key-never-return");
    expect(response.body).not.toContain("shared-live-kis-secret-never-return");
  });

  it("clears a stale derivative token when the account API key changes", async () => {
    vi.stubEnv("KSTOCK_MASTER_KEY", "integration-test-master-key-32-characters-long");
    const credentialStore = new MemoryCredentialStore();
    await credentialStore.saveDerivatives("live", {
      appKey: "old-key-never-return",
      appSecret: "old-secret-never-return",
      accountId: "87654321",
      accountProductCode: "03",
      htsId: "operator",
    });
    const dataDirectory = path.join(tmpdir(), `kstock-derivative-token-${randomUUID()}`);
    const scope: AccountScope = {
      brokerId: "koreainvestment",
      environment: "live",
      accountId: "87654321-03",
    };
    await createTokenStore(dataDirectory).set(scope, {
      token: "stale-token-never-return",
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    let cachedTokenSeenByVerifier = "not-checked";
    repository = createInMemoryTradingRepository();
    engine = new TradingEngine({
      repository,
      dataDirectory,
      credentialStore,
      derivativeAdapterFactory: ({ tokenStore }) => ({
        async fetchAccountSnapshot(session) {
          cachedTokenSeenByVerifier = (await tokenStore.get(scope))?.token ?? "cleared";
          return {
            session,
            accountId: scope.accountId,
            accountProductCode: "03",
            currency: "KRW",
            positions: [],
            openOrders: [],
            observedAt: "2026-09-06T00:00:00.000Z",
            rawSummary: {},
            unavailableFields: [],
          };
        },
      }),
    });
    await engine.start();
    const token = "integration-test-admin-token-32-characters";
    api = await createApiServer(engine, token);

    const response = await api.inject({
      method: "POST",
      url: "/api/derivatives/credentials/koreainvestment/live",
      headers: {
        "x-kstock-admin-token": token,
        "content-type": "application/json",
      },
      payload: {
        appKey: "new-key-never-return",
        appSecret: "new-secret-never-return",
        reuseCashCredentials: false,
        accountId: "87654321",
        accountProductCode: "03",
        htsId: "operator",
        connectNow: true,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().connection.state).toBe("VERIFIED");
    expect(cachedTokenSeenByVerifier).toBe("cleared");
    expect(response.body).not.toContain("stale-token-never-return");
    expect(response.body).not.toContain("new-key-never-return");
    expect(response.body).not.toContain("new-secret-never-return");
  });

  it("allows explicit KIS derivatives API credentials without changing cash credentials", async () => {
    const credentialStore = new MemoryCredentialStore();
    repository = createInMemoryTradingRepository();
    engine = new TradingEngine({
      repository,
      dataDirectory: path.join(tmpdir(), `kstock-api-derivatives-explicit-${randomUUID()}`),
      credentialStore,
    });
    await engine.start();
    const token = "integration-test-admin-token-32-characters";
    api = await createApiServer(engine, token);
    const response = await api.inject({
      method: "POST",
      url: "/api/derivatives/credentials/koreainvestment/paper",
      headers: {
        "x-kstock-admin-token": token,
        "content-type": "application/json",
      },
      payload: {
        appKey: "derivative-only-key-never-return",
        appSecret: "derivative-only-secret-never-return",
        reuseCashCredentials: false,
        accountId: "12345678",
        accountProductCode: "03",
        htsId: "derivatives-user",
        connectNow: false,
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain("derivative-only-key-never-return");
    expect(response.body).not.toContain("derivative-only-secret-never-return");
    expect(response.json()).toMatchObject({
      connected: false,
      credentials: { configured: true, maskedAccountId: "****5678" },
      connection: { state: "NOT_CHECKED" },
    });
    expect(credentialStore.values.size).toBe(0);
    expect(await credentialStore.getDerivatives("paper")).toMatchObject({
      accountId: "12345678",
      accountProductCode: "03",
    });
  });

  it("connects fail-closed and reports a rejected broker authentication without leaking input", async () => {
    vi.stubEnv("KSTOCK_MASTER_KEY", "integration-test-master-key-32-characters-long");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ return_code: 1, return_msg: "authentication denied" }),
      { status: 401, headers: { "content-type": "application/json" } },
    )));
    const credentialStore = new MemoryCredentialStore();
    repository = createInMemoryTradingRepository();
    engine = new TradingEngine({
      repository,
      dataDirectory: path.join(tmpdir(), `kstock-api-connect-${randomUUID()}`),
      credentialStore,
    });
    await engine.start();
    const token = "integration-test-admin-token-32-characters";
    api = await createApiServer(engine, token);

    const response = await api.inject({
      method: "POST",
      url: "/api/credentials/kiwoom/paper",
      headers: {
        "x-kstock-admin-token": token,
        "content-type": "application/json",
      },
      payload: {
        appKey: "rejected-key-never-return-this",
        appSecret: "rejected-secret-never-return-this",
        accountId: "87654321",
        connectNow: true,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain("rejected-key-never-return-this");
    expect(response.body).not.toContain("rejected-secret-never-return-this");
    expect(response.body).not.toContain('"accountId":"87654321"');
    expect(response.json()).toMatchObject({
      ok: true,
      connected: false,
      connectionState: "ERROR",
      connection: {
        stage: "ERROR",
        credentialsStored: true,
        brokerAuthenticated: false,
        accountSynchronized: false,
        marketStatusConfirmed: false,
        readyForOrders: false,
      },
      settings: {
        emergencyHalt: true,
        globalAutoTradingEnabled: false,
        brokers: {
          kiwoom: {
            enabled: true,
            environment: "paper",
            autoTradingEnabled: false,
            newBuysPaused: true,
          },
        },
      },
    });
  });

  it("refuses to mutate environment-managed credentials", async () => {
    const credentialStore = new MemoryCredentialStore();
    credentialStore.environmentManaged = true;
    repository = createInMemoryTradingRepository();
    engine = new TradingEngine({
      repository,
      dataDirectory: path.join(tmpdir(), `kstock-api-env-credentials-${randomUUID()}`),
      credentialStore,
    });
    await engine.start();
    const token = "integration-test-admin-token-32-characters";
    api = await createApiServer(engine, token);

    const removed = await api.inject({
      method: "DELETE",
      url: "/api/credentials/kiwoom/live",
      headers: { "x-kstock-admin-token": token },
    });
    expect(removed.statusCode).toBe(409);
    expect(removed.json()).toMatchObject({ error: "request_failed" });

    const overwritten = await api.inject({
      method: "POST",
      url: "/api/credentials/kiwoom/live",
      headers: {
        "x-kstock-admin-token": token,
        "content-type": "application/json",
      },
      payload: {
        appKey: "new-key-never-return-this",
        appSecret: "new-secret-never-return-this",
        accountId: "12345678",
        connectNow: false,
      },
    });
    expect(overwritten.statusCode).toBe(409);
    expect(overwritten.body).not.toContain("new-key-never-return-this");
    expect(overwritten.body).not.toContain("new-secret-never-return-this");
  });
});
