import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createDerivativesAccountKey,
  derivativesOrderSide,
  type DerivativesAccountScope,
} from "@kstock/shared";
import {
  createInMemoryTradingRepository,
  openTradingRepository,
  type TradingRepository,
} from "../src/index.js";

const scope: DerivativesAccountScope = {
  providerId: "koreainvestment",
  product: "derivatives",
  environment: "live",
  accountId: "12345678",
  accountProductCode: "03",
};

const openRepositories: TradingRepository[] = [];
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const repository of openRepositories.splice(0)) repository.close();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function seed(repository: TradingRepository) {
  const account = repository.upsertDerivativesAccount({ scope, enabled: true });
  const contract = repository.upsertDerivativesContract({
    contract: {
      id: "kis-kospi200-202612",
      providerId: "koreainvestment",
      contractCode: "101S12",
      name: "코스피200 2026년 12월물",
      contractType: "FUTURE",
      underlyingCode: "KOSPI200",
      multiplierKrw: 250_000,
      priceScale: 100,
      expiryDate: "2026-12-10",
      active: true,
    },
  });
  return { account, contract };
}

describe("separate derivatives ledger", () => {
  it("builds a product-specific key and maps open/close long/short to broker sides", () => {
    expect(createDerivativesAccountKey(scope)).toContain("derivatives");
    expect(derivativesOrderSide("OPEN", "LONG")).toBe("buy");
    expect(derivativesOrderSide("CLOSE", "LONG")).toBe("sell");
    expect(derivativesOrderSide("OPEN", "SHORT")).toBe("sell");
    expect(derivativesOrderSide("CLOSE", "SHORT")).toBe("buy");
  });

  it("persists account, contract and idempotent long/short purpose orders", () => {
    const repository = createInMemoryTradingRepository();
    openRepositories.push(repository);
    const { account, contract } = seed(repository);
    const input = {
      id: "intent-hedge-1",
      orderId: "order-hedge-1",
      accountKey: account.accountKey,
      idempotencyKey: "hedge-target:v1:-2",
      clientOrderId: "hedge-client-1",
      contractId: contract.id,
      action: "OPEN" as const,
      direction: "SHORT" as const,
      purpose: "HEDGE" as const,
      quantity: 2,
      limitPriceTicks: 35_025,
      createdAt: "2026-09-05T01:00:00.000Z",
    };

    const first = repository.createDerivativesOrderIntent(input);
    const duplicate = repository.createDerivativesOrderIntent({
      ...input,
      id: "ignored-intent",
      orderId: "ignored-order",
      clientOrderId: "ignored-client",
    });

    expect(first.created).toBe(true);
    expect(first.order).toMatchObject({ purpose: "HEDGE", direction: "SHORT" });
    expect(first.order.orderedQuantity).toBe(2);
    expect(duplicate.created).toBe(false);
    expect(duplicate.order.id).toBe("order-hedge-1");
    expect(repository.listOpenDerivativesOrders(account.accountKey)).toHaveLength(1);
  });

  it("deduplicates executions and updates fill totals", () => {
    const repository = createInMemoryTradingRepository();
    openRepositories.push(repository);
    const { account, contract } = seed(repository);
    repository.createDerivativesOrderIntent({
      id: "intent-directional",
      orderId: "order-directional",
      accountKey: account.accountKey,
      idempotencyKey: "directional-long-1",
      clientOrderId: "directional-client-1",
      contractId: contract.id,
      action: "OPEN",
      direction: "LONG",
      purpose: "DIRECTIONAL",
      quantity: 2,
    });
    const fill = {
      id: "fill-1",
      accountKey: account.accountKey,
      orderId: "order-directional",
      brokerExecutionId: "execution-1",
      brokerOrderId: "broker-order-1",
      quantity: 1,
      priceTicks: 35_010,
      feeKrw: 1_200,
      executedAt: "2026-09-05T01:00:01.000Z",
    };

    expect(repository.recordDerivativesFill(fill)).toMatchObject({
      inserted: true,
      order: { status: "PARTIALLY_FILLED", filledQuantity: 1, remainingQuantity: 1 },
    });
    expect(repository.recordDerivativesFill({ ...fill, id: "ignored-fill" })).toMatchObject({
      inserted: false,
      fill: { id: "fill-1" },
    });
    expect(repository.recordDerivativesFill({
      ...fill,
      id: "fill-2",
      brokerExecutionId: "execution-2",
      quantity: 1,
      priceTicks: 35_020,
    })).toMatchObject({
      inserted: true,
      order: { status: "FILLED", filledQuantity: 2, remainingQuantity: 0 },
    });
  });

  it("detects whether hedge and directional allocations equal the broker net position", () => {
    const repository = createInMemoryTradingRepository();
    openRepositories.push(repository);
    const { account, contract } = seed(repository);
    repository.upsertDerivativesPosition({
      accountKey: account.accountKey,
      contractId: contract.id,
      netQuantity: -1,
      averagePriceTicks: 35_000,
      currentPriceTicks: 34_900,
      marginRequiredKrw: 15_000_000,
      unrealizedPnlKrw: 250_000,
      brokerUpdatedAt: "2026-09-05T01:00:00.000Z",
    });
    repository.replaceDerivativesPurposeLedger({
      accountKey: account.accountKey,
      contractId: contract.id,
      allocations: [
        { purpose: "HEDGE", signedQuantity: -2, averagePriceTicks: 35_000, realizedPnlKrw: 0 },
        { purpose: "DIRECTIONAL", signedQuantity: 1, averagePriceTicks: 34_950, realizedPnlKrw: 0 },
      ],
    });
    expect(repository.checkDerivativesPositionConsistency(account.accountKey, contract.id)).toMatchObject({
      brokerNetQuantity: -1,
      allocatedQuantity: -1,
      difference: 0,
      consistent: true,
    });

    repository.replaceDerivativesPurposeLedger({
      accountKey: account.accountKey,
      contractId: contract.id,
      allocations: [
        { purpose: "HEDGE", signedQuantity: -2, averagePriceTicks: 35_000, realizedPnlKrw: 0 },
      ],
    });
    expect(repository.checkDerivativesPositionConsistency(account.accountKey, contract.id)).toMatchObject({
      difference: -1,
      consistent: false,
    });
  });

  it("restores open orders, net positions, purpose allocations and hedge targets after restart", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "kstock-derivatives-recovery-"));
    temporaryDirectories.push(directory);
    const filename = path.join(directory, "ledger.sqlite3");
    const first = openTradingRepository(filename);
    const { account, contract } = seed(first);
    first.createDerivativesOrderIntent({
      id: "recovery-intent",
      orderId: "recovery-order",
      accountKey: account.accountKey,
      idempotencyKey: "recovery-key",
      clientOrderId: "recovery-client",
      contractId: contract.id,
      action: "OPEN",
      direction: "SHORT",
      purpose: "HEDGE",
      quantity: 3,
    });
    first.upsertDerivativesPosition({
      accountKey: account.accountKey,
      contractId: contract.id,
      netQuantity: -2,
      averagePriceTicks: 35_000,
      currentPriceTicks: 34_900,
      marginRequiredKrw: 20_000_000,
      unrealizedPnlKrw: 500_000,
      brokerUpdatedAt: "2026-09-05T01:10:00.000Z",
    });
    first.replaceDerivativesPurposeLedger({
      accountKey: account.accountKey,
      contractId: contract.id,
      allocations: [
        { purpose: "HEDGE", signedQuantity: -2, averagePriceTicks: 35_000, realizedPnlKrw: 0 },
      ],
    });
    first.upsertDerivativesHedgeTarget({
      accountKey: account.accountKey,
      contractId: contract.id,
      sourceEquityExposureKrw: 200_000_000,
      hedgeRatioBps: 8_000,
      targetSignedQuantity: -3,
      actualHedgeSignedQuantity: -2,
      inputHash: "cash-snapshot-hash",
      status: "REBALANCING",
    });
    first.close();

    const reopened = openTradingRepository(filename);
    openRepositories.push(reopened);
    expect(reopened.listOpenDerivativesOrders(account.accountKey)).toMatchObject([
      { id: "recovery-order", purpose: "HEDGE", direction: "SHORT" },
    ]);
    expect(reopened.listDerivativesPositions(account.accountKey)).toMatchObject([
      { contractId: contract.id, netQuantity: -2, marginRequiredKrw: 20_000_000 },
    ]);
    expect(reopened.listDerivativesPurposeLedger(account.accountKey)).toMatchObject([
      { purpose: "HEDGE", signedQuantity: -2 },
    ]);
    expect(reopened.listDerivativesHedgeTargets(account.accountKey)).toMatchObject([
      { targetSignedQuantity: -3, actualHedgeSignedQuantity: -2, status: "REBALANCING" },
    ]);
  });

  it("rejects non-integer quantities, multipliers and margin", () => {
    const repository = createInMemoryTradingRepository();
    openRepositories.push(repository);
    const { account, contract } = seed(repository);
    expect(() => repository.upsertDerivativesContract({
      contract: { ...contract, multiplierKrw: Number.POSITIVE_INFINITY },
    })).toThrow();
    expect(() => repository.createDerivativesOrderIntent({
      id: "bad-intent",
      accountKey: account.accountKey,
      idempotencyKey: "bad",
      clientOrderId: "bad-client",
      contractId: contract.id,
      action: "OPEN",
      direction: "LONG",
      purpose: "DIRECTIONAL",
      quantity: 0.5,
    })).toThrow();
    expect(() => repository.upsertDerivativesPosition({
      accountKey: account.accountKey,
      contractId: contract.id,
      netQuantity: 1,
      averagePriceTicks: 35_000,
      currentPriceTicks: 35_000,
      marginRequiredKrw: Number.NaN,
      unrealizedPnlKrw: 0,
      brokerUpdatedAt: "2026-09-05T01:00:00.000Z",
    })).toThrow();
  });
});
