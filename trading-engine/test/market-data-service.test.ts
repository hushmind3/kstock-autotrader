import { describe, expect, it, vi } from "vitest";
import { createInMemoryTradingRepository } from "@kstock/database";
import {
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

  it("replays saved quotes for condition discovery while the market is closed", async () => {
    const repository = createInMemoryTradingRepository();
    const adapter = fakeAdapter();
    const completedHistory: DailyBar[] = Array.from({ length: 63 }, (_, index) => {
      const date = new Date(Date.UTC(2000, 0, index + 1));
      return {
        symbol: instrument.symbol,
        tradingDate: date.toISOString().slice(0, 10),
        open: 10_000,
        high: 10_100,
        low: 9_900,
        close: 10_000 + index,
        volume: 100_000,
        adjusted: true,
      };
    });
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
    const completedHistory: DailyBar[] = Array.from({ length: 63 }, (_, index) => ({
      symbol: instrument.symbol,
      tradingDate: new Date(Date.UTC(2000, 0, index + 1)).toISOString().slice(0, 10),
      open: 10_000,
      high: 10_100,
      low: 9_900,
      close: 10_000 + index,
      volume: 100_000,
      adjusted: true,
    }));
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
});
