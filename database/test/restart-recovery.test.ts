import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { createDefaultSettings, type AccountScope } from "@kstock/shared";
import { LATEST_SCHEMA_VERSION, openTradingRepository } from "../src/index.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("SQLite restart recovery", () => {
  it("migrates existing intent routes into durable orders", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "kstock-route-migration-"));
    temporaryDirectories.push(directory);
    const filename = path.join(directory, "ledger.sqlite3");
    const legacy = new Database(filename);
    legacy.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
      INSERT INTO schema_migrations VALUES
        (1, 'initial_trading_store', '2026-09-01T00:00:00.000Z'),
        (2, 'broker_order_ids_are_unique_per_trading_day', '2026-09-01T00:00:00.000Z');
      CREATE TABLE latest_quotes (
        source_broker_id TEXT NOT NULL,
        symbol TEXT NOT NULL
      );
      CREATE TABLE order_intents (
        id TEXT PRIMARY KEY,
        exchange TEXT NOT NULL
      );
      CREATE TABLE orders (
        id TEXT PRIMARY KEY,
        intent_id TEXT,
        broker_id TEXT NOT NULL,
        environment TEXT NOT NULL,
        account_id TEXT NOT NULL,
        symbol TEXT NOT NULL,
        side TEXT NOT NULL,
        remaining_quantity INTEGER NOT NULL,
        status TEXT NOT NULL
      );
      CREATE UNIQUE INDEX ux_orders_active_guard
        ON orders (broker_id, environment, account_id, symbol, side)
        WHERE status IN (
          'QUEUED', 'SENDING', 'ACKED', 'PARTIALLY_FILLED',
          'CANCEL_REQUESTED', 'AMEND_REQUESTED', 'AMENDED', 'UNKNOWN'
        );
      INSERT INTO order_intents VALUES ('intent-sor', 'SOR');
      INSERT INTO orders VALUES (
        'local-order', 'intent-sor', 'kiwoom', 'paper', '12345678',
        '005930', 'buy', 0, 'UNKNOWN'
      );
      INSERT INTO orders VALUES (
        'external-order', NULL, 'kiwoom', 'paper', '12345678',
        '000660', 'buy', 0, 'UNKNOWN'
      );
    `);
    legacy.close();

    const migrated = openTradingRepository(filename);
    const rows = migrated.database
      .prepare("SELECT id, exchange FROM orders ORDER BY id")
      .all() as Array<{ id: string; exchange: string }>;
    expect(migrated.schemaVersion).toBe(LATEST_SCHEMA_VERSION);
    expect(rows).toEqual([
      { id: "external-order", exchange: "KRX" },
      { id: "local-order", exchange: "SOR" },
    ]);
    migrated.close();
  });

  it("restores persisted settings, positions and an unsent order outbox", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "kstock-recovery-"));
    temporaryDirectories.push(directory);
    const filename = path.join(directory, "ledger.sqlite3");
    const scope: AccountScope = {
      brokerId: "koreainvestment",
      environment: "paper",
      accountId: "12345678-01",
    };

    const first = openTradingRepository(filename);
    const settings = createDefaultSettings();
    settings.brokers.koreainvestment.enabled = true;
    first.setAppSettings(settings);
    first.replacePositions({
      scope,
      fetchedAt: "2026-08-31T01:00:00.000Z",
      positions: [{
        symbol: "005930",
        name: "삼성전자",
        quantity: 2,
        availableQuantity: 2,
        averagePrice: 70_000,
        currentPrice: 71_000,
        marketValue: 142_000,
        unrealizedPnl: 2_000,
        unrealizedPnlBps: 143,
      }],
    });
    first.createOrderIntent({
      id: "intent-recovery",
      orderId: "order-recovery",
      outboxId: "outbox-recovery",
      scope,
      idempotencyKey: "restart-decision",
      request: {
        clientOrderId: "client-recovery",
        symbol: "000660",
        side: "buy",
        orderType: "limit",
        quantity: 1,
        limitPrice: 200_000,
        exchange: "SOR",
      },
    });
    first.close();

    const reopened = openTradingRepository(filename);
    expect(reopened.getAppSettings()).toMatchObject({
      emergencyHalt: true,
      brokers: { koreainvestment: { enabled: true } },
    });
    expect(reopened.listPositions(scope)).toMatchObject([{ symbol: "005930", quantity: 2 }]);
    expect(reopened.getOrder("order-recovery", scope)).toMatchObject({
      status: "QUEUED",
      exchange: "SOR",
    });
    expect(reopened.listOutbox({ scope, statuses: ["PENDING"] })).toMatchObject([
      { id: "outbox-recovery", aggregateId: "intent-recovery" },
    ]);
    reopened.close();
  });
});
