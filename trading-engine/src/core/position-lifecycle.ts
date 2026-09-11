import type { FillRecord, TradingRepository } from "@kstock/database";
import type { AccountScope, BrokerPosition, Quote, StrategyDecision } from "@kstock/shared";

export interface PositionCycle {
  quantity: number;
  averagePrice: number;
  openedAt: string | null;
  peakPrice: number;
  lastQuoteAt: string | null;
  lastExitAt: string | null;
  freshSignalSeen: boolean;
  exitDecision: StrategyDecision | null;
  exitPolicyKey?: string | null;
}

interface AccountCycles {
  version: 1;
  snapshotAt: string;
  symbols: Record<string, PositionCycle>;
}

const STATE_KEY = "position-automation:v1";

export function verifiedQuoteObservedAt(quote: Quote): string | null {
  if (quote.brokerTimestampVerified !== true || !/^(?:[01]\d|2[0-3])[0-5]\d[0-5]\d$/.test(quote.tradingTime)) return null;
  const time = Date.parse(`${quote.tradingDate}T${quote.tradingTime.slice(0, 2)}:${quote.tradingTime.slice(2, 4)}:${quote.tradingTime.slice(4, 6)}+09:00`);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

/** State follows confirmed balances/fills, never a submitted order or an old quote. */
export class PositionLifecycle {
  constructor(private readonly repository: TradingRepository) {}

  private read(scope: AccountScope): AccountCycles {
    return this.repository.getRuntimeState<AccountCycles>(scope, STATE_KEY)
      ?? { version: 1, snapshotAt: "", symbols: {} };
  }

  get(scope: AccountScope, symbol: string): PositionCycle | null {
    return this.read(scope).symbols[symbol] ?? null;
  }

  synchronize(
    scope: AccountScope,
    positions: BrokerPosition[],
    fills: FillRecord[],
    fetchedAt: string,
  ): void {
    if (!Number.isFinite(Date.parse(fetchedAt))) return;
    const state = this.read(scope);
    if (state.snapshotAt > fetchedAt) return;
    const held = new Map(positions.filter((row) => row.quantity > 0).map((row) => [row.symbol, row]));
    const fillsBySymbol = new Map<string, FillRecord[]>();
    for (const fill of fills) {
      if (fill.executedAt > fetchedAt || !Number.isFinite(Date.parse(fill.executedAt))) continue;
      const rows = fillsBySymbol.get(fill.symbol) ?? [];
      rows.push(fill);
      fillsBySymbol.set(fill.symbol, rows);
    }
    const symbols = new Set([...Object.keys(state.symbols), ...held.keys(), ...fillsBySymbol.keys()]);
    for (const symbol of symbols) {
      const previous = state.symbols[symbol];
      const position = held.get(symbol);
      const history = (fillsBySymbol.get(symbol) ?? []).sort((a, b) => b.executedAt.localeCompare(a.executedAt));
      const latestSellAt = history.find((row) => row.side === "sell")?.executedAt ?? null;
      if (!position) {
        if (!previous && !latestSellAt) continue;
        const exitedAt = previous?.quantity
          ? latestSellAt && latestSellAt > state.snapshotAt ? latestSellAt : fetchedAt
          : latestSellAt ?? previous?.lastExitAt ?? null;
        const lastExitAt = [exitedAt, previous?.lastExitAt].filter((value): value is string => !!value).sort().at(-1) ?? null;
        const newExit = !!previous?.quantity || lastExitAt !== previous?.lastExitAt;
        state.symbols[symbol] = {
          quantity: 0, averagePrice: 0, openedAt: null, peakPrice: 0, lastQuoteAt: null,
          lastExitAt, freshSignalSeen: newExit ? false : previous?.freshSignalSeen ?? false,
          exitDecision: null,
          exitPolicyKey: null,
        };
        continue;
      }
      // Walk the known fill ledger backwards from the authoritative balance.
      // If history is incomplete, observe from now rather than inventing an
      // acquisition date for an externally purchased position.
      let remaining = position.quantity;
      let inferredEntryAt: string | null = null;
      for (const fill of history) {
        remaining -= fill.side === "buy" ? fill.quantity : -fill.quantity;
        if (remaining < 0) break;
        if (remaining === 0 && fill.side === "buy") {
          inferredEntryAt = fill.executedAt;
          break;
        }
      }
      const newCycle = !previous?.quantity ||
        (inferredEntryAt !== null && inferredEntryAt > state.snapshotAt);
      const basisChanged = !newCycle && (
        position.averagePrice !== previous.averagePrice || position.quantity > previous.quantity
      );
      state.symbols[symbol] = {
        quantity: position.quantity,
        averagePrice: position.averagePrice,
        openedAt: newCycle ? inferredEntryAt ?? fetchedAt : basisChanged ? fetchedAt : previous.openedAt,
        // Account snapshots and quote.high can predate this entry. Only the
        // cost basis and later verified trade quotes can establish a peak.
        peakPrice: newCycle || basisChanged ? position.averagePrice : previous.peakPrice,
        lastQuoteAt: newCycle || basisChanged ? null : previous.lastQuoteAt,
        lastExitAt: previous?.lastExitAt ?? null,
        freshSignalSeen: false,
        exitDecision: newCycle || basisChanged ? null : previous.exitDecision,
        exitPolicyKey: newCycle || basisChanged ? null : previous.exitPolicyKey ?? null,
      };
    }
    state.snapshotAt = fetchedAt;
    this.repository.setRuntimeState(scope, STATE_KEY, state, fetchedAt);
  }

  observeQuote(scope: AccountScope, quote: Quote): PositionCycle | null {
    const state = this.read(scope);
    const cycle = state.symbols[quote.symbol];
    if (!cycle?.quantity || !cycle.openedAt || !Number.isFinite(quote.price) || quote.price <= 0) return cycle ?? null;
    const verifiedAt = verifiedQuoteObservedAt(quote);
    if (!verifiedAt) return cycle;
    const observedAt = Date.parse(verifiedAt);
    if (!Number.isFinite(observedAt) || observedAt < Date.parse(cycle.openedAt) ||
      (cycle.lastQuoteAt !== null && observedAt <= Date.parse(cycle.lastQuoteAt))) return cycle;
    cycle.peakPrice = Math.max(cycle.peakPrice, quote.price);
    cycle.lastQuoteAt = new Date(observedAt).toISOString();
    this.repository.setRuntimeState(scope, STATE_KEY, state, quote.receivedAt);
    return cycle;
  }

  rememberExit(scope: AccountScope, symbol: string, decision: StrategyDecision | null, policyKey: string | null = null): void {
    const state = this.read(scope);
    const cycle = state.symbols[symbol];
    if (!cycle?.quantity || (JSON.stringify(cycle.exitDecision) === JSON.stringify(decision) &&
      (cycle.exitPolicyKey ?? null) === policyKey)) return;
    cycle.exitDecision = decision;
    cycle.exitPolicyKey = policyKey;
    this.repository.setRuntimeState(scope, STATE_KEY, state);
  }

  filterReentry(
    scope: AccountScope,
    symbol: string,
    decision: StrategyDecision,
    cooldownMinutes: number,
    observedAt: string,
    observe = true,
  ): StrategyDecision {
    const state = this.read(scope);
    const cycle = state.symbols[symbol];
    if (!cycle?.lastExitAt || cycle.quantity > 0) return decision;
    if (observedAt <= cycle.lastExitAt) {
      return decision.action === "BUY"
        ? { ...decision, action: "HOLD", reasonCodes: ["REENTRY_WAIT_FOR_NEW_SIGNAL"] }
        : decision;
    }
    // Only a genuinely observed neutral signal rearms this position. Neither
    // a replay of yesterday's quotes nor NOT_READY nor a market-wide block
    // can manufacture a fresh entry opportunity.
    if (observe && decision.action === "HOLD" && !cycle.freshSignalSeen) {
      cycle.freshSignalSeen = true;
      this.repository.setRuntimeState(scope, STATE_KEY, state);
    }
    if (decision.action !== "BUY") return decision;
    const cooldownEndsAt = Date.parse(cycle.lastExitAt) + cooldownMinutes * 60_000;
    const reason = Date.parse(observedAt) < cooldownEndsAt
      ? "REENTRY_COOLDOWN"
      : !cycle.freshSignalSeen ? "REENTRY_WAIT_FOR_NEW_SIGNAL" : null;
    return reason ? {
      action: "HOLD", reasonCodes: [reason],
      metrics: { ...decision.metrics, reentryAfter: new Date(cooldownEndsAt).toISOString() },
    } : decision;
  }
}
