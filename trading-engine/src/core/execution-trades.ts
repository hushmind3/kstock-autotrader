import type { BrokerId, Exchange, TradingEnvironment } from "@kstock/shared";

export interface DashboardExecutionRow {
  id: string;
  brokerId: BrokerId;
  environment: TradingEnvironment;
  accountIdMasked: string;
  brokerExecutionId: string;
  brokerOrderId: string;
  symbol: string;
  name: string;
  side: "buy" | "sell";
  quantity: number;
  price: number;
  grossAmount: number | null;
  fee: number;
  tax: number;
  exchange: Exchange | null;
  realizedPnl: number | null;
  executedAt: string;
}

export type DashboardExecutionTradeStatus = "matched" | "open-buy" | "unmatched-sell";

export interface DashboardExecutionTradeLeg {
  execution: DashboardExecutionRow;
  /** Quantity from this real execution allocated to this FIFO lot. */
  quantity: number;
}

export interface DashboardExecutionTradePair {
  id: string;
  brokerId: BrokerId;
  environment: TradingEnvironment;
  accountIdMasked: string;
  symbol: string;
  name: string;
  status: DashboardExecutionTradeStatus;
  quantity: number;
  buy: DashboardExecutionTradeLeg | null;
  sell: DashboardExecutionTradeLeg | null;
  /** Latest real execution time represented by this lot. */
  activityAt: string;
}

export interface PairableDashboardExecution {
  execution: DashboardExecutionRow;
  /** Durable receive time disambiguates executions with the same broker time. */
  receivedAt: string;
}

interface PendingBuy {
  execution: DashboardExecutionRow;
  remainingQuantity: number;
}

/**
 * Pairs one real account scope's complete supplied fill range as FIFO lots.
 * The caller deliberately invokes this once per unmasked AccountScope, so
 * masked account suffix collisions can never connect two different accounts.
 * No P&L is inferred here.
 */
export function pairAccountExecutionsFifo(
  rows: readonly PairableDashboardExecution[],
): DashboardExecutionTradePair[] {
  const chronological = rows
    .map((row, sourceIndex) => ({ ...row, sourceIndex }))
    .sort((left, right) =>
      left.execution.executedAt.localeCompare(right.execution.executedAt)
      || left.receivedAt.localeCompare(right.receivedAt)
      || left.execution.id.localeCompare(right.execution.id)
      || left.sourceIndex - right.sourceIndex,
    );
  const pendingBuys = new Map<string, PendingBuy[]>();
  const pairs: DashboardExecutionTradePair[] = [];
  let pairSequence = 0;

  for (const { execution } of chronological) {
    if (!Number.isFinite(execution.quantity) || execution.quantity <= 0) continue;
    const queue = pendingBuys.get(execution.symbol) ?? [];

    if (execution.side === "buy") {
      queue.push({ execution, remainingQuantity: execution.quantity });
      pendingBuys.set(execution.symbol, queue);
      continue;
    }

    let remainingSellQuantity = execution.quantity;
    while (remainingSellQuantity > 0 && queue.length > 0) {
      const pendingBuy = queue[0];
      if (!pendingBuy) break;
      const matchedQuantity = Math.min(pendingBuy.remainingQuantity, remainingSellQuantity);
      pairs.push(makePair({
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
      pairs.push(makePair({
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
      pairs.push(makePair({
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

function makePair(input: {
  id: string;
  status: DashboardExecutionTradeStatus;
  quantity: number;
  buy: DashboardExecutionTradeLeg | null;
  sell: DashboardExecutionTradeLeg | null;
}): DashboardExecutionTradePair {
  const reference = input.sell?.execution ?? input.buy?.execution;
  if (!reference) throw new Error("Execution trade pair requires a real execution");
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
