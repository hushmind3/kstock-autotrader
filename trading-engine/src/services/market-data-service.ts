import {
  readInstrumentSafetyMetadata,
  koreanTradingDate,
  toIsoDateTime,
  type AccountScope,
  type BrokerAdapter,
  type Instrument,
  type Quote,
} from "@kstock/shared";
import { TradingRepository } from "@kstock/database";

export interface MarketRuntimeView {
  adapter: BrokerAdapter;
  requiredDailyBars: number;
}

export interface MarketDataMetrics {
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
  lastUniverseSyncAt: string | null;
  backfillCompleted: number;
  backfillTotal: number;
}

export interface MarketDataServiceOptions {
  getRuntimes: () => MarketRuntimeView[];
  getQuoteSweepIntervalMs: () => number;
  getPrioritySymbols: (scope: AccountScope) => string[];
  isMarketOpen: (adapter: BrokerAdapter) => boolean;
  onQuote: (adapter: BrokerAdapter, quote: Quote) => Promise<void>;
  onStoredQuote: (adapter: BrokerAdapter, quote: Quote) => Promise<void>;
  onError: (error: unknown, context: string, adapter?: BrokerAdapter) => void;
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

/**
 * Daily strategy input deliberately excludes today's unfinished candle. The
 * newest normally expected completed candle is therefore the preceding
 * weekday. An official weekday holiday may still trigger one harmless broker
 * refresh, after which the durable completion marker prevents repeat work.
 */
export function previousWeekdayDate(tradingDate: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(tradingDate)) {
    throw new TypeError("tradingDate must use YYYY-MM-DD");
  }
  const date = new Date(`${tradingDate}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime())) {
    throw new TypeError("tradingDate must be a valid calendar date");
  }
  do {
    date.setUTCDate(date.getUTCDate() - 1);
  } while (date.getUTCDay() === 0 || date.getUTCDay() === 6);
  return date.toISOString().slice(0, 10);
}

export class MarketDataService {
  #controller: AbortController | null = null;
  readonly #dailyBarsReady = new Set<string>();
  #metrics: MarketDataMetrics = {
    universeCount: 0,
    buyEligibleCount: 0,
    restrictedInstrumentCount: 0,
    restrictionCounts: {},
    liveSubscriptionCount: 0,
    rotatingScanCount: 0,
    scanProgressPercent: 0,
    scanMode: "WAITING_FOR_DATA",
    lastScanCompletedAt: null,
    lastScanQuoteAt: null,
    lastUniverseSyncAt: null,
    backfillCompleted: 0,
    backfillTotal: 0,
  };

  constructor(
    private readonly repository: TradingRepository,
    private readonly options: MarketDataServiceOptions,
  ) {
    this.#metrics.lastUniverseSyncAt = this.repository.getRuntimeState<string>(
      null,
      "last-universe-sync-at",
    );
    this.updateInstrumentMetrics(this.repository.listInstruments(true));
  }

  get metrics(): MarketDataMetrics {
    return { ...this.#metrics };
  }

  isDailyBarsReady(symbol: string): boolean {
    return this.#dailyBarsReady.has(symbol);
  }

  async start(): Promise<void> {
    await this.stop();
    this.#controller = new AbortController();
    this.#dailyBarsReady.clear();
    const runtimes = this.options.getRuntimes();
    if (runtimes.length === 0) return;

    const provider = runtimes.find((runtime) => runtime.adapter.getHealth().state === "CONNECTED");
    if (!provider) return;
    try {
      await this.syncUniverse(provider.adapter);
    } catch (error) {
      this.options.onError(error, "universe-sync", provider.adapter);
    }

    const signal = this.#controller.signal;
    // Install the small priority feed before the full KOSPI REST sweep. This
    // gives the engine a broker-timestamped quote immediately after startup,
    // so connection/order readiness does not wait for thousands of symbols.
    await Promise.all(
      runtimes.map(async (runtime) => {
        if (!this.options.isMarketOpen(runtime.adapter)) return;
        try {
          await this.refreshQuoteSubscriptions(runtime);
        } catch (error) {
          this.options.onError(error, "initial-quote-subscriptions", runtime.adapter);
        }
      }),
    );
    const backfillRuntime: MarketRuntimeView = {
      adapter: provider.adapter,
      requiredDailyBars: Math.max(
        ...runtimes.map((runtime) => runtime.requiredDailyBars),
      ),
    };
    void this.backfillDailyBars(backfillRuntime, signal);
    for (const runtime of runtimes) void this.quoteSweepLoop(runtime, signal);
    void this.universeRefreshLoop(backfillRuntime, signal);
  }

  async stop(): Promise<void> {
    this.#controller?.abort();
    this.#controller = null;
    const runtimes = this.options.getRuntimes();
    await Promise.allSettled(runtimes.map((runtime) => runtime.adapter.replaceQuoteSubscriptions([])));
    this.#metrics.liveSubscriptionCount = 0;
  }

  async handleRealtimeQuote(adapter: BrokerAdapter, quote: Quote): Promise<void> {
    this.repository.upsertLatestQuote(quote);
    await this.options.onQuote(adapter, quote);
  }

  async refreshStoredCandidates(): Promise<void> {
    const signal = this.#controller?.signal;
    if (!signal || signal.aborted) return;
    await this.scanStoredQuotes(signal);
  }

  async refreshForSessionChange(): Promise<void> {
    const signal = this.#controller?.signal;
    if (!signal || signal.aborted) return;
    await Promise.all(
      this.options.getRuntimes().map(async (runtime) => {
        try {
          if (this.options.isMarketOpen(runtime.adapter)) {
            await this.refreshQuoteSubscriptions(runtime);
          } else {
            await runtime.adapter.replaceQuoteSubscriptions([]);
          }
        } catch (error) {
          this.options.onError(error, "session-change-subscriptions", runtime.adapter);
        }
      }),
    );
    this.#metrics.liveSubscriptionCount = this.options
      .getRuntimes()
      .filter((runtime) => this.options.isMarketOpen(runtime.adapter))
      .reduce(
        (sum, runtime) =>
          sum + Math.min(
            new Set(this.options.getPrioritySymbols(runtime.adapter.scope)).size,
            runtime.adapter.capabilities.maxQuoteSubscriptions,
          ),
        0,
      );
    await this.scanStoredQuotes(signal);
  }

  private async syncUniverse(adapter: BrokerAdapter): Promise<void> {
    const fresh = await adapter.fetchInstruments();
    if (fresh.length === 0) throw new Error("The broker returned an empty KOSPI universe");
    const bySymbol = new Map(fresh.map((instrument) => [instrument.symbol, instrument]));
    const today = koreanTradingDate();
    const inactive: Instrument[] = [];
    for (const existing of this.repository.listInstruments(true)) {
      if (!bySymbol.has(existing.symbol)) {
        inactive.push({ ...existing, active: false, delistedDate: today });
      }
    }
    this.repository.upsertInstruments([...fresh, ...inactive]);
    const now = toIsoDateTime();
    this.repository.setRuntimeState(null, "last-universe-sync-at", now);
    this.#metrics.lastUniverseSyncAt = now;
    const active = fresh.filter((instrument) => instrument.active);
    this.updateInstrumentMetrics(active);
    this.#metrics.rotatingScanCount = active.length;
  }

  private updateInstrumentMetrics(instruments: readonly Instrument[]): void {
    const restrictionCounts: Record<string, number> = {};
    let buyEligibleCount = 0;
    for (const instrument of instruments) {
      const safety = readInstrumentSafetyMetadata(instrument);
      if (safety.buyAllowed) {
        buyEligibleCount += 1;
        continue;
      }
      for (const code of safety.restrictionCodes) {
        restrictionCounts[code] = (restrictionCounts[code] ?? 0) + 1;
      }
    }
    this.#metrics.universeCount = instruments.length;
    this.#metrics.buyEligibleCount = buyEligibleCount;
    this.#metrics.restrictedInstrumentCount = instruments.length - buyEligibleCount;
    this.#metrics.restrictionCounts = restrictionCounts;
  }

  private async backfillDailyBars(runtime: MarketRuntimeView, signal: AbortSignal): Promise<void> {
    const instruments = this.repository.listInstruments(true);
    const tradingDate = koreanTradingDate();
    const normallyExpectedLatestDate = previousWeekdayDate(tradingDate);
    const stateKey = `daily-bar-backfill:${runtime.adapter.scope.brokerId}`;
    const lastCompletedDate = this.repository.getRuntimeState<string>(null, stateKey);
    let completedWithoutError = true;
    this.#metrics.backfillTotal = instruments.length;
    this.#metrics.backfillCompleted = 0;
    for (const instrument of instruments) {
      if (signal.aborted) return;
      try {
        const existing = this.repository.listDailyBars(instrument.symbol, {
          limit: runtime.requiredDailyBars + 1,
        });
        const completedExisting = existing.filter(
          (bar) => bar.tradingDate < tradingDate,
        );
        const latestExistingDate = completedExisting.at(-1)?.tradingDate;
        const needsDailyRefresh =
          lastCompletedDate !== tradingDate &&
          latestExistingDate !== normallyExpectedLatestDate;
        if (
          needsDailyRefresh ||
          completedExisting.length < runtime.requiredDailyBars
        ) {
          const bars = await runtime.adapter.fetchDailyBars(
            instrument.symbol,
            runtime.requiredDailyBars + 1,
          );
          if (bars.length === 0) {
            throw new Error(`Broker returned no daily bars for ${instrument.symbol}`);
          }
          this.repository.upsertDailyBars(bars, runtime.adapter.scope.brokerId);
        }
        const verified = this.repository
          .listDailyBars(instrument.symbol, {
            limit: runtime.requiredDailyBars + 1,
          })
          .filter((bar) => bar.tradingDate < tradingDate);
        if (verified.length < runtime.requiredDailyBars) {
          // Newly listed shares and products naturally have less history than
          // a strategy requires. They are ineligible until enough completed
          // sessions accumulate; this is expected market data, not an engine
          // or order failure, so do not flood the operational error log.
          this.#dailyBarsReady.delete(instrument.symbol);
          continue;
        }
        this.#dailyBarsReady.add(instrument.symbol);
      } catch (error) {
        completedWithoutError = false;
        this.#dailyBarsReady.delete(instrument.symbol);
        this.options.onError(error, `daily-bars:${instrument.symbol}`, runtime.adapter);
      } finally {
        this.#metrics.backfillCompleted += 1;
      }
    }
    if (!signal.aborted && completedWithoutError) {
      this.repository.setRuntimeState(null, stateKey, tradingDate);
    }
    // Candidate discovery is independent from automatic ordering. When the
    // engine starts while the exchange is closed, rebuild the current screen
    // from the latest saved broker quotes after daily bars are ready. This
    // path never submits an order; the live path below remains the only path
    // that can reach order dispatch.
    if (!signal.aborted) {
      await this.scanStoredQuotes(signal);
    }
  }

  private async scanStoredQuotes(signal: AbortSignal): Promise<void> {
    const instruments = this.repository.listInstruments(true);
    const activeSymbols = new Set(instruments.map((instrument) => instrument.symbol));
    const runtimes = this.options.getRuntimes();
    const closedRuntimes = runtimes.filter((runtime) =>
      !this.options.isMarketOpen(runtime.adapter));
    const hasOpenRuntime = closedRuntimes.length < runtimes.length;
    if (closedRuntimes.length === 0) {
      this.#metrics.scanMode = "LIVE";
      return;
    }
    this.#metrics.rotatingScanCount = instruments.length;
    this.#metrics.scanProgressPercent = 0;
    // Replaying a closed route must not overwrite the LIVE status of another
    // broker route which is scanning concurrently.
    this.#metrics.scanMode = hasOpenRuntime ? "LIVE" : "WAITING_FOR_DATA";

    let processed = 0;
    let evaluated = 0;
    let latestQuoteAt: string | null = null;
    const total = Math.max(1, instruments.length * closedRuntimes.length);
    for (const runtime of closedRuntimes) {
      const quotesBySymbol = new Map(
        this.repository
          .listLatestQuotes(runtime.adapter.scope.brokerId)
          .filter((quote) => activeSymbols.has(quote.symbol))
          .map((quote) => [quote.symbol, quote]),
      );
      for (const instrument of instruments) {
        if (signal.aborted) return;
        const quote = quotesBySymbol.get(instrument.symbol);
        if (quote && this.#dailyBarsReady.has(instrument.symbol)) {
          try {
            await this.options.onStoredQuote(runtime.adapter, quote);
            evaluated += 1;
            if (latestQuoteAt === null || quote.receivedAt > latestQuoteAt) {
              latestQuoteAt = quote.receivedAt;
            }
          } catch (error) {
            this.options.onError(
              error,
              `stored-quote-scan:${instrument.symbol}`,
              runtime.adapter,
            );
          }
        }
        processed += 1;
        this.#metrics.scanProgressPercent = Math.min(
          100,
          Math.round((processed / total) * 100),
        );
      }
    }

    if (
      !signal.aborted &&
      evaluated > 0
    ) {
      if (!hasOpenRuntime) {
        this.#metrics.scanMode = "LAST_SAVED";
      }
      this.#metrics.scanProgressPercent = 100;
      this.#metrics.lastScanCompletedAt = toIsoDateTime();
      this.#metrics.lastScanQuoteAt = latestQuoteAt;
    }
  }

  private async quoteSweepLoop(runtime: MarketRuntimeView, signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      if (!this.options.isMarketOpen(runtime.adapter)) {
        await runtime.adapter.replaceQuoteSubscriptions([]).catch((error: unknown) => {
          this.options.onError(error, "closed-market-unsubscribe", runtime.adapter);
        });
        await delay(30_000, signal);
        continue;
      }
      const instruments = this.repository.listInstruments(true);
      this.#metrics.rotatingScanCount = instruments.length;
      this.#metrics.scanProgressPercent = 0;
      this.#metrics.scanMode = "LIVE";
      const batchSize = Math.max(1, runtime.adapter.capabilities.quoteBatchSize ?? 1);
      let latestQuoteAt: string | null = null;
      for (
        let offset = 0;
        offset < instruments.length &&
        !signal.aborted &&
        this.options.isMarketOpen(runtime.adapter);
        offset += batchSize
      ) {
        const symbols = instruments.slice(offset, offset + batchSize).map((row) => row.symbol);
        try {
          const quotes = runtime.adapter.fetchQuotes
            ? await runtime.adapter.fetchQuotes(symbols)
            : await Promise.all(symbols.map((symbol) => runtime.adapter.fetchQuote(symbol)));
          for (const quote of quotes) {
            this.repository.upsertLatestQuote(quote);
            await this.options.onQuote(runtime.adapter, quote);
            if (latestQuoteAt === null || quote.receivedAt > latestQuoteAt) {
              latestQuoteAt = quote.receivedAt;
            }
          }
        } catch (error) {
          this.options.onError(error, `quote-sweep:${symbols[0] ?? "empty"}`, runtime.adapter);
        }
        this.#metrics.scanProgressPercent = instruments.length === 0
          ? 100
          : Math.min(100, Math.round(((offset + symbols.length) / instruments.length) * 100));
      }
      if (!signal.aborted && this.options.isMarketOpen(runtime.adapter)) {
        this.#metrics.lastScanCompletedAt = toIsoDateTime();
        this.#metrics.lastScanQuoteAt = latestQuoteAt;
        try {
          await this.refreshQuoteSubscriptions(runtime);
        } catch (error) {
          this.options.onError(error, "quote-subscriptions", runtime.adapter);
        }
      }
      await delay(this.options.getQuoteSweepIntervalMs(), signal);
    }
  }

  private async refreshQuoteSubscriptions(runtime: MarketRuntimeView): Promise<void> {
    const priority = [...new Set(this.options.getPrioritySymbols(runtime.adapter.scope))];
    const selected = priority.slice(0, runtime.adapter.capabilities.maxQuoteSubscriptions);
    await runtime.adapter.replaceQuoteSubscriptions(selected);
    this.#metrics.liveSubscriptionCount = this.options
      .getRuntimes()
      .filter((current) => this.options.isMarketOpen(current.adapter))
      .reduce(
        (sum, current) =>
          sum + Math.min(
            new Set(this.options.getPrioritySymbols(current.adapter.scope)).size,
            current.adapter.capabilities.maxQuoteSubscriptions,
          ),
        0,
      );
  }

  private async universeRefreshLoop(
    runtime: MarketRuntimeView,
    signal: AbortSignal,
  ): Promise<void> {
    while (!signal.aborted) {
      // Risk designations and trading suspensions can change during the day.
      // Refresh the broker instrument master often enough that the final
      // pre-order gate is not relying on a start-of-day-only snapshot.
      await delay(30 * 60 * 1_000, signal);
      if (signal.aborted) return;
      try {
        await this.syncUniverse(runtime.adapter);
        await this.backfillDailyBars(runtime, signal);
      } catch (error) {
        this.options.onError(error, "universe-refresh", runtime.adapter);
      }
    }
  }
}
