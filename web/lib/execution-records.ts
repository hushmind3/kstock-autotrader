import type { ExecutionRow } from "./api-types";

export type ExecutionSideFilter = "all" | ExecutionRow["side"];

export interface ExecutionSummary {
  totalCount: number;
  buyCount: number;
  sellCount: number;
  buyAmount: number;
  sellAmount: number;
  fee: number;
  tax: number;
}

export type ExecutionTradeStatus = "matched" | "open-buy" | "unmatched-sell";

export interface ExecutionTradeLeg {
  execution: ExecutionRow;
  /** Quantity from this execution allocated to this FIFO lot. */
  quantity: number;
}

export interface ExecutionTradePair {
  id: string;
  brokerId: ExecutionRow["brokerId"];
  environment: ExecutionRow["environment"];
  accountIdMasked: string;
  symbol: string;
  name: string;
  status: ExecutionTradeStatus;
  quantity: number;
  buy: ExecutionTradeLeg | null;
  sell: ExecutionTradeLeg | null;
  /** Latest real execution time represented by the lot, used only for display order. */
  activityAt: string;
}

export interface ExecutionTradeSummary {
  matchedLotCount: number;
  openBuyLotCount: number;
  unmatchedSellLotCount: number;
  matchedQuantity: number;
  openBuyQuantity: number;
  unmatchedSellQuantity: number;
}

interface PendingBuy {
  execution: ExecutionRow;
  remainingQuantity: number;
}

export function filterExecutions(
  rows: ExecutionRow[],
  filter: ExecutionSideFilter,
): ExecutionRow[] {
  return filter === "all" ? rows : rows.filter((row) => row.side === filter);
}

export function summarizeExecutions(rows: ExecutionRow[]): ExecutionSummary {
  return rows.reduce<ExecutionSummary>((summary, row) => {
    summary.totalCount += 1;
    const amount = row.grossAmount;
    if (row.side === "buy") {
      summary.buyCount += 1;
      if (amount !== null && Number.isSafeInteger(amount)) summary.buyAmount += amount;
    } else {
      summary.sellCount += 1;
      if (amount !== null && Number.isSafeInteger(amount)) summary.sellAmount += amount;
    }
    summary.fee += row.fee;
    summary.tax += row.tax;
    return summary;
  }, {
    totalCount: 0,
    buyCount: 0,
    sellCount: 0,
    buyAmount: 0,
    sellAmount: 0,
    fee: 0,
    tax: 0,
  });
}

/**
 * Connects persisted executions as chronological FIFO lots without deriving P&L.
 * Matching never crosses broker, environment, masked account, or symbol boundaries.
 * A sell can only consume buys that occurred earlier in the provided history.
 */
export function pairExecutionsFifo(rows: readonly ExecutionRow[]): ExecutionTradePair[] {
  const chronological = rows
    .map((execution, sourceIndex) => ({ execution, sourceIndex }))
    .sort((left, right) =>
      left.execution.executedAt.localeCompare(right.execution.executedAt)
      || left.sourceIndex - right.sourceIndex,
    );
  const pendingBuys = new Map<string, PendingBuy[]>();
  const pairs: ExecutionTradePair[] = [];
  let pairSequence = 0;

  for (const { execution } of chronological) {
    if (!Number.isFinite(execution.quantity) || execution.quantity <= 0) continue;
    const key = executionScopeKey(execution);
    const queue = pendingBuys.get(key) ?? [];

    if (execution.side === "buy") {
      queue.push({ execution, remainingQuantity: execution.quantity });
      pendingBuys.set(key, queue);
      continue;
    }

    let remainingSellQuantity = execution.quantity;
    while (remainingSellQuantity > 0 && queue.length > 0) {
      const pendingBuy = queue[0];
      if (!pendingBuy) break;
      const matchedQuantity = Math.min(pendingBuy.remainingQuantity, remainingSellQuantity);
      pairs.push(makeExecutionTradePair({
        id: `matched:${pendingBuy.execution.id}:${execution.id}:${pairSequence++}`,
        status: "matched",
        quantity: matchedQuantity,
        buy: { execution: pendingBuy.execution, quantity: matchedQuantity },
        sell: { execution, quantity: matchedQuantity },
      }));
      pendingBuy.remainingQuantity -= matchedQuantity;
      remainingSellQuantity -= matchedQuantity;
      if (pendingBuy.remainingQuantity === 0) queue.shift();
    }

    if (remainingSellQuantity > 0) {
      pairs.push(makeExecutionTradePair({
        id: `unmatched-sell:${execution.id}:${pairSequence++}`,
        status: "unmatched-sell",
        quantity: remainingSellQuantity,
        buy: null,
        sell: { execution, quantity: remainingSellQuantity },
      }));
    }
  }

  for (const queue of pendingBuys.values()) {
    for (const pendingBuy of queue) {
      pairs.push(makeExecutionTradePair({
        id: `open-buy:${pendingBuy.execution.id}:${pairSequence++}`,
        status: "open-buy",
        quantity: pendingBuy.remainingQuantity,
        buy: { execution: pendingBuy.execution, quantity: pendingBuy.remainingQuantity },
        sell: null,
      }));
    }
  }

  return pairs
    .map((pair, sourceIndex) => ({ pair, sourceIndex }))
    .sort((left, right) =>
      right.pair.activityAt.localeCompare(left.pair.activityAt)
      || right.sourceIndex - left.sourceIndex,
    )
    .map(({ pair }) => pair);
}

export function summarizeExecutionTrades(
  pairs: readonly ExecutionTradePair[],
): ExecutionTradeSummary {
  return pairs.reduce<ExecutionTradeSummary>((summary, pair) => {
    if (pair.status === "matched") {
      summary.matchedLotCount += 1;
      summary.matchedQuantity += pair.quantity;
    } else if (pair.status === "open-buy") {
      summary.openBuyLotCount += 1;
      summary.openBuyQuantity += pair.quantity;
    } else {
      summary.unmatchedSellLotCount += 1;
      summary.unmatchedSellQuantity += pair.quantity;
    }
    return summary;
  }, {
    matchedLotCount: 0,
    openBuyLotCount: 0,
    unmatchedSellLotCount: 0,
    matchedQuantity: 0,
    openBuyQuantity: 0,
    unmatchedSellQuantity: 0,
  });
}

export function executionMarketLabel(exchange: ExecutionRow["exchange"]): string {
  if (exchange === "SOR") return "자동선택 (SOR)";
  return exchange ?? "—";
}

function executionScopeKey(execution: ExecutionRow): string {
  return [
    execution.brokerId,
    execution.environment,
    execution.accountIdMasked,
    execution.symbol,
  ].join("\u0000");
}

function makeExecutionTradePair(input: {
  id: string;
  status: ExecutionTradeStatus;
  quantity: number;
  buy: ExecutionTradeLeg | null;
  sell: ExecutionTradeLeg | null;
}): ExecutionTradePair {
  const reference = input.sell?.execution ?? input.buy?.execution;
  if (!reference) throw new Error("Execution trade pair requires at least one real execution");
  return {
    id: input.id,
    brokerId: reference.brokerId,
    environment: reference.environment,
    accountIdMasked: reference.accountIdMasked,
    symbol: reference.symbol,
    name: reference.name,
    status: input.status,
    quantity: input.quantity,
    buy: input.buy,
    sell: input.sell,
    activityAt: input.sell?.execution.executedAt ?? input.buy?.execution.executedAt ?? "",
  };
}
