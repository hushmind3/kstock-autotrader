import type { TradingRepository } from "@kstock/database";
import type { AccountScope, Exchange, IntradayTradeSample, Quote } from "@kstock/shared";
import { verifiedQuoteObservedAt } from "./position-lifecycle.js";

interface WindowState { generation: number; samples: IntradayTradeSample[] }
interface Entry { scope: AccountScope; key: string; state: WindowState; savedAt: number; dirty: boolean }
const scopeKey = (scope: AccountScope) => JSON.stringify(scope);

/** Only actual broker WebSocket events may enter this tape; never interpolate ticks. */
export class IntradayTape {
  private readonly entries = new Map<string, Entry>();
  private readonly generations = new Map<string, number>();
  constructor(private readonly repository: TradingRepository, private readonly options: { staleQuoteMs?: number } = {}) {}

  private generation(scope: AccountScope): number {
    const key = scopeKey(scope);
    if (!this.generations.has(key)) this.generations.set(key,
      this.repository.getRuntimeState<number>(scope, "intraday-reset") ?? 0);
    return this.generations.get(key)!;
  }

  private entry(scope: AccountScope, exchange: Exchange, symbol: string): Entry {
    const key = `intraday:${exchange}:${symbol}`;
    const cacheKey = `${scopeKey(scope)}:${key}`;
    let entry = this.entries.get(cacheKey);
    const generation = this.generation(scope);
    if (!entry) {
      const stored = this.repository.getRuntimeState<WindowState>(scope, key);
      const valid = stored?.generation === generation && Array.isArray(stored.samples) &&
        stored.samples.every((sample, index, samples) => Number.isFinite(Date.parse(sample.observedAt)) &&
          Number.isFinite(sample.price) && sample.price > 0 && Number.isSafeInteger(sample.cumulativeVolume) &&
          sample.cumulativeVolume >= 0 && (index === 0 ||
            (Date.parse(sample.observedAt) > Date.parse(samples[index - 1]!.observedAt) &&
              sample.cumulativeVolume >= samples[index - 1]!.cumulativeVolume)));
      entry = { scope, key, state: { generation, samples: valid ? stored.samples : [] }, savedAt: 0, dirty: false };
      this.entries.set(cacheKey, entry);
    }
    return entry;
  }

  observe(scope: AccountScope, quote: Quote, now = new Date()): boolean {
    const observedAt = verifiedQuoteObservedAt(quote);
    const instant = observedAt ? Date.parse(observedAt) : NaN;
    const received = Date.parse(quote.receivedAt);
    const staleMs = this.options.staleQuoteMs ?? 20_000;
    if (!quote.exchange || quote.source !== scope.brokerId || quote.stale ||
        !Number.isFinite(instant) || !Number.isFinite(received) || instant > now.getTime() ||
        received > now.getTime() || received < instant || now.getTime() - instant > staleMs ||
        now.getTime() - received > staleMs || instant <= this.generation(scope) ||
        !Number.isFinite(quote.price) || quote.price <= 0 ||
        !Number.isSafeInteger(quote.cumulativeVolume) || quote.cumulativeVolume < 0) return false;
    const entry = this.entry(scope, quote.exchange, quote.symbol);
    let samples = entry.state.samples;
    const last = samples.at(-1);
    if (last && instant < Date.parse(last.observedAt)) return false;
    if (last && (instant - Date.parse(last.observedAt) > 30_000 ||
        quote.cumulativeVolume < last.cumulativeVolume ||
        new Date(Date.parse(last.observedAt) + 9 * 3_600_000).toISOString().slice(0, 10) !== quote.tradingDate)) samples = [];
    const sample = { observedAt: observedAt!, price: quote.price, cumulativeVolume: quote.cumulativeVolume };
    if (samples.at(-1)?.observedAt === observedAt) samples[samples.length - 1] = sample;
    else samples.push(sample);
    entry.state.samples = samples.filter((row) => Date.parse(row.observedAt) >= instant - 3_600_000).slice(-3_601);
    entry.dirty = true;
    if (now.getTime() - entry.savedAt >= 5_000) this.save(entry, now.getTime());
    return true;
  }

  samples(scope: AccountScope, exchange: Exchange, symbol: string, now = new Date(), windowSeconds = 600): IntradayTradeSample[] {
    const samples = this.entry(scope, exchange, symbol).state.samples;
    const latest = samples.at(-1);
    if (!latest || Date.parse(latest.observedAt) > now.getTime() || now.getTime() - Date.parse(latest.observedAt) > 30_000) return [];
    // Anchor at the actual latest broker tick, not wall-clock subsecond rounding.
    const cutoff = Date.parse(latest.observedAt) - Math.min(3_600, windowSeconds) * 1_000;
    return samples.filter((sample) => Date.parse(sample.observedAt) >= cutoff).map((sample) => ({ ...sample }));
  }

  resetScope(scope: AccountScope, now = new Date()): void {
    const generation = Math.max(now.getTime(), this.generation(scope));
    this.generations.set(scopeKey(scope), generation);
    this.repository.setRuntimeState(scope, "intraday-reset", generation);
    for (const [key, entry] of this.entries) if (scopeKey(entry.scope) === scopeKey(scope)) this.entries.delete(key);
  }

  private save(entry: Entry, now: number): void {
    this.repository.setRuntimeState(entry.scope, entry.key, entry.state);
    entry.savedAt = now;
    entry.dirty = false;
  }

  flush(): void { for (const entry of this.entries.values()) if (entry.dirty) this.save(entry, Date.now()); }
}
