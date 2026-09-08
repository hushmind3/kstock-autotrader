import { describe, expect, it, vi } from "vitest";
import { createInMemoryTradingRepository } from "@kstock/database";
import {
  MarketRegimeSettingsSchema,
  koreanTradingDate,
  type AccountSnapshot,
  type BrokerAdapter,
  type BrokerExecution,
  type BrokerOrder,
  type DailyBar,
  type Instrument,
  type Quote,
} from "@kstock/shared";
import {
  MarketDataService,
  previousWeekdayDate,
} from "../src/services/market-data-service.js";

const scope = { brokerId: "kiwoom", environment: "live", accountId: "12345678" } as const;
const instrument: Instrument = {
  symbol: "0234N0",
  name: "신규 상장 종목",
  market: "KOSPI",
  exchange: "KRX",
  active: true,
};
const shortHistory: DailyBar[] = ["2000-01-03", "2000-01-04"].map((tradingDate) => ({
  symbol: instrument.symbol,
  tradingDate,
  open: 10_000,
  high: 10_100,
  low: 9_900,
  close: 10_000,
  volume: 100_000,
  adjusted: true,
}));

function recentCompletedHistory(symbol: string, count: number): DailyBar[] {
  const latest = previousWeekdayDate(koreanTradingDate());
  const latestTimestamp = Date.parse(`${latest}T00:00:00.000Z`);
  return Array.from({ length: count }, (_, index) => ({
    symbol,
    tradingDate: new Date(latestTimestamp - (count - 1 - index) * 86_400_000)
      .toISOString()
      .slice(0, 10),
    open: 10_000,
    high: 10_100,
    low: 9_900,
    close: 10_000 + index,
    volume: 100_000,
    adjusted: true,
  }));
}

function fakeAdapter(): BrokerAdapter {
  return {
    scope,
    capabilities: {
      supportsLive: true,
      supportsPaper: true,
      supportsAmend: true,
      supportsCancel: true,
      maxQuoteSubscriptions: 100,
      quoteBatchSize: 100,
      queryRequestsPerSecond: 5,
      orderRequestsPerSecond: 5,
      clientOrderIdSupported: true,
    },
    async connect() {},
    async disconnect() {},
    getHealth: () => ({
      state: "CONNECTED",
      restConnected: true,
      marketWebSocketConnected: true,
      accountWebSocketConnected: true,
      checkedAt: new Date().toISOString(),
    }),
    onEvent: () => () => {},
    fetchInstruments: async () => [instrument],
    fetchDailyBars: async () => shortHistory,
    fetchQuote: async (): Promise<Quote> => ({
      symbol: instrument.symbol,
      price: 10_000,
      cumulativeVolume: 100_000,
      tradingDate: koreanTradingDate(),
      tradingTime: "090000",
      receivedAt: new Date().toISOString(),
      source: "kiwoom",
      exchange: "KRX",
    }),
    fetchQuotes: async () => [],
    async replaceQuoteSubscriptions() {},
    placeOrder: async () => ({ outcome: "REJECTED" }),
    amendOrder: async () => ({ outcome: "REJECTED" }),
    cancelOrder: async () => ({ outcome: "REJECTED" }),
    fetchAccountSnapshot: async (): Promise<AccountSnapshot> => ({
      scope,
      cash: 0,
      availableCash: 0,
      totalEvaluation: 0,
      realizedPnlToday: 0,
      unrealizedPnl: 0,
      positions: [],
      openOrders: [],
      fetchedAt: new Date().toISOString(),
    }),
    fetchOpenOrders: async (): Promise<BrokerOrder[]> => [],
    fetchExecutions: async (): Promise<BrokerExecution[]> => [],
  };
}

describe("MarketDataService", () => {
  it("recognizes the preceding completed weekday across weekends", () => {
    expect(previousWeekdayDate("2026-09-07")).toBe("2026-09-04");
    expect(previousWeekdayDate("2026-09-06")).toBe("2026-09-04");
    expect(previousWeekdayDate("2026-09-05")).toBe("2026-09-04");
    expect(previousWeekdayDate("2026-09-04")).toBe("2026-09-03");
  });

  it("restores ready daily bars from the database without refetching unchanged weekend data", async () => {
    const repository = createInMemoryTradingRepository();
    const adapter = fakeAdapter();
    const tradingDate = koreanTradingDate();
    const expectedLatest = previousWeekdayDate(tradingDate);
    const latestTimestamp = Date.parse(`${expectedLatest}T00:00:00.000Z`);
    const completedHistory: DailyBar[] = Array.from({ length: 63 }, (_, index) => ({
      symbol: instrument.symbol,
      tradingDate: new Date(latestTimestamp - (62 - index) * 86_400_000).toISOString().slice(0, 10),
      open: 10_000,
      high: 10_100,
      low: 9_900,
      close: 10_000 + index,
      volume: 100_000,
      adjusted: true,
    }));
    repository.upsertInstruments([instrument]);
    repository.upsertDailyBars(completedHistory, "kiwoom");
    repository.setRuntimeState(null, "daily-bar-backfill:kiwoom", "1999-01-01");
    const fetchDailyBars = vi.fn(adapter.fetchDailyBars);
    adapter.fetchDailyBars = fetchDailyBars;
    const service = new MarketDataService(repository, {
      getRuntimes: () => [{ adapter, requiredDailyBars: 63 }],
      getQuoteSweepIntervalMs: () => 60_000,
      getPrioritySymbols: () => [],
      isMarketOpen: () => false,
      onQuote: async () => {},
      onStoredQuote: async () => {},
      onError: vi.fn(),
    });

    try {
      await service.start();
      await vi.waitFor(() => expect(service.metrics.backfillCompleted).toBe(1));
      expect(fetchDailyBars).not.toHaveBeenCalled();
      expect(service.isDailyBarsReady(instrument.symbol)).toBe(true);
      expect(repository.getRuntimeState(null, "daily-bar-backfill:kiwoom")).toBe(tradingDate);
    } finally {
      await service.stop();
      repository.close();
    }
  });

  it("skips a newly listed instrument with insufficient history without recording an error", async () => {
    const repository = createInMemoryTradingRepository();
    const adapter = fakeAdapter();
    const onError = vi.fn();
    const service = new MarketDataService(repository, {
      getRuntimes: () => [{ adapter, requiredDailyBars: 63 }],
      getQuoteSweepIntervalMs: () => 60_000,
      getPrioritySymbols: () => [],
      isMarketOpen: () => false,
      onQuote: async () => {},
      onStoredQuote: async () => {},
      onError,
    });

    try {
      await service.start();
      await vi.waitFor(() => expect(service.metrics.backfillCompleted).toBe(1));

      expect(service.isDailyBarsReady(instrument.symbol)).toBe(false);
      expect(onError).not.toHaveBeenCalled();
      expect(repository.getRuntimeState(null, "daily-bar-backfill:kiwoom")).toBe(
        koreanTradingDate(),
      );
    } finally {
      await service.stop();
      repository.close();
    }
  });

  it("does not request equity candles for a blocked exchange product unless it needs exit monitoring", async () => {
    const repository = createInMemoryTradingRepository();
    const adapter = fakeAdapter();
    const blockedProduct: Instrument = {
      symbol: "530090",
      name: "삼성 인버스 은 선물 ETN(H)",
      market: "KOSPI",
      exchange: "KRX",
      active: true,
      raw: {
        safety: {
          source: "kiwoom-ka10099",
          buyAllowed: false,
          restrictionCodes: ["HIGH_RISK_EXCHANGE_PRODUCT"],
        },
      },
    };
    adapter.fetchInstruments = async () => [blockedProduct];
    const fetchDailyBars = vi.fn(async () => {
      throw new Error("ordinary equity candle endpoint rejected an ETN");
    });
    adapter.fetchDailyBars = fetchDailyBars;
    const onError = vi.fn();
    const service = new MarketDataService(repository, {
      getRuntimes: () => [{ adapter, requiredDailyBars: 63 }],
      getQuoteSweepIntervalMs: () => 60_000,
      getPrioritySymbols: () => [],
      isMarketOpen: () => false,
      onQuote: async () => {},
      onStoredQuote: async () => {},
      onError,
    });

    try {
      await service.start();
      await vi.waitFor(() => expect(service.metrics.backfillCompleted).toBe(1));

      expect(fetchDailyBars).not.toHaveBeenCalled();
      expect(service.isDailyBarsReady(blockedProduct.symbol)).toBe(false);
      expect(onError).not.toHaveBeenCalled();
      expect(repository.getRuntimeState(null, "daily-bar-backfill:kiwoom")).toBe(
        koreanTradingDate(),
      );
    } finally {
      await service.stop();
      repository.close();
    }
  });

  it("still requests history for a blocked instrument that is in the exit-monitoring priority set", async () => {
    const repository = createInMemoryTradingRepository();
    const adapter = fakeAdapter();
    const blockedHolding: Instrument = {
      symbol: "530090",
      name: "삼성 인버스 은 선물 ETN(H)",
      market: "KOSPI",
      exchange: "KRX",
      active: true,
      raw: {
        safety: {
          source: "kiwoom-ka10099",
          buyAllowed: false,
          restrictionCodes: ["HIGH_RISK_EXCHANGE_PRODUCT"],
        },
      },
    };
    const completedHistory = recentCompletedHistory(blockedHolding.symbol, 63);
    adapter.fetchInstruments = async () => [blockedHolding];
    const fetchDailyBars = vi.fn(async () => completedHistory);
    adapter.fetchDailyBars = fetchDailyBars;
    const service = new MarketDataService(repository, {
      getRuntimes: () => [{ adapter, requiredDailyBars: 63 }],
      getQuoteSweepIntervalMs: () => 60_000,
      getPrioritySymbols: () => [blockedHolding.symbol],
      isMarketOpen: () => false,
      onQuote: async () => {},
      onStoredQuote: async () => {},
      onError: vi.fn(),
    });

    try {
      await service.start();
      await vi.waitFor(() => expect(service.metrics.backfillCompleted).toBe(1));

      expect(fetchDailyBars).toHaveBeenCalledWith(blockedHolding.symbol, 64);
      expect(service.isDailyBarsReady(blockedHolding.symbol)).toBe(true);
    } finally {
      await service.stop();
      repository.close();
    }
  });

  it("does not mark old daily history ready when the latest completed session is missing", async () => {
    const repository = createInMemoryTradingRepository();
    const adapter = fakeAdapter();
    const service = new MarketDataService(repository, {
      getRuntimes: () => [{ adapter, requiredDailyBars: 2 }],
      getQuoteSweepIntervalMs: () => 60_000,
      getMarketRegimeSettings: () => MarketRegimeSettingsSchema.parse({ enabled: false }),
      getPrioritySymbols: () => [],
      isMarketOpen: () => false,
      onQuote: async () => {},
      onStoredQuote: async () => {},
      onError: vi.fn(),
    });

    try {
      await service.start();
      await vi.waitFor(() => expect(service.metrics.backfillCompleted).toBe(1));
      expect(service.isDailyBarsReady(instrument.symbol)).toBe(false);
      expect(service.metrics.marketRegime.status).toBe("DISABLED");
    } finally {
      await service.stop();
      repository.close();
    }
  });

  it("uses only the strategy history requirement when the market filter is disabled", async () => {
    const repository = createInMemoryTradingRepository();
    const adapter = fakeAdapter();
    const expectedLatestDate = previousWeekdayDate(koreanTradingDate());
    const expectedLatestTimestamp = Date.parse(`${expectedLatestDate}T00:00:00.000Z`);
    const history: DailyBar[] = Array.from({ length: 20 }, (_, index) => ({
      symbol: instrument.symbol,
      tradingDate: new Date(expectedLatestTimestamp - (19 - index) * 86_400_000)
        .toISOString()
        .slice(0, 10),
      open: 10_000,
      high: 10_100,
      low: 9_900,
      close: 10_000 + index,
      volume: 100_000,
      adjusted: true,
    }));
    const fetchDailyBars = vi.fn(async () => history);
    adapter.fetchDailyBars = fetchDailyBars;
    const service = new MarketDataService(repository, {
      getRuntimes: () => [{ adapter, requiredDailyBars: 20 }],
      getQuoteSweepIntervalMs: () => 60_000,
      getMarketRegimeSettings: () => MarketRegimeSettingsSchema.parse({
        enabled: false,
        longPeriod: 60,
      }),
      getLatestCompletedTradingDate: () => expectedLatestDate,
      getPrioritySymbols: () => [],
      isMarketOpen: () => false,
      onQuote: async () => {},
      onStoredQuote: async () => {},
      onError: vi.fn(),
    });

    try {
      await service.start();
      await vi.waitFor(() => expect(service.metrics.backfillCompleted).toBe(1));
      expect(fetchDailyBars).toHaveBeenCalledWith(instrument.symbol, 21);
      expect(service.isDailyBarsReady(instrument.symbol)).toBe(true);
    } finally {
      await service.stop();
      repository.close();
    }
  });

  it("replays saved quotes for condition discovery while the market is closed", async () => {
    const repository = createInMemoryTradingRepository();
    const adapter = fakeAdapter();
    const completedHistory = recentCompletedHistory(instrument.symbol, 63);
    adapter.fetchDailyBars = async () => completedHistory;
    const savedQuote: Quote = {
      symbol: instrument.symbol,
      price: 11_000,
      cumulativeVolume: 200_000,
      tradingDate: koreanTradingDate(),
      tradingTime: "153000",
      receivedAt: new Date().toISOString(),
      source: "kiwoom",
      exchange: "KRX",
    };
    repository.upsertLatestQuote(savedQuote);
    const onQuote = vi.fn();
    const onStoredQuote = vi.fn();
    const service = new MarketDataService(repository, {
      getRuntimes: () => [{ adapter, requiredDailyBars: 63 }],
      getQuoteSweepIntervalMs: () => 60_000,
      getPrioritySymbols: () => [],
      isMarketOpen: () => false,
      onQuote,
      onStoredQuote,
      onError: vi.fn(),
    });

    try {
      await service.start();
      await vi.waitFor(() => expect(service.metrics.scanMode).toBe("LAST_SAVED"));

      expect(onStoredQuote).toHaveBeenCalledWith(
        adapter,
        expect.objectContaining(savedQuote),
      );
      expect(onQuote).not.toHaveBeenCalled();
      expect(service.metrics).toMatchObject({
        scanMode: "LAST_SAVED",
        scanProgressPercent: 100,
      });
    } finally {
      await service.stop();
      repository.close();
    }
  });

  it("replays a closed route even when another broker route is open", async () => {
    const repository = createInMemoryTradingRepository();
    const openAdapter = fakeAdapter();
    const closedAdapter = fakeAdapter();
    const completedHistory = recentCompletedHistory(instrument.symbol, 63);
    openAdapter.fetchDailyBars = async () => completedHistory;
    repository.upsertLatestQuote({
      symbol: instrument.symbol,
      price: 11_000,
      cumulativeVolume: 200_000,
      tradingDate: koreanTradingDate(),
      tradingTime: "153000",
      receivedAt: new Date().toISOString(),
      source: "kiwoom",
      exchange: "KRX",
    });
    const onStoredQuote = vi.fn();
    const service = new MarketDataService(repository, {
      getRuntimes: () => [
        { adapter: openAdapter, requiredDailyBars: 63 },
        { adapter: closedAdapter, requiredDailyBars: 63 },
      ],
      getQuoteSweepIntervalMs: () => 60_000,
      getPrioritySymbols: () => [],
      isMarketOpen: (adapter) => adapter === openAdapter,
      onQuote: async () => {},
      onStoredQuote,
      onError: vi.fn(),
    });

    try {
      await service.start();
      await vi.waitFor(() => expect(onStoredQuote).toHaveBeenCalled());
      expect(onStoredQuote).toHaveBeenCalledWith(
        closedAdapter,
        expect.objectContaining({ symbol: instrument.symbol }),
      );
      expect(service.metrics.scanMode).toBe("LIVE");
    } finally {
      await service.stop();
      repository.close();
    }
  });

  it("builds the market-wide buy gate from completed daily bars and today's real quotes", async () => {
    const repository = createInMemoryTradingRepository();
    const adapter = fakeAdapter();
    const instruments: Instrument[] = Array.from({ length: 20 }, (_, index) => ({
      symbol: String(index + 1).padStart(6, "0"),
      name: `시장 표본 ${index + 1}`,
      market: "KOSPI",
      exchange: "KRX",
      active: true,
    }));
    const expectedLatestDate = previousWeekdayDate(koreanTradingDate());
    const expectedLatestTimestamp = Date.parse(`${expectedLatestDate}T00:00:00.000Z`);
    const completedDates = Array.from({ length: 20 }, (_, index) =>
      new Date(expectedLatestTimestamp - (19 - index) * 86_400_000)
        .toISOString()
        .slice(0, 10));
    adapter.fetchInstruments = async () => instruments;
    adapter.fetchDailyBars = async (symbol) => completedDates.map((tradingDate, index) => ({
      symbol,
      tradingDate,
      open: 10_000 + index,
      high: 10_100 + index,
      low: 9_900 + index,
      close: 10_000 + index,
      volume: 100_000,
      adjusted: true,
    }));
    const regimeSettings = MarketRegimeSettingsSchema.parse({
      longPeriod: 20,
      minimumSampleSize: 20,
      minimumAboveLongMaBps: 5_000,
      minimumIntradayAdvancingBps: 5_000,
    });
    const onMarketRegimeChange = vi.fn();
    const service = new MarketDataService(repository, {
      getRuntimes: () => [{ adapter, requiredDailyBars: 20 }],
      getQuoteSweepIntervalMs: () => 60_000,
      getMarketRegimeSettings: () => regimeSettings,
      getLatestCompletedTradingDate: () => expectedLatestDate,
      onMarketRegimeChange,
      getPrioritySymbols: () => [],
      isMarketOpen: () => true,
      onQuote: async () => {},
      onStoredQuote: async () => {},
      onError: vi.fn(),
    });

    try {
      await service.start();
      await vi.waitFor(() => expect(service.metrics.backfillCompleted).toBe(20));
      expect(service.metrics.marketRegime).toMatchObject({
        status: "WAITING_FOR_DATA",
        buyAllowed: false,
        reasonCode: "INTRADAY_BREADTH_NOT_READY",
        dailySampleCount: 20,
        dailyAboveLongMaBps: 10_000,
      });

      for (const [index, row] of instruments.entries()) {
        await service.handleRealtimeQuote(adapter, {
          symbol: row.symbol,
          // Flat shares are not counted as advancing.
          price: index < 15 ? 10_000 : 10_100,
          open: 10_000,
          cumulativeVolume: 100_000,
          tradingDate: koreanTradingDate(),
          tradingTime: "100000",
          receivedAt: new Date().toISOString(),
          source: "kiwoom",
          exchange: "KRX",
        });
      }

      expect(service.metrics.marketRegime).toMatchObject({
        status: "WEAK",
        buyAllowed: false,
        reasonCode: "INTRADAY_BREADTH_WEAK",
        intradaySampleCount: 20,
        intradayAdvancingBps: 2_500,
      });

      for (const row of instruments.slice(0, 15)) {
        await service.handleRealtimeQuote(adapter, {
          symbol: row.symbol,
          price: 10_100,
          open: 10_000,
          cumulativeVolume: 120_000,
          tradingDate: koreanTradingDate(),
          tradingTime: "101000",
          receivedAt: new Date().toISOString(),
          source: "kiwoom",
          exchange: "KRX",
        });
      }

      expect(service.metrics.marketRegime).toMatchObject({
        status: "NORMAL",
        buyAllowed: true,
        reasonCode: "MARKET_HEALTHY",
        intradayAdvancingBps: 10_000,
      });
      expect(onMarketRegimeChange).toHaveBeenCalledWith(
        expect.objectContaining({ buyAllowed: true }),
        expect.objectContaining({ buyAllowed: false }),
      );
    } finally {
      await service.stop();
      repository.close();
    }
  });
});
