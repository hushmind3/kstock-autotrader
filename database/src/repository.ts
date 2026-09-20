import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import {
  createDerivativesAccountKey,
  redactSensitive,
  stableHash,
  toIsoDateTime,
  type AccountScope,
  type AppSettings,
  type BrokerHealth,
  type BrokerId,
  type BrokerOrder,
  type BrokerPosition,
  type DailyBar,
  type DerivativesAccountKey,
  type DerivativesPositionPurpose,
  type Instrument,
  type OrderStatus,
  type Quote,
} from "@kstock/shared";
import {
  configureDatabase,
  LATEST_SCHEMA_VERSION,
  migrateDatabase,
  quickCheck,
} from "./migrations.js";
import {
  ActiveOrderConflictError,
  InvalidOrderTransitionError,
  RecordNotFoundError,
  RiskBudgetExceededError,
  type AcquireEngineLeaseInput,
  type AppendAuditInput,
  type AppendErrorInput,
  type ApplyOrderEventInput,
  type ApplyOrderEventResult,
  type AssignStrategyInput,
  type AuditLogRecord,
  type BalanceSnapshotRecord,
  type ClaimOutboxOptions,
  type CreateOrderIntentInput,
  type CreateOrderIntentResult,
  type CreateStrategyConfigVersionInput,
  type DailyPnlRecord,
  type ApplyDerivativesOrderUpdateInput,
  type CreateDerivativesOrderIntentInput,
  type CreateDerivativesOrderIntentResult,
  type DerivativesAccountRecord,
  type DerivativesContractRecord,
  type DerivativesFillRecord,
  type DerivativesHedgeTargetRecord,
  type DerivativesOrderIntentRecord,
  type DerivativesOrderRecord,
  type DerivativesPositionConsistency,
  type DerivativesPositionRecord,
  type DerivativesPurposeLedgerRecord,
  type EngineLeaseRecord,
  type ErrorLogRecord,
  type FillRecord,
  type HealthEventRecord,
  type InsertSignalInput,
  type OrderEventRecord,
  type OrderIntentRecord,
  type OrderListFilter,
  type OrderRecord,
  type OutboxRecord,
  type PositionReplacementInput,
  type ReconciledOrderInput,
  type RecordExecutionInput,
  type RecordExecutionResult,
  type RecordDerivativesFillInput,
  type ReplaceDerivativesPurposeLedgerInput,
  type RiskReservationRecord,
  type RuntimeScope,
  type SaveBalanceSnapshotInput,
  type SignalRecord,
  type StrategyAssignmentRecord,
  type StrategyConfigVersionRecord,
  type TradingRepositoryOptions,
  type UpsertDerivativesAccountInput,
  type UpsertDerivativesContractInput,
  type UpsertDerivativesHedgeTargetInput,
  type UpsertDerivativesPositionInput,
  type UpsertDailyPnlInput,
} from "./types.js";

type SqlRow = Record<string, unknown>;

const ACTIVE_ORDER_STATUSES: readonly OrderStatus[] = [
  "QUEUED",
  "SENDING",
  "ACKED",
  "PARTIALLY_FILLED",
  "CANCEL_REQUESTED",
  "AMEND_REQUESTED",
  "AMENDED",
  "UNKNOWN",
];

const TERMINAL_ORDER_STATUSES = new Set<OrderStatus>([
  "FILLED",
  "CANCELED",
  "REJECTED",
]);

const ALLOWED_TRANSITIONS: Readonly<Record<OrderStatus, ReadonlySet<OrderStatus>>> = {
  QUEUED: new Set([
    "QUEUED",
    "SENDING",
    "ACKED",
    "PARTIALLY_FILLED",
    "FILLED",
    "CANCEL_REQUESTED",
    "REJECTED",
    "UNKNOWN",
  ]),
  SENDING: new Set([
    "SENDING",
    "ACKED",
    "PARTIALLY_FILLED",
    "FILLED",
    "CANCEL_REQUESTED",
    "REJECTED",
    "UNKNOWN",
  ]),
  ACKED: new Set([
    "ACKED",
    "PARTIALLY_FILLED",
    "FILLED",
    "CANCEL_REQUESTED",
    "CANCELED",
    "AMEND_REQUESTED",
    "AMENDED",
    "UNKNOWN",
  ]),
  PARTIALLY_FILLED: new Set([
    "PARTIALLY_FILLED",
    "FILLED",
    "CANCEL_REQUESTED",
    "CANCELED",
    "AMEND_REQUESTED",
    "AMENDED",
    "UNKNOWN",
  ]),
  FILLED: new Set(["FILLED"]),
  CANCEL_REQUESTED: new Set([
    "CANCEL_REQUESTED",
    "ACKED",
    "PARTIALLY_FILLED",
    "FILLED",
    "CANCELED",
    "UNKNOWN",
  ]),
  CANCELED: new Set(["CANCELED"]),
  AMEND_REQUESTED: new Set([
    "AMEND_REQUESTED",
    "ACKED",
    "PARTIALLY_FILLED",
    "FILLED",
    "AMENDED",
    "CANCELED",
    "UNKNOWN",
  ]),
  AMENDED: new Set([
    "AMENDED",
    "PARTIALLY_FILLED",
    "FILLED",
    "CANCEL_REQUESTED",
    "CANCELED",
    "AMEND_REQUESTED",
    "UNKNOWN",
  ]),
  REJECTED: new Set(["REJECTED"]),
  UNKNOWN: new Set([
    "UNKNOWN",
    "ACKED",
    "PARTIALLY_FILLED",
    "FILLED",
    "CANCEL_REQUESTED",
    "CANCELED",
    "AMEND_REQUESTED",
    "AMENDED",
    "REJECTED",
  ]),
};

export class TradingRepository {
  readonly database: Database.Database;
  readonly schemaVersion: number;

  constructor(options: TradingRepositoryOptions | string) {
    const normalized: TradingRepositoryOptions =
      typeof options === "string" ? { filename: options } : options;
    const shouldEnsureDirectory = normalized.ensureDirectory ?? true;
    if (
      shouldEnsureDirectory &&
      normalized.filename !== ":memory:" &&
      !normalized.filename.startsWith("file:")
    ) {
      mkdirSync(dirname(normalized.filename), { recursive: true });
    }

    const openOptions: Database.Options = {
      timeout: normalized.busyTimeoutMs ?? 5_000,
    };
    if (normalized.readonly !== undefined) openOptions.readonly = normalized.readonly;
    if (normalized.fileMustExist !== undefined) {
      openOptions.fileMustExist = normalized.fileMustExist;
    }
    this.database = new Database(normalized.filename, openOptions);
    if (!normalized.readonly && normalized.filename !== ":memory:" && !normalized.filename.startsWith("file:")) {
      try {
        chmodSync(normalized.filename, 0o600);
      } catch {
        // Some Windows filesystems do not expose POSIX mode bits; directory ACLs
        // and Credential Manager remain the protection boundary there.
      }
    }

    if (normalized.readonly) {
      this.database.pragma("foreign_keys = ON");
      this.database.pragma(`busy_timeout = ${normalized.busyTimeoutMs ?? 5_000}`);
      quickCheck(this.database);
      const row = this.database
        .prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations")
        .get() as { version: number };
      this.schemaVersion = row.version;
    } else {
      configureDatabase(this.database, normalized.busyTimeoutMs ?? 5_000);
      quickCheck(this.database);
      this.schemaVersion = migrateDatabase(this.database);
      quickCheck(this.database);
    }

    if (this.schemaVersion !== LATEST_SCHEMA_VERSION) {
      throw new Error(
        `Expected database schema ${LATEST_SCHEMA_VERSION}, found ${this.schemaVersion}`,
      );
    }
  }

  close(): void {
    if (this.database.open) this.database.close();
  }

  runQuickCheck(): void {
    quickCheck(this.database);
  }

  getSetting<T>(key: string): T | null {
    const row = this.database
      .prepare("SELECT value_json FROM settings WHERE key = ?")
      .get(key) as SqlRow | undefined;
    return row ? parseJson<T>(row.value_json) : null;
  }

  setSetting<T>(key: string, value: T, schemaVersion = 1, updatedAt = toIsoDateTime()): void {
    assertPositiveInteger("schemaVersion", schemaVersion);
    this.database
      .prepare(
        `INSERT INTO settings (key, value_json, schema_version, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           value_json = excluded.value_json,
           schema_version = excluded.schema_version,
           updated_at = excluded.updated_at`,
      )
      .run(key, stringifyJson(value), schemaVersion, updatedAt);
  }

  deleteSetting(key: string): boolean {
    return this.database.prepare("DELETE FROM settings WHERE key = ?").run(key).changes > 0;
  }

  getAppSettings(): AppSettings | null {
    return this.getSetting<AppSettings>("app");
  }

  setAppSettings(settings: AppSettings, updatedAt = toIsoDateTime()): void {
    this.setSetting("app", settings, settings.schemaVersion, updatedAt);
  }

  upsertInstruments(instruments: readonly Instrument[], receivedAt = toIsoDateTime()): void {
    const statement = this.database.prepare(
      `INSERT INTO instruments (
         symbol, name, market, exchange, active, listed_date, delisted_date,
         raw_json, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(symbol) DO UPDATE SET
         name = excluded.name,
         market = excluded.market,
         exchange = excluded.exchange,
         active = excluded.active,
         listed_date = excluded.listed_date,
         delisted_date = excluded.delisted_date,
         raw_json = excluded.raw_json,
         updated_at = excluded.updated_at`,
    );
    const write = this.database.transaction(() => {
      for (const instrument of instruments) {
        statement.run(
          instrument.symbol,
          instrument.name,
          instrument.market,
          instrument.exchange,
          toSqlBoolean(instrument.active),
          instrument.listedDate ?? null,
          instrument.delistedDate ?? null,
          instrument.raw === undefined ? null : stringifySafeJson(instrument.raw),
          receivedAt,
          receivedAt,
        );
      }
    });
    write.immediate();
  }

  getInstrument(symbol: string): Instrument | null {
    const row = this.database
      .prepare("SELECT * FROM instruments WHERE symbol = ?")
      .get(symbol) as SqlRow | undefined;
    return row ? mapInstrument(row) : null;
  }

  listInstruments(active?: boolean): Instrument[] {
    const rows = (
      active === undefined
        ? this.database.prepare("SELECT * FROM instruments ORDER BY symbol").all()
        : this.database
            .prepare("SELECT * FROM instruments WHERE active = ? ORDER BY symbol")
            .all(toSqlBoolean(active))
    ) as SqlRow[];
    return rows.map(mapInstrument);
  }

  upsertDailyBars(
    bars: readonly DailyBar[],
    sourceBrokerId: BrokerId,
    receivedAt = toIsoDateTime(),
  ): void {
    const statement = this.database.prepare(
      `INSERT INTO daily_bars (
         symbol, trading_date, open_krw, high_krw, low_krw, close_krw,
         volume, adjusted, source_broker_id, received_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(symbol, trading_date) DO UPDATE SET
         open_krw = excluded.open_krw,
         high_krw = excluded.high_krw,
         low_krw = excluded.low_krw,
         close_krw = excluded.close_krw,
         volume = excluded.volume,
         adjusted = excluded.adjusted,
         source_broker_id = excluded.source_broker_id,
         received_at = excluded.received_at`,
    );
    const write = this.database.transaction(() => {
      for (const bar of bars) {
        assertNonNegativeInteger("bar.open", bar.open);
        assertNonNegativeInteger("bar.high", bar.high);
        assertNonNegativeInteger("bar.low", bar.low);
        assertNonNegativeInteger("bar.close", bar.close);
        assertNonNegativeInteger("bar.volume", bar.volume);
        statement.run(
          bar.symbol,
          bar.tradingDate,
          bar.open,
          bar.high,
          bar.low,
          bar.close,
          bar.volume,
          toSqlBoolean(bar.adjusted),
          sourceBrokerId,
          receivedAt,
        );
      }
    });
    write.immediate();
  }

  listDailyBars(
    symbol: string,
    options: { limit?: number; throughDate?: string; ascending?: boolean } = {},
  ): DailyBar[] {
    const limit = normalizeLimit(options.limit, 500, 10_000);
    const rows = (
      options.throughDate
        ? this.database
            .prepare(
              `SELECT * FROM daily_bars
               WHERE symbol = ? AND trading_date <= ?
               ORDER BY trading_date DESC LIMIT ?`,
            )
            .all(symbol, options.throughDate, limit)
        : this.database
            .prepare(
              `SELECT * FROM daily_bars
               WHERE symbol = ? ORDER BY trading_date DESC LIMIT ?`,
            )
            .all(symbol, limit)
    ) as SqlRow[];
    const mapped = rows.map(mapDailyBar);
    return options.ascending === false ? mapped : mapped.reverse();
  }

  upsertLatestQuote(quote: Quote): void {
    assertNonNegativeInteger("quote.price", quote.price);
    assertNonNegativeInteger("quote.cumulativeVolume", quote.cumulativeVolume);
    if (quote.open !== undefined) assertNonNegativeInteger("quote.open", quote.open);
    if (quote.high !== undefined) assertNonNegativeInteger("quote.high", quote.high);
    if (quote.low !== undefined) assertNonNegativeInteger("quote.low", quote.low);
    this.database
      .prepare(
        `INSERT INTO latest_quotes (
           source_broker_id, symbol, price_krw, open_krw, high_krw, low_krw,
           cumulative_volume, trading_date, trading_time, received_at, stale, exchange
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(source_broker_id, symbol) DO UPDATE SET
           price_krw = excluded.price_krw,
           open_krw = excluded.open_krw,
           high_krw = excluded.high_krw,
           low_krw = excluded.low_krw,
           cumulative_volume = excluded.cumulative_volume,
           trading_date = excluded.trading_date,
           trading_time = excluded.trading_time,
           received_at = excluded.received_at,
           stale = excluded.stale,
           exchange = excluded.exchange
         WHERE excluded.received_at >= latest_quotes.received_at`,
      )
      .run(
        quote.source,
        quote.symbol,
        quote.price,
        quote.open ?? null,
        quote.high ?? null,
        quote.low ?? null,
        quote.cumulativeVolume,
        quote.tradingDate,
        quote.tradingTime,
        quote.receivedAt,
        toSqlBoolean(quote.stale ?? false),
        quote.exchange ?? "KRX",
      );
  }

  getLatestQuote(symbol: string, sourceBrokerId?: BrokerId): Quote | null {
    const row = (
      sourceBrokerId
        ? this.database
            .prepare(
              `SELECT * FROM latest_quotes
               WHERE symbol = ? AND source_broker_id = ?`,
            )
            .get(symbol, sourceBrokerId)
        : this.database
            .prepare(
              `SELECT * FROM latest_quotes
               WHERE symbol = ? ORDER BY received_at DESC LIMIT 1`,
            )
            .get(symbol)
    ) as SqlRow | undefined;
    return row ? mapQuote(row) : null;
  }

  listLatestQuotes(sourceBrokerId?: BrokerId): Quote[] {
    const rows = (
      sourceBrokerId
        ? this.database
            .prepare(
              `SELECT * FROM latest_quotes
               WHERE source_broker_id = ? ORDER BY symbol`,
            )
            .all(sourceBrokerId)
        : this.database.prepare("SELECT * FROM latest_quotes ORDER BY symbol, source_broker_id").all()
    ) as SqlRow[];
    return rows.map(mapQuote);
  }

  createStrategyConfigVersion(
    input: CreateStrategyConfigVersionInput,
  ): StrategyConfigVersionRecord {
    const create = this.database.transaction(() => {
      const configHash = input.configHash ?? stableHash(input.config);
      const duplicate = this.database
        .prepare(
          `SELECT * FROM strategy_config_versions
           WHERE strategy_id = ? AND strategy_version = ? AND config_hash = ?`,
        )
        .get(input.strategyId, input.strategyVersion, configHash) as SqlRow | undefined;
      if (duplicate) return mapStrategyConfig(duplicate);

      const configVersion =
        input.configVersion ??
        ((this.database
          .prepare(
            `SELECT COALESCE(MAX(config_version), 0) + 1 AS next_version
             FROM strategy_config_versions WHERE strategy_id = ?`,
          )
          .get(input.strategyId) as { next_version: number }).next_version);
      assertPositiveInteger("configVersion", configVersion);
      const createdAt = input.createdAt ?? toIsoDateTime();
      this.database
        .prepare(
          `INSERT INTO strategy_config_versions (
             id, strategy_id, strategy_version, config_version,
             config_hash, config_json, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.id,
          input.strategyId,
          input.strategyVersion,
          configVersion,
          configHash,
          stringifyJson(input.config),
          createdAt,
        );
      return this.requireStrategyConfig(input.id);
    });
    return create.immediate();
  }

  getStrategyConfigVersion(id: string): StrategyConfigVersionRecord | null {
    const row = this.database
      .prepare("SELECT * FROM strategy_config_versions WHERE id = ?")
      .get(id) as SqlRow | undefined;
    return row ? mapStrategyConfig(row) : null;
  }

  listStrategyConfigVersions(strategyId?: string): StrategyConfigVersionRecord[] {
    const rows = (
      strategyId
        ? this.database
            .prepare(
              `SELECT * FROM strategy_config_versions
               WHERE strategy_id = ? ORDER BY config_version DESC`,
            )
            .all(strategyId)
        : this.database
            .prepare(
              `SELECT * FROM strategy_config_versions
               ORDER BY strategy_id, config_version DESC`,
            )
            .all()
    ) as SqlRow[];
    return rows.map(mapStrategyConfig);
  }

  assignStrategy(input: AssignStrategyInput): StrategyAssignmentRecord {
    const now = input.assignedAt ?? toIsoDateTime();
    this.requireStrategyConfig(input.strategyConfigId);
    this.database
      .prepare(
        `INSERT INTO strategy_assignments (
           broker_id, environment, account_id, strategy_config_id,
           enabled, assigned_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(broker_id, environment, account_id) DO UPDATE SET
           strategy_config_id = excluded.strategy_config_id,
           enabled = excluded.enabled,
           assigned_at = excluded.assigned_at,
           updated_at = excluded.updated_at`,
      )
      .run(
        ...scopeParameters(input.scope),
        input.strategyConfigId,
        toSqlBoolean(input.enabled),
        now,
        now,
      );
    return this.getStrategyAssignment(input.scope) as StrategyAssignmentRecord;
  }

  getStrategyAssignment(scope: AccountScope): StrategyAssignmentRecord | null {
    const row = this.database
      .prepare(
        `SELECT * FROM strategy_assignments
         WHERE broker_id = ? AND environment = ? AND account_id = ?`,
      )
      .get(...scopeParameters(scope)) as SqlRow | undefined;
    return row ? mapStrategyAssignment(row) : null;
  }

  listStrategyAssignments(): StrategyAssignmentRecord[] {
    return (this.database
      .prepare(
        `SELECT * FROM strategy_assignments
         ORDER BY broker_id, environment, account_id`,
      )
      .all() as SqlRow[]).map(mapStrategyAssignment);
  }

  insertSignal(input: InsertSignalInput): { inserted: boolean; signal: SignalRecord } {
    const createdAt = input.createdAt ?? toIsoDateTime();
    const result = this.database
      .prepare(
        `INSERT OR IGNORE INTO signals (
           id, broker_id, environment, account_id, strategy_config_id,
           symbol, action, reason_codes_json, metrics_json, input_hash,
           observed_at, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        ...scopeParameters(input.scope),
        input.strategyConfigId,
        input.symbol,
        input.action,
        stringifyJson(input.reasonCodes),
        stringifyJson(input.metrics),
        input.inputHash,
        input.observedAt,
        createdAt,
      );
    const row = (
      result.changes > 0
        ? this.database.prepare("SELECT * FROM signals WHERE id = ?").get(input.id)
        : this.database
            .prepare(
              `SELECT * FROM signals
               WHERE broker_id = ? AND environment = ? AND account_id = ?
                 AND strategy_config_id = ? AND symbol = ? AND action = ? AND input_hash = ?`,
            )
            .get(
              ...scopeParameters(input.scope),
              input.strategyConfigId,
              input.symbol,
              input.action,
              input.inputHash,
            )
    ) as SqlRow;
    return { inserted: result.changes > 0, signal: mapSignal(row) };
  }

  listSignals(
    scope: AccountScope,
    options: { since?: string; actions?: string[]; limit?: number } = {},
  ): SignalRecord[] {
    const where = ["broker_id = ?", "environment = ?", "account_id = ?"];
    const parameters: unknown[] = [...scopeParameters(scope)];
    if (options.since) {
      where.push("observed_at >= ?");
      parameters.push(options.since);
    }
    if (options.actions && options.actions.length > 0) {
      where.push(`action IN (${placeholders(options.actions.length)})`);
      parameters.push(...options.actions);
    }
    parameters.push(normalizeLimit(options.limit, 200, 10_000));
    return (this.database
      .prepare(
        `SELECT * FROM signals WHERE ${where.join(" AND ")}
         ORDER BY observed_at DESC LIMIT ?`,
      )
      .all(...parameters) as SqlRow[]).map(mapSignal);
  }

  createOrderIntent(input: CreateOrderIntentInput): CreateOrderIntentResult {
    validatePlaceOrder(input.request);
    const create = this.database.transaction(() => {
      const existing = this.database
        .prepare(
          `SELECT * FROM order_intents
           WHERE broker_id = ? AND environment = ? AND account_id = ?
             AND idempotency_key = ?`,
        )
        .get(...scopeParameters(input.scope), input.idempotencyKey) as SqlRow | undefined;
      if (existing) {
        const intent = mapOrderIntent(existing);
        const order = this.requireOrderByIntent(intent.id);
        const outbox = this.requireOutboxByAggregate("order_intent", intent.id);
        return { created: false, intent, order, outbox };
      }

      const conflict = this.findActiveOrder(input.scope, input.request.symbol, input.request.side);
      if (conflict) {
        throw new ActiveOrderConflictError(
          input.scope,
          input.request.symbol,
          input.request.side,
        );
      }

      if (input.reservation) {
        assertNonNegativeInteger("reservation.amount", input.reservation.amount);
        const active = this.getActiveReservedAmount(
          input.scope,
          input.reservation.budgetKey,
        );
        const committed = input.reservation.committedAmount ?? 0;
        assertNonNegativeInteger("reservation.committedAmount", committed);
        const attempted = active + committed + input.reservation.amount;
        if (
          input.reservation.maximumActiveAmount !== undefined &&
          attempted > input.reservation.maximumActiveAmount
        ) {
          throw new RiskBudgetExceededError(
            input.scope,
            input.reservation.budgetKey,
            attempted,
            input.reservation.maximumActiveAmount,
          );
        }
      }

      const now = input.createdAt ?? toIsoDateTime();
      const orderId = input.orderId ?? input.id;
      this.database
        .prepare(
          `INSERT INTO order_intents (
             id, broker_id, environment, account_id, signal_id,
             idempotency_key, client_order_id, symbol, side, order_type,
             quantity, limit_price_krw, exchange, status, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'QUEUED', ?, ?)`,
        )
        .run(
          input.id,
          ...scopeParameters(input.scope),
          input.signalId ?? null,
          input.idempotencyKey,
          input.request.clientOrderId,
          input.request.symbol,
          input.request.side,
          input.request.orderType,
          input.request.quantity,
          input.request.limitPrice ?? null,
          input.request.exchange,
          now,
          now,
        );

      this.database
        .prepare(
          `INSERT INTO orders (
             id, intent_id, broker_id, environment, account_id,
             symbol, side, order_type, exchange, ordered_quantity, filled_quantity,
             remaining_quantity, limit_price_krw, status, ordered_at,
             revision, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, 'QUEUED', ?, 0, ?, ?)`,
        )
        .run(
          orderId,
          input.id,
          ...scopeParameters(input.scope),
          input.request.symbol,
          input.request.side,
          input.request.orderType,
          input.request.exchange,
          input.request.quantity,
          input.request.quantity,
          input.request.limitPrice ?? null,
          now,
          now,
          now,
        );

      this.database
        .prepare(
          `INSERT INTO order_events (
             broker_id, environment, account_id, order_id, dedupe_key,
             event_type, from_status, to_status, event_at, received_at, payload_json
           ) VALUES (?, ?, ?, ?, ?, 'INTENT_CREATED', NULL, 'QUEUED', ?, ?, ?)`,
        )
        .run(
          ...scopeParameters(input.scope),
          orderId,
          `intent:${input.id}`,
          now,
          now,
          stringifySafeJson({ request: input.request, signalId: input.signalId ?? null }),
        );

      if (input.reservation) {
        this.database
          .prepare(
            `INSERT INTO risk_reservations (
               intent_id, broker_id, environment, account_id, budget_key,
               amount_krw, status, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?)`,
          )
          .run(
            input.id,
            ...scopeParameters(input.scope),
            input.reservation.budgetKey,
            input.reservation.amount,
            now,
            now,
          );
      }

      this.database
        .prepare(
          `INSERT INTO outbox (
             id, broker_id, environment, account_id, aggregate_type,
             aggregate_id, event_type, dedupe_key, payload_json, status,
             attempts, available_at, created_at, updated_at
           ) VALUES (?, ?, ?, ?, 'order_intent', ?, 'SUBMIT_ORDER', ?, ?, 'PENDING', 0, ?, ?, ?)`,
        )
        .run(
          input.outboxId,
          ...scopeParameters(input.scope),
          input.id,
          `submit:${input.idempotencyKey}`,
          stringifySafeJson(input.outboxPayload ?? input.request),
          now,
          now,
          now,
        );

      return {
        created: true,
        intent: this.requireOrderIntent(input.id),
        order: this.requireOrder(orderId, input.scope),
        outbox: this.requireOutbox(input.outboxId),
      };
    });
    return create.immediate();
  }

  getOrderIntent(id: string): OrderIntentRecord | null {
    const row = this.database
      .prepare("SELECT * FROM order_intents WHERE id = ?")
      .get(id) as SqlRow | undefined;
    return row ? mapOrderIntent(row) : null;
  }

  getOrder(id: string, scope?: AccountScope): OrderRecord | null {
    const row = (
      scope
        ? this.database
            .prepare(
              `SELECT * FROM orders WHERE id = ?
               AND broker_id = ? AND environment = ? AND account_id = ?`,
            )
            .get(id, ...scopeParameters(scope))
        : this.database.prepare("SELECT * FROM orders WHERE id = ?").get(id)
    ) as SqlRow | undefined;
    return row ? mapOrder(row) : null;
  }

  findOrderByBrokerId(
    scope: AccountScope,
    brokerOrderId: string,
    occurredAt?: string,
  ): OrderRecord | null {
    const row = (
      occurredAt
        ? this.database
            .prepare(
              `SELECT * FROM orders
               WHERE broker_id = ? AND environment = ? AND account_id = ?
                 AND broker_order_id = ?
                 AND substr(ordered_at, 1, 10) = substr(?, 1, 10)
               ORDER BY ordered_at DESC LIMIT 1`,
            )
            .get(...scopeParameters(scope), brokerOrderId, occurredAt)
        : this.database
            .prepare(
              `SELECT * FROM orders
               WHERE broker_id = ? AND environment = ? AND account_id = ?
                 AND broker_order_id = ?
               ORDER BY ordered_at DESC LIMIT 1`,
            )
            .get(...scopeParameters(scope), brokerOrderId)
    ) as SqlRow | undefined;
    return row ? mapOrder(row) : null;
  }

  listOrders(scope: AccountScope, filter: OrderListFilter = {}): OrderRecord[] {
    const where = ["broker_id = ?", "environment = ?", "account_id = ?"];
    const parameters: unknown[] = [...scopeParameters(scope)];
    if (filter.statuses && filter.statuses.length > 0) {
      where.push(`status IN (${placeholders(filter.statuses.length)})`);
      parameters.push(...filter.statuses);
    }
    if (filter.symbol) {
      where.push("symbol = ?");
      parameters.push(filter.symbol);
    }
    if (filter.updatedFrom) {
      where.push("updated_at >= ?");
      parameters.push(filter.updatedFrom);
    }
    parameters.push(normalizeLimit(filter.limit, 500, 20_000));
    return (this.database
      .prepare(
        `SELECT * FROM orders WHERE ${where.join(" AND ")}
         ORDER BY updated_at DESC LIMIT ?`,
      )
      .all(...parameters) as SqlRow[]).map(mapOrder);
  }

  listOpenOrders(scope: AccountScope): OrderRecord[] {
    return this.listOrders(scope, { statuses: [...ACTIVE_ORDER_STATUSES], limit: 20_000 })
      .filter((order) => order.remainingQuantity > 0);
  }

  applyOrderEvent(input: ApplyOrderEventInput): ApplyOrderEventResult {
    const apply = this.database.transaction(() => this.applyOrderEventUnsafe(input));
    return apply.immediate();
  }

  listOrderEvents(
    scope: AccountScope,
    options: { orderId?: string; afterId?: number; limit?: number } = {},
  ): OrderEventRecord[] {
    const where = ["broker_id = ?", "environment = ?", "account_id = ?"];
    const parameters: unknown[] = [...scopeParameters(scope)];
    if (options.orderId) {
      where.push("order_id = ?");
      parameters.push(options.orderId);
    }
    if (options.afterId !== undefined) {
      where.push("id > ?");
      parameters.push(options.afterId);
    }
    parameters.push(normalizeLimit(options.limit, 1_000, 20_000));
    return (this.database
      .prepare(
        `SELECT * FROM order_events WHERE ${where.join(" AND ")}
         ORDER BY id ASC LIMIT ?`,
      )
      .all(...parameters) as SqlRow[]).map(mapOrderEvent);
  }

  upsertReconciledOrder(input: ReconciledOrderInput): OrderRecord {
    const reconcile = this.database.transaction(() => {
      const brokerOrder = input.brokerOrder;
      validateBrokerOrder(brokerOrder);
      let existing = this.findOrderByBrokerId(
        input.scope,
        brokerOrder.brokerOrderId,
        brokerOrder.orderedAt,
      );
      if (!existing) {
        const correlated = this.database
          .prepare(
            `SELECT * FROM orders
             WHERE broker_id = ? AND environment = ? AND account_id = ?
               AND broker_order_id IS NULL
               AND symbol = ? AND side = ? AND order_type = ?
               AND ordered_quantity = ?
               AND COALESCE(limit_price_krw, -1) = COALESCE(?, -1)
               AND status IN (
                 'QUEUED', 'SENDING', 'ACKED', 'PARTIALLY_FILLED',
                 'CANCEL_REQUESTED', 'AMEND_REQUESTED', 'AMENDED', 'UNKNOWN'
               )
             ORDER BY created_at ASC LIMIT 1`,
          )
          .get(
            ...scopeParameters(input.scope),
            brokerOrder.symbol,
            brokerOrder.side,
            brokerOrder.orderType,
            brokerOrder.orderedQuantity,
            brokerOrder.limitPrice ?? null,
          ) as SqlRow | undefined;
        existing = correlated ? mapOrder(correlated) : null;
      }

      const receivedAt = input.receivedAt ?? toIsoDateTime();

      if (existing) {
        // Account WebSocket sessions are deliberately stateless across process
        // restarts. A notification can therefore carry a session-local fill
        // count that is lower than the durable ledger. Never let that lower a
        // broker-confirmed cumulative fill.
        const filledQuantity = Math.max(
          existing.filledQuantity,
          brokerOrder.filledQuantity,
        );
        const remainingQuantity =
          brokerOrder.status === "CANCELED" || brokerOrder.status === "REJECTED"
            ? 0
            : brokerOrder.filledQuantity < existing.filledQuantity
              ? Math.max(0, brokerOrder.orderedQuantity - filledQuantity)
              : brokerOrder.remainingQuantity;
        const status: OrderStatus =
          filledQuantity >= brokerOrder.orderedQuantity
            ? "FILLED"
            : filledQuantity > 0 &&
                (brokerOrder.status === "QUEUED" ||
                  brokerOrder.status === "SENDING" ||
                  brokerOrder.status === "ACKED")
              ? "PARTIALLY_FILLED"
              : brokerOrder.status;
        const eventKey = `reconcile:${brokerOrder.orderedAt.slice(0, 10)}:${brokerOrder.brokerOrderId}:${stableHash({
          status,
          filledQuantity,
          remainingQuantity,
          originalBrokerOrderId: brokerOrder.originalBrokerOrderId ?? null,
          exchange: brokerOrder.exchange ?? existing.exchange,
        })}`;
        const eventInput: ApplyOrderEventInput = {
          scope: input.scope,
          orderId: existing.id,
          dedupeKey: eventKey,
          eventType: "BROKER_RECONCILIATION",
          toStatus: status,
          eventAt: brokerOrder.orderedAt,
          receivedAt,
          brokerOrderId: brokerOrder.brokerOrderId,
          ...(brokerOrder.exchange === undefined ? {} : { exchange: brokerOrder.exchange }),
          filledQuantity,
          remainingQuantity,
          brokerUpdatedAt: brokerOrder.orderedAt,
          allowCorrection: input.allowCorrection ?? true,
          ...(brokerOrder.originalBrokerOrderId === undefined
            ? {}
            : { originalBrokerOrderId: brokerOrder.originalBrokerOrderId }),
          ...(brokerOrder.raw === undefined ? {} : { raw: brokerOrder.raw }),
        };
        return this.applyOrderEventUnsafe(eventInput).order;
      }

      const conflict = this.findActiveOrder(
        input.scope,
        brokerOrder.symbol,
        brokerOrder.side,
      );
      if (conflict && ACTIVE_ORDER_STATUSES.includes(brokerOrder.status)) {
        throw new ActiveOrderConflictError(
          input.scope,
          brokerOrder.symbol,
          brokerOrder.side,
        );
      }

      const orderId = `external-${stableHash({
        scope: input.scope,
        brokerOrderId: brokerOrder.brokerOrderId,
        tradingDate: brokerOrder.orderedAt.slice(0, 10),
      }).slice(0, 40)}`;
      this.database
        .prepare(
          `INSERT INTO orders (
             id, intent_id, broker_id, environment, account_id,
             broker_order_id, original_broker_order_id, symbol, side, order_type, exchange,
             ordered_quantity, filled_quantity, remaining_quantity,
             limit_price_krw, status, ordered_at, broker_updated_at, revision,
             raw_json, created_at, updated_at
           ) VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
        )
        .run(
          orderId,
          ...scopeParameters(input.scope),
          brokerOrder.brokerOrderId,
          brokerOrder.originalBrokerOrderId ?? null,
          brokerOrder.symbol,
          brokerOrder.side,
          brokerOrder.orderType,
          brokerOrder.exchange ?? "KRX",
          brokerOrder.orderedQuantity,
          brokerOrder.filledQuantity,
          brokerOrder.remainingQuantity,
          brokerOrder.limitPrice ?? null,
          brokerOrder.status,
          brokerOrder.orderedAt,
          brokerOrder.orderedAt,
          brokerOrder.raw === undefined ? null : stringifySafeJson(brokerOrder.raw),
          receivedAt,
          receivedAt,
        );
      this.database
        .prepare(
          `INSERT INTO order_events (
             broker_id, environment, account_id, order_id, dedupe_key,
             broker_event_id, event_type, from_status, to_status,
             event_at, received_at, payload_json
           ) VALUES (?, ?, ?, ?, ?, NULL, 'EXTERNAL_ORDER_DISCOVERED', NULL, ?, ?, ?, ?)`,
        )
        .run(
          ...scopeParameters(input.scope),
          orderId,
          `reconcile:${brokerOrder.orderedAt.slice(0, 10)}:${brokerOrder.brokerOrderId}:${stableHash({
            status: brokerOrder.status,
            filledQuantity: brokerOrder.filledQuantity,
            remainingQuantity: brokerOrder.remainingQuantity,
            originalBrokerOrderId: brokerOrder.originalBrokerOrderId ?? null,
            exchange: brokerOrder.exchange ?? "KRX",
          })}`,
          brokerOrder.status,
          brokerOrder.orderedAt,
          receivedAt,
          stringifySafeJson(brokerOrder),
        );
      return this.requireOrder(orderId, input.scope);
    });
    return reconcile.immediate();
  }

  recordExecution(input: RecordExecutionInput): RecordExecutionResult {
    assertPositiveInteger("execution.quantity", input.execution.quantity);
    assertNonNegativeInteger("execution.price", input.execution.price);
    if (input.execution.cumulativeQuantity !== undefined) {
      assertPositiveInteger(
        "execution.cumulativeQuantity",
        input.execution.cumulativeQuantity,
      );
    }
    if (input.execution.cumulativeNotional !== undefined) {
      assertNonNegativeInteger(
        "execution.cumulativeNotional",
        input.execution.cumulativeNotional,
      );
    }
    const fee = input.fee ?? 0;
    const tax = input.tax ?? 0;
    assertNonNegativeInteger("fee", fee);
    assertNonNegativeInteger("tax", tax);

    const record = this.database.transaction(() => {
      const receivedAt = input.receivedAt ?? toIsoDateTime();
      let execution = input.execution;

      // Older Kiwoom ka10076 responses had no trading-date field. If that
      // response was replayed after midnight, the requested date could place
      // the synthetic execution after the time it was received. When a real
      // account-stream fill already exists, keep that durable fill and ignore
      // the delayed replay instead of creating a second position change.
      if (execution.syntheticExecutionId === true) {
        const executedMs = Date.parse(execution.executedAt);
        const receivedMs = Date.parse(receivedAt);
        if (
          Number.isFinite(executedMs) &&
          Number.isFinite(receivedMs) &&
          executedMs > receivedMs + 60_000
        ) {
          const overlapping = this.database
            .prepare(
              `SELECT * FROM fills
               WHERE broker_id = ? AND environment = ? AND account_id = ?
                 AND broker_order_id = ? AND symbol = ? AND side = ?
                 AND quantity = ? AND price_krw = ?
                 AND broker_execution_id NOT LIKE 'ka10076:%'
               ORDER BY received_at DESC LIMIT 1`,
            )
            .get(
              ...scopeParameters(input.scope),
              execution.brokerOrderId,
              execution.symbol,
              execution.side,
              execution.quantity,
              execution.price,
            ) as SqlRow | undefined;
          if (overlapping) {
            const fill = mapFill(overlapping);
            return {
              inserted: false,
              fill,
              order: this.requireOrder(fill.orderId, input.scope),
            };
          }
        }
      }
      if (execution.cumulativeQuantity !== undefined) {
        const aggregate = this.database
          .prepare(
            `SELECT COALESCE(SUM(quantity), 0) AS quantity,
                    COALESCE(SUM(quantity * price_krw), 0) AS notional
             FROM fills
             WHERE broker_id = ? AND environment = ? AND account_id = ?
               AND broker_order_id = ?
               AND substr(executed_at, 1, 10) = substr(?, 1, 10)`,
          )
          .get(
            ...scopeParameters(input.scope),
            execution.brokerOrderId,
            execution.executedAt,
          ) as { quantity: number; notional: number };
        if (aggregate.quantity > execution.cumulativeQuantity) {
          throw new Error(
            `Durable fill ledger ${aggregate.quantity} exceeds broker cumulative quantity ${execution.cumulativeQuantity} for ${execution.brokerOrderId}`,
          );
        }
        if (aggregate.quantity === execution.cumulativeQuantity) {
          const order = this.findOrderByBrokerId(
            input.scope,
            execution.brokerOrderId,
            execution.executedAt,
          );
          if (!order) {
            throw new Error(
              `Cumulative execution ${execution.executionId} has fills but no order projection`,
            );
          }
          const latest = this.database
            .prepare(
              `SELECT * FROM fills
               WHERE broker_id = ? AND environment = ? AND account_id = ?
                 AND broker_order_id = ?
                 AND substr(executed_at, 1, 10) = substr(?, 1, 10)
               ORDER BY executed_at DESC, received_at DESC LIMIT 1`,
            )
            .get(
              ...scopeParameters(input.scope),
              execution.brokerOrderId,
              execution.executedAt,
            ) as SqlRow | undefined;
          return {
            inserted: false,
            fill: latest ? mapFill(latest) : null,
            order,
          };
        }

        const deltaQuantity = execution.cumulativeQuantity - aggregate.quantity;
        const cumulativeNotional =
          execution.cumulativeNotional ??
          execution.cumulativeQuantity * execution.price;
        const deltaNotional = cumulativeNotional - aggregate.notional;
        const deltaPrice =
          deltaNotional > 0
            ? Math.ceil(deltaNotional / deltaQuantity)
            : execution.price;
        execution = {
          ...execution,
          executionId: `${execution.executionId}:delta:${execution.cumulativeQuantity}:${cumulativeNotional}`,
          quantity: deltaQuantity,
          price: Math.max(0, deltaPrice),
        };
      }

      // Some broker reconciliation endpoints omit a durable fill number. The
      // adapter marks their composite IDs so an execution already persisted
      // from the real-time account stream can be correlated exactly. Without
      // this cross-channel check, a restart can add the same fill twice and
      // permanently keep account reconciliation in a failed state.
      if (execution.syntheticExecutionId === true) {
        const overlapping = this.database
          .prepare(
            `SELECT * FROM fills
             WHERE broker_id = ? AND environment = ? AND account_id = ?
               AND broker_order_id = ? AND symbol = ? AND side = ?
               AND quantity = ? AND price_krw = ? AND executed_at = ?
             ORDER BY received_at DESC LIMIT 1`,
          )
          .get(
            ...scopeParameters(input.scope),
            execution.brokerOrderId,
            execution.symbol,
            execution.side,
            execution.quantity,
            execution.price,
            execution.executedAt,
          ) as SqlRow | undefined;
        if (overlapping) {
          const fill = mapFill(overlapping);
          return {
            inserted: false,
            fill,
            order: this.requireOrder(fill.orderId, input.scope),
          };
        }
      }

      const duplicate = this.database
        .prepare(
          `SELECT * FROM fills
           WHERE broker_id = ? AND environment = ? AND account_id = ?
             AND broker_execution_id = ?`,
        )
        .get(
          ...scopeParameters(input.scope),
          execution.executionId,
        ) as SqlRow | undefined;
      if (duplicate) {
        const fill = mapFill(duplicate);
        return {
          inserted: false,
          fill,
          order: this.requireOrder(fill.orderId, input.scope),
        };
      }

      let order = this.findOrderByBrokerId(
        input.scope,
        execution.brokerOrderId,
        execution.executedAt,
      );
      if (!order) {
        const candidate = this.findActiveOrder(
          input.scope,
          execution.symbol,
          execution.side,
        );
        if (candidate && candidate.brokerOrderId === null) {
          this.database
            .prepare(
              `UPDATE orders SET
                 broker_order_id = ?,
                 exchange = CASE
                   WHEN intent_id IS NULL AND ? IS NOT NULL THEN ?
                   ELSE exchange
                 END,
                 updated_at = ?, revision = revision + 1
               WHERE id = ?`,
            )
            .run(
              execution.brokerOrderId,
              execution.exchange ?? null,
              execution.exchange ?? null,
              input.receivedAt ?? toIsoDateTime(),
              candidate.id,
            );
          order = this.requireOrder(candidate.id, input.scope);
        }
      }
      if (!order) {
        const externalOrderedQuantity =
          execution.cumulativeQuantity ?? execution.quantity;
        const externalStatus: OrderStatus =
          execution.cumulativeQuantity === undefined ? "UNKNOWN" : "FILLED";
        const orderId = `external-${stableHash({
          scope: input.scope,
          brokerOrderId: execution.brokerOrderId,
          tradingDate: execution.executedAt.slice(0, 10),
        }).slice(0, 40)}`;
        this.database
          .prepare(
            `INSERT INTO orders (
               id, intent_id, broker_id, environment, account_id, broker_order_id,
               symbol, side, order_type, exchange, ordered_quantity, filled_quantity,
               remaining_quantity, status, ordered_at, broker_updated_at,
               revision, raw_json, created_at, updated_at
             ) VALUES (?, NULL, ?, ?, ?, ?, ?, ?, 'market', ?, ?, 0, 0,
                       ?, ?, ?, 0, ?, ?, ?)`,
          )
          .run(
            orderId,
            ...scopeParameters(input.scope),
            execution.brokerOrderId,
            execution.symbol,
            execution.side,
            execution.exchange ?? "KRX",
            externalOrderedQuantity,
            externalStatus,
            execution.executedAt,
            execution.executedAt,
            execution.raw === undefined
              ? null
              : stringifySafeJson(execution.raw),
            receivedAt,
            receivedAt,
          );
        order = this.requireOrder(orderId, input.scope);
      }

      const fillId =
        input.fillId ??
        `fill-${stableHash({
          scope: input.scope,
          id: execution.executionId,
          tradingDate: execution.executedAt.slice(0, 10),
        }).slice(0, 40)}`;
      this.database
        .prepare(
          `INSERT INTO fills (
             id, broker_id, environment, account_id, order_id,
             broker_execution_id, broker_order_id, symbol, side,
             quantity, price_krw, fee_krw, tax_krw,
             executed_at, received_at, raw_json
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          fillId,
          ...scopeParameters(input.scope),
          order.id,
          execution.executionId,
          execution.brokerOrderId,
          execution.symbol,
          execution.side,
          execution.quantity,
          execution.price,
          fee,
          tax,
          execution.executedAt,
          receivedAt,
          execution.raw === undefined
            ? null
            : stringifySafeJson(execution.raw),
        );

      const aggregate = this.database
        .prepare(
          `SELECT COALESCE(SUM(quantity), 0) AS quantity,
                  COALESCE(SUM(quantity * price_krw), 0) AS notional
           FROM fills WHERE order_id = ?`,
        )
        .get(order.id) as { quantity: number; notional: number };
      if (order.intentId !== null && aggregate.quantity > order.orderedQuantity) {
        throw new Error(
          `Cumulative fill ${aggregate.quantity} exceeds ordered quantity ${order.orderedQuantity}`,
        );
      }
      const orderedQuantity = Math.max(order.orderedQuantity, aggregate.quantity);
      if (orderedQuantity !== order.orderedQuantity && order.intentId === null) {
        this.database
          .prepare(
            `UPDATE orders SET ordered_quantity = ?, updated_at = ? WHERE id = ?`,
          )
          .run(orderedQuantity, receivedAt, order.id);
        order = this.requireOrder(order.id, input.scope);
      }
      const isExternallyUnresolved = order.intentId === null && order.status === "UNKNOWN";
      const nextStatus: OrderStatus =
        order.status === "CANCELED"
          ? "CANCELED"
          : order.status === "REJECTED"
            ? "UNKNOWN"
            : isExternallyUnresolved
              ? "UNKNOWN"
              : aggregate.quantity >= orderedQuantity
                ? "FILLED"
                : "PARTIALLY_FILLED";
      const eventInput: ApplyOrderEventInput = {
        scope: input.scope,
        orderId: order.id,
        dedupeKey: `fill:${execution.executedAt.slice(0, 10)}:${execution.executionId}`,
        brokerEventId: execution.executionId,
        eventType: "EXECUTION",
        toStatus: nextStatus,
        eventAt: execution.executedAt,
        receivedAt,
        brokerOrderId: execution.brokerOrderId,
        filledQuantity: aggregate.quantity,
        remainingQuantity:
          order.status === "CANCELED"
            ? 0
            : Math.max(0, orderedQuantity - aggregate.quantity),
        averageFillPrice:
          aggregate.quantity === 0 ? 0 : Math.round(aggregate.notional / aggregate.quantity),
        brokerUpdatedAt: execution.executedAt,
        raw: execution.raw ?? null,
        allowCorrection: true,
      };
      const updatedOrder = this.applyOrderEventUnsafe(eventInput).order;
      return {
        inserted: true,
        fill: this.requireFill(fillId),
        order: updatedOrder,
      };
    });
    return record.immediate();
  }

  listFills(
    scope: AccountScope,
    options: { since?: string; orderId?: string; limit?: number } = {},
  ): FillRecord[] {
    const where = ["broker_id = ?", "environment = ?", "account_id = ?"];
    // Keep the raw row for audit, but do not expose a known delayed ka10076
    // replay to positions, P&L, FIFO pairing or the web UI.
    where.push(
      "NOT (broker_execution_id LIKE 'ka10076:%' AND julianday(executed_at) > julianday(received_at) + (60.0 / 86400.0))",
    );
    const parameters: unknown[] = [...scopeParameters(scope)];
    if (options.since) {
      where.push("executed_at >= ?");
      parameters.push(options.since);
    }
    if (options.orderId) {
      where.push("order_id = ?");
      parameters.push(options.orderId);
    }
    parameters.push(normalizeLimit(options.limit, 1_000, 20_000));
    return (this.database
      .prepare(
        `SELECT * FROM fills WHERE ${where.join(" AND ")}
         ORDER BY executed_at DESC LIMIT ?`,
      )
      .all(...parameters) as SqlRow[]).map(mapFill);
  }

  replacePositions(input: PositionReplacementInput): BrokerPosition[] {
    const replace = this.database.transaction(() => {
      const seen = new Set<string>();
      const upsert = this.database.prepare(
        `INSERT INTO positions (
           broker_id, environment, account_id, symbol, name,
           quantity, available_quantity, average_price_krw, current_price_krw,
           market_value_krw, unrealized_pnl_krw, unrealized_pnl_bps,
           fetched_at, revision
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
         ON CONFLICT(broker_id, environment, account_id, symbol) DO UPDATE SET
           name = excluded.name,
           quantity = excluded.quantity,
           available_quantity = excluded.available_quantity,
           average_price_krw = excluded.average_price_krw,
           current_price_krw = excluded.current_price_krw,
           market_value_krw = excluded.market_value_krw,
           unrealized_pnl_krw = excluded.unrealized_pnl_krw,
           unrealized_pnl_bps = excluded.unrealized_pnl_bps,
           fetched_at = excluded.fetched_at,
           revision = positions.revision + 1`,
      );
      for (const position of input.positions) {
        validatePosition(position);
        seen.add(position.symbol);
        upsert.run(
          ...scopeParameters(input.scope),
          position.symbol,
          position.name ?? null,
          position.quantity,
          position.availableQuantity,
          position.averagePrice,
          position.currentPrice,
          position.marketValue,
          position.unrealizedPnl,
          position.unrealizedPnlBps,
          input.fetchedAt,
        );
      }

      const existing = this.database
        .prepare(
          `SELECT symbol FROM positions
           WHERE broker_id = ? AND environment = ? AND account_id = ?`,
        )
        .all(...scopeParameters(input.scope)) as Array<{ symbol: string }>;
      const remove = this.database.prepare(
        `DELETE FROM positions
         WHERE broker_id = ? AND environment = ? AND account_id = ? AND symbol = ?`,
      );
      for (const row of existing) {
        if (!seen.has(row.symbol)) remove.run(...scopeParameters(input.scope), row.symbol);
      }
      return this.listPositions(input.scope);
    });
    return replace.immediate();
  }

  listPositions(scope: AccountScope): BrokerPosition[] {
    return (this.database
      .prepare(
        `SELECT * FROM positions
         WHERE broker_id = ? AND environment = ? AND account_id = ?
         ORDER BY symbol`,
      )
      .all(...scopeParameters(scope)) as SqlRow[]).map(mapPosition);
  }

  getPosition(scope: AccountScope, symbol: string): BrokerPosition | null {
    const row = this.database
      .prepare(
        `SELECT * FROM positions
         WHERE broker_id = ? AND environment = ? AND account_id = ? AND symbol = ?`,
      )
      .get(...scopeParameters(scope), symbol) as SqlRow | undefined;
    return row ? mapPosition(row) : null;
  }

  saveBalanceSnapshot(input: SaveBalanceSnapshotInput): BalanceSnapshotRecord {
    const result = this.database
      .prepare(
        `INSERT INTO balance_snapshots (
           broker_id, environment, account_id, cash_krw, available_cash_krw,
           total_evaluation_krw, realized_pnl_today_krw, unrealized_pnl_krw,
           fetched_at, raw_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        ...scopeParameters(input.scope),
        input.cash,
        input.availableCash,
        input.totalEvaluation,
        input.realizedPnlToday,
        input.unrealizedPnl,
        input.fetchedAt,
        input.raw === undefined ? null : stringifySafeJson(input.raw),
      );
    return this.requireBalanceSnapshot(Number(result.lastInsertRowid));
  }

  getLatestBalanceSnapshot(scope: AccountScope): BalanceSnapshotRecord | null {
    const row = this.database
      .prepare(
        `SELECT * FROM balance_snapshots
         WHERE broker_id = ? AND environment = ? AND account_id = ?
         ORDER BY fetched_at DESC, id DESC LIMIT 1`,
      )
      .get(...scopeParameters(scope)) as SqlRow | undefined;
    return row ? mapBalanceSnapshot(row) : null;
  }

  listBalanceSnapshots(
    scope: AccountScope,
    options: { since?: string; limit?: number } = {},
  ): BalanceSnapshotRecord[] {
    const limit = normalizeLimit(options.limit, 200, 10_000);
    const rows = (
      options.since
        ? this.database
            .prepare(
              `SELECT * FROM balance_snapshots
               WHERE broker_id = ? AND environment = ? AND account_id = ?
                 AND fetched_at >= ?
               ORDER BY fetched_at DESC, id DESC LIMIT ?`,
            )
            .all(...scopeParameters(scope), options.since, limit)
        : this.database
            .prepare(
              `SELECT * FROM balance_snapshots
               WHERE broker_id = ? AND environment = ? AND account_id = ?
               ORDER BY fetched_at DESC, id DESC LIMIT ?`,
            )
            .all(...scopeParameters(scope), limit)
    ) as SqlRow[];
    return rows.map(mapBalanceSnapshot);
  }

  upsertDailyPnl(input: UpsertDailyPnlInput): DailyPnlRecord {
    const updatedAt = input.updatedAt ?? toIsoDateTime();
    this.database
      .prepare(
        `INSERT INTO pnl_daily (
           broker_id, environment, account_id, trading_date,
           realized_pnl_krw, unrealized_pnl_krw, total_pnl_krw,
           total_evaluation_krw, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(broker_id, environment, account_id, trading_date) DO UPDATE SET
           realized_pnl_krw = excluded.realized_pnl_krw,
           unrealized_pnl_krw = excluded.unrealized_pnl_krw,
           total_pnl_krw = excluded.total_pnl_krw,
           total_evaluation_krw = excluded.total_evaluation_krw,
           updated_at = excluded.updated_at`,
      )
      .run(
        ...scopeParameters(input.scope),
        input.tradingDate,
        input.realizedPnl,
        input.unrealizedPnl,
        input.totalPnl,
        input.totalEvaluation,
        updatedAt,
      );
    return this.getDailyPnl(input.scope, input.tradingDate) as DailyPnlRecord;
  }

  getDailyPnl(scope: AccountScope, tradingDate: string): DailyPnlRecord | null {
    const row = this.database
      .prepare(
        `SELECT * FROM pnl_daily
         WHERE broker_id = ? AND environment = ? AND account_id = ? AND trading_date = ?`,
      )
      .get(...scopeParameters(scope), tradingDate) as SqlRow | undefined;
    return row ? mapDailyPnl(row) : null;
  }

  listDailyPnl(scope: AccountScope, limit = 365): DailyPnlRecord[] {
    return (this.database
      .prepare(
        `SELECT * FROM pnl_daily
         WHERE broker_id = ? AND environment = ? AND account_id = ?
         ORDER BY trading_date DESC LIMIT ?`,
      )
      .all(...scopeParameters(scope), normalizeLimit(limit, 365, 10_000)) as SqlRow[]).map(
      mapDailyPnl,
    );
  }

  getActiveReservedAmount(scope: AccountScope, budgetKey?: string): number {
    const row = (
      budgetKey
        ? this.database
            .prepare(
              `SELECT COALESCE(SUM(amount_krw), 0) AS amount
               FROM risk_reservations
               WHERE broker_id = ? AND environment = ? AND account_id = ?
                 AND budget_key = ? AND status = 'ACTIVE'`,
            )
            .get(...scopeParameters(scope), budgetKey)
        : this.database
            .prepare(
              `SELECT COALESCE(SUM(amount_krw), 0) AS amount
               FROM risk_reservations
               WHERE broker_id = ? AND environment = ? AND account_id = ?
                 AND status = 'ACTIVE'`,
            )
            .get(...scopeParameters(scope))
    ) as { amount: number };
    return row.amount;
  }

  listRiskReservations(
    scope: AccountScope,
    status?: RiskReservationRecord["status"],
  ): RiskReservationRecord[] {
    const rows = (
      status
        ? this.database
            .prepare(
              `SELECT * FROM risk_reservations
               WHERE broker_id = ? AND environment = ? AND account_id = ? AND status = ?
               ORDER BY created_at`,
            )
            .all(...scopeParameters(scope), status)
        : this.database
            .prepare(
              `SELECT * FROM risk_reservations
               WHERE broker_id = ? AND environment = ? AND account_id = ?
               ORDER BY created_at`,
            )
            .all(...scopeParameters(scope))
    ) as SqlRow[];
    return rows.map(mapRiskReservation);
  }

  setRiskReservationStatus(
    intentId: string,
    status: RiskReservationRecord["status"],
    updatedAt = toIsoDateTime(),
  ): boolean {
    return (
      this.database
        .prepare(
          `UPDATE risk_reservations SET status = ?, updated_at = ? WHERE intent_id = ?`,
        )
        .run(status, updatedAt, intentId).changes > 0
    );
  }

  getRuntimeState<T>(scope: RuntimeScope, stateKey: string): T | null {
    const row = this.database
      .prepare(
        `SELECT value_json FROM runtime_state WHERE scope_key = ? AND state_key = ?`,
      )
      .get(runtimeScopeKey(scope), stateKey) as SqlRow | undefined;
    return row ? parseJson<T>(row.value_json) : null;
  }

  setRuntimeState<T>(
    scope: RuntimeScope,
    stateKey: string,
    value: T,
    updatedAt = toIsoDateTime(),
  ): void {
    this.database
      .prepare(
        `INSERT INTO runtime_state (scope_key, state_key, value_json, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(scope_key, state_key) DO UPDATE SET
           value_json = excluded.value_json,
           updated_at = excluded.updated_at`,
      )
      .run(runtimeScopeKey(scope), stateKey, stringifyJson(value), updatedAt);
  }

  deleteRuntimeState(scope: RuntimeScope, stateKey: string): boolean {
    return (
      this.database
        .prepare("DELETE FROM runtime_state WHERE scope_key = ? AND state_key = ?")
        .run(runtimeScopeKey(scope), stateKey).changes > 0
    );
  }

  appendHealthEvent(
    scope: AccountScope,
    health: BrokerHealth,
    occurredAt = health.checkedAt,
  ): HealthEventRecord {
    const result = this.database
      .prepare(
        `INSERT INTO health_events (
           broker_id, environment, account_id, connection_state, payload_json, occurred_at
         ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        ...scopeParameters(scope),
        health.state,
        stringifySafeJson(health),
        occurredAt,
      );
    const row = this.database
      .prepare("SELECT * FROM health_events WHERE id = ?")
      .get(Number(result.lastInsertRowid)) as SqlRow;
    return mapHealthEvent(row);
  }

  listHealthEvents(scope: AccountScope, limit = 500): HealthEventRecord[] {
    return (this.database
      .prepare(
        `SELECT * FROM health_events
         WHERE broker_id = ? AND environment = ? AND account_id = ?
         ORDER BY occurred_at DESC, id DESC LIMIT ?`,
      )
      .all(...scopeParameters(scope), normalizeLimit(limit, 500, 20_000)) as SqlRow[]).map(
      mapHealthEvent,
    );
  }

  appendError(input: AppendErrorInput): ErrorLogRecord {
    const scope = nullableScopeParameters(input.scope);
    const result = this.database
      .prepare(
        `INSERT INTO error_logs (
           broker_id, environment, account_id, severity, code,
           message, details_json, occurred_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        ...scope,
        input.severity,
        input.code ?? null,
        input.message,
        input.details === undefined ? null : stringifySafeJson(input.details),
        input.occurredAt ?? toIsoDateTime(),
      );
    return this.requireErrorLog(Number(result.lastInsertRowid));
  }

  listErrors(
    options: { scope?: AccountScope; severity?: string; since?: string; limit?: number } = {},
  ): ErrorLogRecord[] {
    const where: string[] = [];
    const parameters: unknown[] = [];
    if (options.scope) {
      where.push("broker_id = ?", "environment = ?", "account_id = ?");
      parameters.push(...scopeParameters(options.scope));
    }
    if (options.severity) {
      where.push("severity = ?");
      parameters.push(options.severity);
    }
    if (options.since) {
      where.push("occurred_at >= ?");
      parameters.push(options.since);
    }
    parameters.push(normalizeLimit(options.limit, 500, 20_000));
    const whereSql = where.length === 0 ? "" : `WHERE ${where.join(" AND ")}`;
    return (this.database
      .prepare(
        `SELECT * FROM error_logs ${whereSql}
         ORDER BY occurred_at DESC, id DESC LIMIT ?`,
      )
      .all(...parameters) as SqlRow[]).map(mapErrorLog);
  }

  appendAudit(input: AppendAuditInput): AuditLogRecord {
    const result = this.database
      .prepare(
        `INSERT INTO audit_log (
           actor, action, broker_id, environment, account_id,
           entity_type, entity_id, payload_json, occurred_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.actor,
        input.action,
        ...nullableScopeParameters(input.scope),
        input.entityType ?? null,
        input.entityId ?? null,
        stringifySafeJson(input.payload ?? null),
        input.occurredAt ?? toIsoDateTime(),
      );
    return this.requireAuditLog(Number(result.lastInsertRowid));
  }

  listAuditLog(
    options: {
      scope?: AccountScope;
      entityType?: string;
      entityId?: string;
      since?: string;
      limit?: number;
    } = {},
  ): AuditLogRecord[] {
    const where: string[] = [];
    const parameters: unknown[] = [];
    if (options.scope) {
      where.push("broker_id = ?", "environment = ?", "account_id = ?");
      parameters.push(...scopeParameters(options.scope));
    }
    if (options.entityType) {
      where.push("entity_type = ?");
      parameters.push(options.entityType);
    }
    if (options.entityId) {
      where.push("entity_id = ?");
      parameters.push(options.entityId);
    }
    if (options.since) {
      where.push("occurred_at >= ?");
      parameters.push(options.since);
    }
    parameters.push(normalizeLimit(options.limit, 500, 20_000));
    const whereSql = where.length === 0 ? "" : `WHERE ${where.join(" AND ")}`;
    return (this.database
      .prepare(
        `SELECT * FROM audit_log ${whereSql}
         ORDER BY occurred_at DESC, id DESC LIMIT ?`,
      )
      .all(...parameters) as SqlRow[]).map(mapAuditLog);
  }

  claimOutbox(options: ClaimOutboxOptions): OutboxRecord[] {
    const now = options.now ?? toIsoDateTime();
    const leaseMs = options.leaseMs ?? 30_000;
    const limit = normalizeLimit(options.limit, 50, 1_000);
    assertPositiveInteger("leaseMs", leaseMs);
    const leasedUntil = addMilliseconds(now, leaseMs);
    const claim = this.database.transaction(() => {
      this.database
        .prepare(
          `UPDATE outbox SET
             status = 'PENDING', lease_owner = NULL, leased_until = NULL, updated_at = ?
           WHERE status = 'PROCESSING' AND leased_until IS NOT NULL AND leased_until <= ?`,
        )
        .run(now, now);

      const candidates = this.database
        .prepare(
          `SELECT id FROM outbox
           WHERE status = 'PENDING' AND available_at <= ?
           ORDER BY created_at ASC LIMIT ?`,
        )
        .all(now, limit) as Array<{ id: string }>;
      const update = this.database.prepare(
        `UPDATE outbox SET
           status = 'PROCESSING', attempts = attempts + 1,
           lease_owner = ?, leased_until = ?, updated_at = ?
         WHERE id = ? AND status = 'PENDING'`,
      );
      const claimed: OutboxRecord[] = [];
      for (const candidate of candidates) {
        if (update.run(options.ownerId, leasedUntil, now, candidate.id).changes > 0) {
          claimed.push(this.requireOutbox(candidate.id));
        }
      }
      return claimed;
    });
    return claim.immediate();
  }

  markOutboxDone(id: string, ownerId?: string, updatedAt = toIsoDateTime()): boolean {
    const result = (
      ownerId
        ? this.database
            .prepare(
              `UPDATE outbox SET
                 status = 'DONE', lease_owner = NULL, leased_until = NULL,
                 last_error = NULL, updated_at = ?
               WHERE id = ? AND lease_owner = ?`,
            )
            .run(updatedAt, id, ownerId)
        : this.database
            .prepare(
              `UPDATE outbox SET
                 status = 'DONE', lease_owner = NULL, leased_until = NULL,
                 last_error = NULL, updated_at = ? WHERE id = ?`,
            )
            .run(updatedAt, id)
    );
    return result.changes > 0;
  }

  blockOutbox(id: string, error: string, updatedAt = toIsoDateTime()): boolean {
    return (
      this.database
        .prepare(
          `UPDATE outbox SET
             status = 'BLOCKED', lease_owner = NULL, leased_until = NULL,
             last_error = ?, updated_at = ? WHERE id = ?`,
        )
        .run(error, updatedAt, id).changes > 0
    );
  }

  rescheduleOutbox(
    id: string,
    availableAt: string,
    error: string,
    updatedAt = toIsoDateTime(),
  ): boolean {
    return (
      this.database
        .prepare(
          `UPDATE outbox SET
             status = 'PENDING', available_at = ?, lease_owner = NULL,
             leased_until = NULL, last_error = ?, updated_at = ?
           WHERE id = ? AND status IN ('PROCESSING', 'FAILED', 'BLOCKED')`,
        )
        .run(availableAt, error, updatedAt, id).changes > 0
    );
  }

  failOutbox(id: string, error: string, updatedAt = toIsoDateTime()): boolean {
    return (
      this.database
        .prepare(
          `UPDATE outbox SET
             status = 'FAILED', lease_owner = NULL, leased_until = NULL,
             last_error = ?, updated_at = ? WHERE id = ?`,
        )
        .run(error, updatedAt, id).changes > 0
    );
  }

  getOutbox(id: string): OutboxRecord | null {
    const row = this.database.prepare("SELECT * FROM outbox WHERE id = ?").get(id) as
      | SqlRow
      | undefined;
    return row ? mapOutbox(row) : null;
  }

  listOutbox(
    options: { scope?: AccountScope; statuses?: OutboxRecord["status"][]; limit?: number } = {},
  ): OutboxRecord[] {
    const where: string[] = [];
    const parameters: unknown[] = [];
    if (options.scope) {
      where.push("broker_id = ?", "environment = ?", "account_id = ?");
      parameters.push(...scopeParameters(options.scope));
    }
    if (options.statuses && options.statuses.length > 0) {
      where.push(`status IN (${placeholders(options.statuses.length)})`);
      parameters.push(...options.statuses);
    }
    parameters.push(normalizeLimit(options.limit, 500, 20_000));
    const whereSql = where.length === 0 ? "" : `WHERE ${where.join(" AND ")}`;
    return (this.database
      .prepare(
        `SELECT * FROM outbox ${whereSql}
         ORDER BY created_at ASC LIMIT ?`,
      )
      .all(...parameters) as SqlRow[]).map(mapOutbox);
  }

  acquireEngineLease(input: AcquireEngineLeaseInput): boolean {
    const now = input.now ?? toIsoDateTime();
    const ttlMs = input.ttlMs ?? 30_000;
    assertPositiveInteger("ttlMs", ttlMs);
    const expiresAt = addMilliseconds(now, ttlMs);
    const acquire = this.database.transaction(() => {
      const current = this.getEngineLease(input.name);
      if (!current) {
        this.database
          .prepare(
            `INSERT INTO engine_lease (
               name, owner_id, acquired_at, heartbeat_at, expires_at
             ) VALUES (?, ?, ?, ?, ?)`,
          )
          .run(input.name, input.ownerId, now, now, expiresAt);
        return true;
      }
      if (current.ownerId !== input.ownerId && current.expiresAt > now) return false;
      this.database
        .prepare(
          `UPDATE engine_lease SET
             owner_id = ?, acquired_at = ?, heartbeat_at = ?, expires_at = ?
           WHERE name = ?`,
        )
        .run(input.ownerId, now, now, expiresAt, input.name);
      return true;
    });
    return acquire.immediate();
  }

  heartbeatEngineLease(
    name: string,
    ownerId: string,
    ttlMs = 30_000,
    now = toIsoDateTime(),
  ): boolean {
    assertPositiveInteger("ttlMs", ttlMs);
    return (
      this.database
        .prepare(
          `UPDATE engine_lease SET heartbeat_at = ?, expires_at = ?
           WHERE name = ? AND owner_id = ?`,
        )
        .run(now, addMilliseconds(now, ttlMs), name, ownerId).changes > 0
    );
  }

  releaseEngineLease(name: string, ownerId: string): boolean {
    return (
      this.database
        .prepare("DELETE FROM engine_lease WHERE name = ? AND owner_id = ?")
        .run(name, ownerId).changes > 0
    );
  }

  getEngineLease(name: string): EngineLeaseRecord | null {
    const row = this.database
      .prepare("SELECT * FROM engine_lease WHERE name = ?")
      .get(name) as SqlRow | undefined;
    return row ? mapEngineLease(row) : null;
  }

  upsertDerivativesAccount(
    input: UpsertDerivativesAccountInput,
  ): DerivativesAccountRecord {
    const accountKey = createDerivativesAccountKey(input.scope);
    const now = input.updatedAt ?? toIsoDateTime();
    this.database
      .prepare(
        `INSERT INTO derivatives_accounts (
           account_key, provider_id, product, environment, account_id,
           account_product_code, enabled, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(account_key) DO UPDATE SET
           enabled = excluded.enabled,
           updated_at = excluded.updated_at`,
      )
      .run(
        accountKey,
        input.scope.providerId,
        input.scope.product,
        input.scope.environment,
        input.scope.accountId,
        input.scope.accountProductCode,
        toSqlBoolean(input.enabled),
        now,
        now,
      );
    return this.requireDerivativesAccount(accountKey);
  }

  getDerivativesAccount(accountKey: DerivativesAccountKey): DerivativesAccountRecord | null {
    const row = this.database
      .prepare("SELECT * FROM derivatives_accounts WHERE account_key = ?")
      .get(accountKey) as SqlRow | undefined;
    return row ? mapDerivativesAccount(row) : null;
  }

  listDerivativesAccounts(): DerivativesAccountRecord[] {
    return (this.database
      .prepare(
        `SELECT * FROM derivatives_accounts
         ORDER BY provider_id, environment, account_id, account_product_code`,
      )
      .all() as SqlRow[]).map(mapDerivativesAccount);
  }

  upsertDerivativesContract(
    input: UpsertDerivativesContractInput,
  ): DerivativesContractRecord {
    const contract = input.contract;
    assertNonEmptyString("contract.id", contract.id);
    assertNonEmptyString("contract.contractCode", contract.contractCode);
    assertNonEmptyString("contract.name", contract.name);
    assertNonEmptyString("contract.underlyingCode", contract.underlyingCode);
    assertPositiveInteger("contract.multiplierKrw", contract.multiplierKrw);
    assertPositiveInteger("contract.priceScale", contract.priceScale);
    const now = input.updatedAt ?? toIsoDateTime();
    this.database
      .prepare(
        `INSERT INTO derivatives_contracts (
           id, provider_id, contract_code, name, contract_type,
           underlying_code, multiplier_krw, price_scale, expiry_date,
           active, raw_json, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           contract_code = excluded.contract_code,
           name = excluded.name,
           contract_type = excluded.contract_type,
           underlying_code = excluded.underlying_code,
           multiplier_krw = excluded.multiplier_krw,
           price_scale = excluded.price_scale,
           expiry_date = excluded.expiry_date,
           active = excluded.active,
           raw_json = excluded.raw_json,
           updated_at = excluded.updated_at`,
      )
      .run(
        contract.id,
        contract.providerId,
        contract.contractCode,
        contract.name,
        contract.contractType,
        contract.underlyingCode,
        contract.multiplierKrw,
        contract.priceScale,
        contract.expiryDate,
        toSqlBoolean(contract.active),
        contract.raw === undefined ? null : stringifySafeJson(contract.raw),
        now,
        now,
      );
    return this.requireDerivativesContract(contract.id);
  }

  getDerivativesContract(id: string): DerivativesContractRecord | null {
    const row = this.database
      .prepare("SELECT * FROM derivatives_contracts WHERE id = ?")
      .get(id) as SqlRow | undefined;
    return row ? mapDerivativesContract(row) : null;
  }

  listDerivativesContracts(options: {
    providerId?: BrokerId;
    active?: boolean;
  } = {}): DerivativesContractRecord[] {
    const where: string[] = [];
    const parameters: unknown[] = [];
    if (options.providerId) {
      where.push("provider_id = ?");
      parameters.push(options.providerId);
    }
    if (options.active !== undefined) {
      where.push("active = ?");
      parameters.push(toSqlBoolean(options.active));
    }
    return (this.database
      .prepare(
        `SELECT * FROM derivatives_contracts
         ${where.length === 0 ? "" : `WHERE ${where.join(" AND ")}`}
         ORDER BY expiry_date, contract_code`,
      )
      .all(...parameters) as SqlRow[]).map(mapDerivativesContract);
  }

  createDerivativesOrderIntent(
    input: CreateDerivativesOrderIntentInput,
  ): CreateDerivativesOrderIntentResult {
    assertPositiveInteger("derivativesOrder.quantity", input.quantity);
    if (input.limitPriceTicks !== undefined) {
      assertPositiveInteger("derivativesOrder.limitPriceTicks", input.limitPriceTicks);
    }
    const create = this.database.transaction(() => {
      const existing = this.database
        .prepare(
          `SELECT * FROM derivatives_order_intents
           WHERE account_key = ? AND idempotency_key = ?`,
        )
        .get(input.accountKey, input.idempotencyKey) as SqlRow | undefined;
      if (existing) {
        const intent = mapDerivativesOrderIntent(existing);
        return {
          created: false,
          intent,
          order: this.requireDerivativesOrderByIntent(intent.id),
        };
      }
      this.assertDerivativesAccountContractProvider(input.accountKey, input.contractId);
      const conflict = this.database
        .prepare(
          `SELECT id FROM derivatives_order_intents
           WHERE account_key = ? AND contract_id = ? AND purpose = ?
             AND action = ? AND direction = ?
             AND status IN (
               'QUEUED', 'SENDING', 'ACKED', 'PARTIALLY_FILLED',
               'CANCEL_REQUESTED', 'AMEND_REQUESTED', 'AMENDED', 'UNKNOWN'
             ) LIMIT 1`,
        )
        .get(
          input.accountKey,
          input.contractId,
          input.purpose,
          input.action,
          input.direction,
        );
      if (conflict) {
        throw new Error("An equivalent active derivatives order already exists");
      }
      const now = input.createdAt ?? toIsoDateTime();
      const orderId = input.orderId ?? input.id;
      this.database
        .prepare(
          `INSERT INTO derivatives_order_intents (
             id, account_key, idempotency_key, client_order_id, contract_id,
             action, direction, purpose, quantity, limit_price_ticks,
             status, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'QUEUED', ?, ?)`,
        )
        .run(
          input.id,
          input.accountKey,
          input.idempotencyKey,
          input.clientOrderId,
          input.contractId,
          input.action,
          input.direction,
          input.purpose,
          input.quantity,
          input.limitPriceTicks ?? null,
          now,
          now,
        );
      this.database
        .prepare(
          `INSERT INTO derivatives_orders (
             id, intent_id, account_key, contract_id, action, direction,
             purpose, ordered_quantity, filled_quantity, remaining_quantity,
             limit_price_ticks, status, ordered_at, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, 'QUEUED', ?, ?, ?)`,
        )
        .run(
          orderId,
          input.id,
          input.accountKey,
          input.contractId,
          input.action,
          input.direction,
          input.purpose,
          input.quantity,
          input.quantity,
          input.limitPriceTicks ?? null,
          now,
          now,
          now,
        );
      return {
        created: true,
        intent: this.requireDerivativesOrderIntent(input.id),
        order: this.requireDerivativesOrder(orderId, input.accountKey),
      };
    });
    return create.immediate();
  }

  getDerivativesOrder(
    id: string,
    accountKey?: DerivativesAccountKey,
  ): DerivativesOrderRecord | null {
    const row = (
      accountKey
        ? this.database
            .prepare("SELECT * FROM derivatives_orders WHERE id = ? AND account_key = ?")
            .get(id, accountKey)
        : this.database.prepare("SELECT * FROM derivatives_orders WHERE id = ?").get(id)
    ) as SqlRow | undefined;
    return row ? mapDerivativesOrder(row) : null;
  }

  listDerivativesOrders(
    accountKey: DerivativesAccountKey,
    options: { statuses?: OrderStatus[]; limit?: number } = {},
  ): DerivativesOrderRecord[] {
    const where = ["account_key = ?"];
    const parameters: unknown[] = [accountKey];
    if (options.statuses && options.statuses.length > 0) {
      where.push(`status IN (${placeholders(options.statuses.length)})`);
      parameters.push(...options.statuses);
    }
    parameters.push(normalizeLimit(options.limit, 500, 20_000));
    return (this.database
      .prepare(
        `SELECT * FROM derivatives_orders WHERE ${where.join(" AND ")}
         ORDER BY updated_at DESC LIMIT ?`,
      )
      .all(...parameters) as SqlRow[]).map(mapDerivativesOrder);
  }

  listOpenDerivativesOrders(accountKey: DerivativesAccountKey): DerivativesOrderRecord[] {
    return this.listDerivativesOrders(accountKey, { statuses: [...ACTIVE_ORDER_STATUSES] });
  }

  applyDerivativesOrderUpdate(
    input: ApplyDerivativesOrderUpdateInput,
  ): DerivativesOrderRecord {
    const apply = this.database.transaction(() => {
      const current = this.requireDerivativesOrder(input.orderId, input.accountKey);
      if (!ALLOWED_TRANSITIONS[current.status].has(input.status)) {
        throw new InvalidOrderTransitionError(current.status, input.status);
      }
      const filled = input.filledQuantity ?? current.filledQuantity;
      const remaining = input.remainingQuantity ?? current.remainingQuantity;
      assertNonNegativeInteger("derivativesOrder.filledQuantity", filled);
      assertNonNegativeInteger("derivativesOrder.remainingQuantity", remaining);
      if (filled > current.orderedQuantity || remaining > current.orderedQuantity) {
        throw new RangeError("Derivatives order quantities exceed ordered quantity");
      }
      if (input.averageFillPriceTicks !== undefined) {
        assertNonNegativeInteger(
          "derivativesOrder.averageFillPriceTicks",
          input.averageFillPriceTicks,
        );
      }
      const now = input.updatedAt ?? toIsoDateTime();
      this.database
        .prepare(
          `UPDATE derivatives_orders SET
             broker_order_id = COALESCE(?, broker_order_id),
             original_broker_order_id = COALESCE(?, original_broker_order_id),
             filled_quantity = ?, remaining_quantity = ?,
             average_fill_price_ticks = COALESCE(?, average_fill_price_ticks),
             status = ?, broker_updated_at = COALESCE(?, broker_updated_at),
             raw_json = COALESCE(?, raw_json), updated_at = ?
           WHERE id = ? AND account_key = ?`,
        )
        .run(
          input.brokerOrderId ?? null,
          input.originalBrokerOrderId ?? null,
          filled,
          remaining,
          input.averageFillPriceTicks ?? null,
          input.status,
          input.brokerUpdatedAt ?? null,
          input.raw === undefined ? null : stringifySafeJson(input.raw),
          now,
          input.orderId,
          input.accountKey,
        );
      this.database
        .prepare(
          `UPDATE derivatives_order_intents
           SET status = ?, updated_at = ? WHERE id = ?`,
        )
        .run(input.status, now, current.intentId);
      return this.requireDerivativesOrder(input.orderId, input.accountKey);
    });
    return apply.immediate();
  }

  recordDerivativesFill(input: RecordDerivativesFillInput): {
    inserted: boolean;
    fill: DerivativesFillRecord;
    order: DerivativesOrderRecord;
  } {
    assertPositiveInteger("derivativesFill.quantity", input.quantity);
    assertNonNegativeInteger("derivativesFill.priceTicks", input.priceTicks);
    assertNonNegativeInteger("derivativesFill.feeKrw", input.feeKrw ?? 0);
    const record = this.database.transaction(() => {
      const duplicate = this.database
        .prepare(
          `SELECT * FROM derivatives_fills
           WHERE account_key = ? AND broker_execution_id = ?`,
        )
        .get(input.accountKey, input.brokerExecutionId) as SqlRow | undefined;
      if (duplicate) {
        const fill = mapDerivativesFill(duplicate);
        return {
          inserted: false,
          fill,
          order: this.requireDerivativesOrder(fill.orderId, input.accountKey),
        };
      }
      const order = this.requireDerivativesOrder(input.orderId, input.accountKey);
      const aggregateBefore = this.database
        .prepare(
          `SELECT COALESCE(SUM(quantity), 0) AS quantity
           FROM derivatives_fills WHERE order_id = ?`,
        )
        .get(order.id) as { quantity: number };
      if (aggregateBefore.quantity + input.quantity > order.orderedQuantity) {
        throw new RangeError("Cumulative derivatives fill exceeds ordered quantity");
      }
      const receivedAt = input.receivedAt ?? toIsoDateTime();
      this.database
        .prepare(
          `INSERT INTO derivatives_fills (
             id, account_key, order_id, broker_execution_id, broker_order_id,
             quantity, price_ticks, fee_krw, executed_at, received_at, raw_json
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.id,
          input.accountKey,
          input.orderId,
          input.brokerExecutionId,
          input.brokerOrderId,
          input.quantity,
          input.priceTicks,
          input.feeKrw ?? 0,
          input.executedAt,
          receivedAt,
          input.raw === undefined ? null : stringifySafeJson(input.raw),
        );
      const aggregate = this.database
        .prepare(
          `SELECT COALESCE(SUM(quantity), 0) AS quantity,
                  COALESCE(SUM(quantity * price_ticks), 0) AS notional
           FROM derivatives_fills WHERE order_id = ?`,
        )
        .get(order.id) as { quantity: number; notional: number };
      const status: OrderStatus =
        aggregate.quantity === order.orderedQuantity ? "FILLED" : "PARTIALLY_FILLED";
      const updated = this.applyDerivativesOrderUpdateUnsafe({
        accountKey: input.accountKey,
        orderId: order.id,
        status,
        brokerOrderId: input.brokerOrderId,
        filledQuantity: aggregate.quantity,
        remainingQuantity: order.orderedQuantity - aggregate.quantity,
        averageFillPriceTicks: Math.round(aggregate.notional / aggregate.quantity),
        brokerUpdatedAt: input.executedAt,
        updatedAt: receivedAt,
      });
      return {
        inserted: true,
        fill: this.requireDerivativesFill(input.id),
        order: updated,
      };
    });
    return record.immediate();
  }

  listDerivativesFills(
    accountKey: DerivativesAccountKey,
    options: { orderId?: string; limit?: number } = {},
  ): DerivativesFillRecord[] {
    const where = ["account_key = ?"];
    const parameters: unknown[] = [accountKey];
    if (options.orderId) {
      where.push("order_id = ?");
      parameters.push(options.orderId);
    }
    parameters.push(normalizeLimit(options.limit, 1_000, 20_000));
    return (this.database
      .prepare(
        `SELECT * FROM derivatives_fills WHERE ${where.join(" AND ")}
         ORDER BY executed_at DESC LIMIT ?`,
      )
      .all(...parameters) as SqlRow[]).map(mapDerivativesFill);
  }

  upsertDerivativesPosition(
    input: UpsertDerivativesPositionInput,
  ): DerivativesPositionRecord {
    this.assertDerivativesAccountContractProvider(input.accountKey, input.contractId);
    assertSafeInteger("derivativesPosition.netQuantity", input.netQuantity);
    assertNonNegativeInteger("derivativesPosition.averagePriceTicks", input.averagePriceTicks);
    assertNonNegativeInteger("derivativesPosition.currentPriceTicks", input.currentPriceTicks);
    assertNonNegativeInteger("derivativesPosition.marginRequiredKrw", input.marginRequiredKrw);
    assertSafeInteger("derivativesPosition.unrealizedPnlKrw", input.unrealizedPnlKrw);
    const now = input.updatedAt ?? toIsoDateTime();
    this.database
      .prepare(
        `INSERT INTO derivatives_positions (
           account_key, contract_id, net_quantity, average_price_ticks,
           current_price_ticks, margin_required_krw, unrealized_pnl_krw,
           broker_updated_at, raw_json, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(account_key, contract_id) DO UPDATE SET
           net_quantity = excluded.net_quantity,
           average_price_ticks = excluded.average_price_ticks,
           current_price_ticks = excluded.current_price_ticks,
           margin_required_krw = excluded.margin_required_krw,
           unrealized_pnl_krw = excluded.unrealized_pnl_krw,
           broker_updated_at = excluded.broker_updated_at,
           raw_json = excluded.raw_json,
           updated_at = excluded.updated_at`,
      )
      .run(
        input.accountKey,
        input.contractId,
        input.netQuantity,
        input.averagePriceTicks,
        input.currentPriceTicks,
        input.marginRequiredKrw,
        input.unrealizedPnlKrw,
        input.brokerUpdatedAt,
        input.raw === undefined ? null : stringifySafeJson(input.raw),
        now,
      );
    return this.getDerivativesPosition(input.accountKey, input.contractId) as DerivativesPositionRecord;
  }

  getDerivativesPosition(
    accountKey: DerivativesAccountKey,
    contractId: string,
  ): DerivativesPositionRecord | null {
    const row = this.database
      .prepare(
        `SELECT * FROM derivatives_positions
         WHERE account_key = ? AND contract_id = ?`,
      )
      .get(accountKey, contractId) as SqlRow | undefined;
    return row ? mapDerivativesPosition(row) : null;
  }

  listDerivativesPositions(accountKey: DerivativesAccountKey): DerivativesPositionRecord[] {
    return (this.database
      .prepare(
        `SELECT * FROM derivatives_positions
         WHERE account_key = ? ORDER BY contract_id`,
      )
      .all(accountKey) as SqlRow[]).map(mapDerivativesPosition);
  }

  replaceDerivativesPurposeLedger(
    input: ReplaceDerivativesPurposeLedgerInput,
  ): DerivativesPurposeLedgerRecord[] {
    this.assertDerivativesAccountContractProvider(input.accountKey, input.contractId);
    const purposes = new Set<DerivativesPositionPurpose>();
    for (const allocation of input.allocations) {
      if (purposes.has(allocation.purpose)) {
        throw new Error(`Duplicate derivatives purpose allocation: ${allocation.purpose}`);
      }
      purposes.add(allocation.purpose);
      assertSafeInteger("derivativesLedger.signedQuantity", allocation.signedQuantity);
      assertNonNegativeInteger("derivativesLedger.averagePriceTicks", allocation.averagePriceTicks);
      assertSafeInteger("derivativesLedger.realizedPnlKrw", allocation.realizedPnlKrw);
    }
    const replace = this.database.transaction(() => {
      const now = input.updatedAt ?? toIsoDateTime();
      this.database
        .prepare(
          `DELETE FROM derivatives_purpose_ledger
           WHERE account_key = ? AND contract_id = ?`,
        )
        .run(input.accountKey, input.contractId);
      const insert = this.database.prepare(
        `INSERT INTO derivatives_purpose_ledger (
           account_key, contract_id, purpose, signed_quantity,
           average_price_ticks, realized_pnl_krw, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const allocation of input.allocations) {
        insert.run(
          input.accountKey,
          input.contractId,
          allocation.purpose,
          allocation.signedQuantity,
          allocation.averagePriceTicks,
          allocation.realizedPnlKrw,
          now,
        );
      }
      return this.listDerivativesPurposeLedger(input.accountKey, input.contractId);
    });
    return replace.immediate();
  }

  listDerivativesPurposeLedger(
    accountKey: DerivativesAccountKey,
    contractId?: string,
  ): DerivativesPurposeLedgerRecord[] {
    const rows = (
      contractId
        ? this.database
            .prepare(
              `SELECT * FROM derivatives_purpose_ledger
               WHERE account_key = ? AND contract_id = ? ORDER BY purpose`,
            )
            .all(accountKey, contractId)
        : this.database
            .prepare(
              `SELECT * FROM derivatives_purpose_ledger
               WHERE account_key = ? ORDER BY contract_id, purpose`,
            )
            .all(accountKey)
    ) as SqlRow[];
    return rows.map(mapDerivativesPurposeLedger);
  }

  checkDerivativesPositionConsistency(
    accountKey: DerivativesAccountKey,
    contractId: string,
  ): DerivativesPositionConsistency {
    const position = this.getDerivativesPosition(accountKey, contractId);
    if (!position) throw new RecordNotFoundError("derivatives position", contractId);
    const aggregate = this.database
      .prepare(
        `SELECT COALESCE(SUM(signed_quantity), 0) AS quantity
         FROM derivatives_purpose_ledger
         WHERE account_key = ? AND contract_id = ?`,
      )
      .get(accountKey, contractId) as { quantity: number };
    const difference = aggregate.quantity - position.netQuantity;
    return {
      accountKey,
      contractId,
      brokerNetQuantity: position.netQuantity,
      allocatedQuantity: aggregate.quantity,
      difference,
      consistent: difference === 0,
    };
  }

  upsertDerivativesHedgeTarget(
    input: UpsertDerivativesHedgeTargetInput,
  ): DerivativesHedgeTargetRecord {
    this.assertDerivativesAccountContractProvider(input.accountKey, input.contractId);
    assertNonNegativeInteger(
      "derivativesHedge.sourceEquityExposureKrw",
      input.sourceEquityExposureKrw,
    );
    assertNonNegativeInteger("derivativesHedge.hedgeRatioBps", input.hedgeRatioBps);
    assertSafeInteger("derivativesHedge.targetSignedQuantity", input.targetSignedQuantity);
    assertSafeInteger(
      "derivativesHedge.actualHedgeSignedQuantity",
      input.actualHedgeSignedQuantity,
    );
    assertNonEmptyString("derivativesHedge.inputHash", input.inputHash);
    const now = input.updatedAt ?? toIsoDateTime();
    this.database
      .prepare(
        `INSERT INTO derivatives_hedge_targets (
           account_key, contract_id, source_equity_exposure_krw,
           hedge_ratio_bps, target_signed_quantity, actual_hedge_signed_quantity,
           input_hash, status, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(account_key, contract_id) DO UPDATE SET
           source_equity_exposure_krw = excluded.source_equity_exposure_krw,
           hedge_ratio_bps = excluded.hedge_ratio_bps,
           target_signed_quantity = excluded.target_signed_quantity,
           actual_hedge_signed_quantity = excluded.actual_hedge_signed_quantity,
           input_hash = excluded.input_hash,
           status = excluded.status,
           updated_at = excluded.updated_at`,
      )
      .run(
        input.accountKey,
        input.contractId,
        input.sourceEquityExposureKrw,
        input.hedgeRatioBps,
        input.targetSignedQuantity,
        input.actualHedgeSignedQuantity,
        input.inputHash,
        input.status,
        now,
      );
    return this.getDerivativesHedgeTarget(
      input.accountKey,
      input.contractId,
    ) as DerivativesHedgeTargetRecord;
  }

  getDerivativesHedgeTarget(
    accountKey: DerivativesAccountKey,
    contractId: string,
  ): DerivativesHedgeTargetRecord | null {
    const row = this.database
      .prepare(
        `SELECT * FROM derivatives_hedge_targets
         WHERE account_key = ? AND contract_id = ?`,
      )
      .get(accountKey, contractId) as SqlRow | undefined;
    return row ? mapDerivativesHedgeTarget(row) : null;
  }

  listDerivativesHedgeTargets(
    accountKey: DerivativesAccountKey,
  ): DerivativesHedgeTargetRecord[] {
    return (this.database
      .prepare(
        `SELECT * FROM derivatives_hedge_targets
         WHERE account_key = ? ORDER BY contract_id`,
      )
      .all(accountKey) as SqlRow[]).map(mapDerivativesHedgeTarget);
  }

  private applyDerivativesOrderUpdateUnsafe(
    input: ApplyDerivativesOrderUpdateInput,
  ): DerivativesOrderRecord {
    const current = this.requireDerivativesOrder(input.orderId, input.accountKey);
    const filled = input.filledQuantity ?? current.filledQuantity;
    const remaining = input.remainingQuantity ?? current.remainingQuantity;
    const now = input.updatedAt ?? toIsoDateTime();
    this.database
      .prepare(
        `UPDATE derivatives_orders SET
           broker_order_id = COALESCE(?, broker_order_id),
           filled_quantity = ?, remaining_quantity = ?,
           average_fill_price_ticks = COALESCE(?, average_fill_price_ticks),
           status = ?, broker_updated_at = COALESCE(?, broker_updated_at),
           updated_at = ? WHERE id = ? AND account_key = ?`,
      )
      .run(
        input.brokerOrderId ?? null,
        filled,
        remaining,
        input.averageFillPriceTicks ?? null,
        input.status,
        input.brokerUpdatedAt ?? null,
        now,
        input.orderId,
        input.accountKey,
      );
    this.database
      .prepare("UPDATE derivatives_order_intents SET status = ?, updated_at = ? WHERE id = ?")
      .run(input.status, now, current.intentId);
    return this.requireDerivativesOrder(input.orderId, input.accountKey);
  }

  private assertDerivativesAccountContractProvider(
    accountKey: DerivativesAccountKey,
    contractId: string,
  ): void {
    const pair = this.database
      .prepare(
        `SELECT a.provider_id AS account_provider,
                c.provider_id AS contract_provider
         FROM derivatives_accounts a
         JOIN derivatives_contracts c ON c.id = ?
         WHERE a.account_key = ?`,
      )
      .get(contractId, accountKey) as
      | { account_provider: string; contract_provider: string }
      | undefined;
    if (!pair) throw new RecordNotFoundError("derivatives account/contract", `${accountKey}/${contractId}`);
    if (pair.account_provider !== pair.contract_provider) {
      throw new Error("Derivatives account and contract providers do not match");
    }
  }

  private requireDerivativesAccount(
    accountKey: DerivativesAccountKey,
  ): DerivativesAccountRecord {
    const value = this.getDerivativesAccount(accountKey);
    if (!value) throw new RecordNotFoundError("derivatives account", accountKey);
    return value;
  }

  private requireDerivativesContract(id: string): DerivativesContractRecord {
    const value = this.getDerivativesContract(id);
    if (!value) throw new RecordNotFoundError("derivatives contract", id);
    return value;
  }

  private requireDerivativesOrderIntent(id: string): DerivativesOrderIntentRecord {
    const row = this.database
      .prepare("SELECT * FROM derivatives_order_intents WHERE id = ?")
      .get(id) as SqlRow | undefined;
    if (!row) throw new RecordNotFoundError("derivatives order intent", id);
    return mapDerivativesOrderIntent(row);
  }

  private requireDerivativesOrder(
    id: string,
    accountKey?: DerivativesAccountKey,
  ): DerivativesOrderRecord {
    const value = this.getDerivativesOrder(id, accountKey);
    if (!value) throw new RecordNotFoundError("derivatives order", id);
    return value;
  }

  private requireDerivativesOrderByIntent(intentId: string): DerivativesOrderRecord {
    const row = this.database
      .prepare("SELECT * FROM derivatives_orders WHERE intent_id = ?")
      .get(intentId) as SqlRow | undefined;
    if (!row) throw new RecordNotFoundError("derivatives order for intent", intentId);
    return mapDerivativesOrder(row);
  }

  private requireDerivativesFill(id: string): DerivativesFillRecord {
    const row = this.database
      .prepare("SELECT * FROM derivatives_fills WHERE id = ?")
      .get(id) as SqlRow | undefined;
    if (!row) throw new RecordNotFoundError("derivatives fill", id);
    return mapDerivativesFill(row);
  }

  private applyOrderEventUnsafe(input: ApplyOrderEventInput): ApplyOrderEventResult {
    const duplicate = this.database
      .prepare(
        `SELECT * FROM order_events
         WHERE broker_id = ? AND environment = ? AND account_id = ? AND dedupe_key = ?`,
      )
      .get(...scopeParameters(input.scope), input.dedupeKey) as SqlRow | undefined;
    if (duplicate) {
      const event = mapOrderEvent(duplicate);
      return {
        applied: false,
        order: this.requireOrder(event.orderId, input.scope),
        event,
      };
    }

    const current = this.requireOrder(input.orderId, input.scope);
    if (
      !(input.allowCorrection ?? false) &&
      !ALLOWED_TRANSITIONS[current.status]!.has(input.toStatus)
    ) {
      throw new InvalidOrderTransitionError(current.status, input.toStatus);
    }

    const filledQuantity = input.filledQuantity ?? current.filledQuantity;
    if (filledQuantity < current.filledQuantity) {
      throw new Error(
        `Filled quantity cannot decrease: ${current.filledQuantity} -> ${filledQuantity}`,
      );
    }
    assertNonNegativeInteger("filledQuantity", filledQuantity);
    if (filledQuantity > current.orderedQuantity) {
      throw new Error(
        `Filled quantity ${filledQuantity} exceeds ordered quantity ${current.orderedQuantity}`,
      );
    }
    const remainingQuantity =
      input.remainingQuantity ??
      (input.filledQuantity === undefined
        ? current.remainingQuantity
        : current.orderedQuantity - filledQuantity);
    assertNonNegativeInteger("remainingQuantity", remainingQuantity);
    if (remainingQuantity > current.orderedQuantity) {
      throw new Error(
        `Remaining quantity ${remainingQuantity} exceeds ordered quantity ${current.orderedQuantity}`,
      );
    }
    const averageFillPrice = input.averageFillPrice ?? current.averageFillPrice;
    if (averageFillPrice !== null) {
      assertNonNegativeInteger("averageFillPrice", averageFillPrice);
    }
    const receivedAt = input.receivedAt ?? toIsoDateTime();
    // A locally-created intent owns its requested route (for example SOR), even
    // when a fill reports the actual execution venue (KRX or NXT). External
    // orders have no intent, so later broker data may refine their route.
    const exchange =
      current.intentId === null && input.exchange !== undefined
        ? input.exchange
        : current.exchange;
    this.database
      .prepare(
        `UPDATE orders SET
           broker_order_id = COALESCE(?, broker_order_id),
           original_broker_order_id = COALESCE(?, original_broker_order_id),
           filled_quantity = ?, remaining_quantity = ?,
           average_fill_price_krw = ?, status = ?,
           exchange = ?,
           broker_updated_at = COALESCE(?, broker_updated_at),
           raw_json = COALESCE(?, raw_json),
           revision = revision + 1, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        input.brokerOrderId ?? null,
        input.originalBrokerOrderId ?? null,
        filledQuantity,
        remainingQuantity,
        averageFillPrice,
        input.toStatus,
        exchange,
        input.brokerUpdatedAt ?? input.eventAt,
        input.raw === undefined ? null : stringifySafeJson(input.raw),
        receivedAt,
        current.id,
      );

    if (current.intentId) {
      this.database
        .prepare("UPDATE order_intents SET status = ?, updated_at = ? WHERE id = ?")
        .run(input.toStatus, receivedAt, current.intentId);

      if (input.toStatus === "FILLED") {
        this.database
          .prepare(
            `UPDATE risk_reservations SET status = 'CONSUMED', updated_at = ?
             WHERE intent_id = ? AND status = 'ACTIVE'`,
          )
          .run(receivedAt, current.intentId);
      } else if (input.toStatus === "CANCELED" || input.toStatus === "REJECTED") {
        this.database
          .prepare(
            `UPDATE risk_reservations SET status = 'RELEASED', updated_at = ?
             WHERE intent_id = ? AND status = 'ACTIVE'`,
          )
          .run(receivedAt, current.intentId);
      }

      if (input.toStatus === "UNKNOWN") {
        this.database
          .prepare(
            `UPDATE outbox SET
               status = 'BLOCKED', lease_owner = NULL, leased_until = NULL,
               last_error = 'Broker submission outcome is indeterminate', updated_at = ?
             WHERE aggregate_type = 'order_intent' AND aggregate_id = ?
               AND status NOT IN ('DONE', 'BLOCKED')`,
          )
          .run(receivedAt, current.intentId);
      } else if (input.toStatus !== "QUEUED" && input.toStatus !== "SENDING") {
        this.database
          .prepare(
            `UPDATE outbox SET
               status = 'DONE', lease_owner = NULL, leased_until = NULL,
               last_error = NULL, updated_at = ?
             WHERE aggregate_type = 'order_intent' AND aggregate_id = ?
               AND status <> 'DONE'`,
          )
          .run(receivedAt, current.intentId);
      }
    }

    const result = this.database
      .prepare(
        `INSERT INTO order_events (
           broker_id, environment, account_id, order_id, dedupe_key,
           broker_event_id, event_type, from_status, to_status,
           event_at, received_at, payload_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        ...scopeParameters(input.scope),
        current.id,
        input.dedupeKey,
        input.brokerEventId ?? null,
        input.eventType,
        current.status,
        input.toStatus,
        input.eventAt,
        receivedAt,
        stringifySafeJson({
          brokerOrderId: input.brokerOrderId ?? current.brokerOrderId,
          originalBrokerOrderId:
            input.originalBrokerOrderId ?? current.originalBrokerOrderId,
          exchange,
          filledQuantity,
          remainingQuantity,
          averageFillPrice,
          raw: input.raw ?? null,
        }),
      );
    const order = this.requireOrder(current.id, input.scope);
    const eventRow = this.database
      .prepare("SELECT * FROM order_events WHERE id = ?")
      .get(Number(result.lastInsertRowid)) as SqlRow;
    return { applied: true, order, event: mapOrderEvent(eventRow) };
  }

  private findActiveOrder(
    scope: AccountScope,
    symbol: string,
    side: "buy" | "sell",
  ): OrderRecord | null {
    const row = this.database
      .prepare(
        `SELECT * FROM orders
         WHERE broker_id = ? AND environment = ? AND account_id = ?
           AND symbol = ? AND side = ?
           AND remaining_quantity > 0
           AND status IN (
             'QUEUED', 'SENDING', 'ACKED', 'PARTIALLY_FILLED',
             'CANCEL_REQUESTED', 'AMEND_REQUESTED', 'AMENDED', 'UNKNOWN'
           )
         ORDER BY created_at ASC LIMIT 1`,
      )
      .get(...scopeParameters(scope), symbol, side) as SqlRow | undefined;
    return row ? mapOrder(row) : null;
  }

  private requireStrategyConfig(id: string): StrategyConfigVersionRecord {
    const record = this.getStrategyConfigVersion(id);
    if (!record) throw new RecordNotFoundError("strategy config", id);
    return record;
  }

  private requireOrderIntent(id: string): OrderIntentRecord {
    const record = this.getOrderIntent(id);
    if (!record) throw new RecordNotFoundError("order intent", id);
    return record;
  }

  private requireOrder(id: string, scope?: AccountScope): OrderRecord {
    const record = this.getOrder(id, scope);
    if (!record) throw new RecordNotFoundError("order", id);
    return record;
  }

  private requireOrderByIntent(intentId: string): OrderRecord {
    const row = this.database
      .prepare("SELECT * FROM orders WHERE intent_id = ?")
      .get(intentId) as SqlRow | undefined;
    if (!row) throw new RecordNotFoundError("order for intent", intentId);
    return mapOrder(row);
  }

  private requireFill(id: string): FillRecord {
    const row = this.database.prepare("SELECT * FROM fills WHERE id = ?").get(id) as
      | SqlRow
      | undefined;
    if (!row) throw new RecordNotFoundError("fill", id);
    return mapFill(row);
  }

  private requireBalanceSnapshot(id: number): BalanceSnapshotRecord {
    const row = this.database
      .prepare("SELECT * FROM balance_snapshots WHERE id = ?")
      .get(id) as SqlRow | undefined;
    if (!row) throw new RecordNotFoundError("balance snapshot", String(id));
    return mapBalanceSnapshot(row);
  }

  private requireOutbox(id: string): OutboxRecord {
    const record = this.getOutbox(id);
    if (!record) throw new RecordNotFoundError("outbox", id);
    return record;
  }

  private requireOutboxByAggregate(aggregateType: string, aggregateId: string): OutboxRecord {
    const row = this.database
      .prepare(
        `SELECT * FROM outbox
         WHERE aggregate_type = ? AND aggregate_id = ? ORDER BY created_at LIMIT 1`,
      )
      .get(aggregateType, aggregateId) as SqlRow | undefined;
    if (!row) {
      throw new RecordNotFoundError("outbox aggregate", `${aggregateType}/${aggregateId}`);
    }
    return mapOutbox(row);
  }

  private requireErrorLog(id: number): ErrorLogRecord {
    const row = this.database.prepare("SELECT * FROM error_logs WHERE id = ?").get(id) as
      | SqlRow
      | undefined;
    if (!row) throw new RecordNotFoundError("error log", String(id));
    return mapErrorLog(row);
  }

  private requireAuditLog(id: number): AuditLogRecord {
    const row = this.database.prepare("SELECT * FROM audit_log WHERE id = ?").get(id) as
      | SqlRow
      | undefined;
    if (!row) throw new RecordNotFoundError("audit log", String(id));
    return mapAuditLog(row);
  }
}

export function openTradingRepository(
  options: TradingRepositoryOptions | string,
): TradingRepository {
  return new TradingRepository(options);
}

export function createInMemoryTradingRepository(): TradingRepository {
  return new TradingRepository({ filename: ":memory:", ensureDirectory: false });
}

function scopeParameters(
  scope: AccountScope,
): [AccountScope["brokerId"], AccountScope["environment"], string] {
  return [scope.brokerId, scope.environment, scope.accountId];
}

function nullableScopeParameters(
  scope: AccountScope | undefined,
): [AccountScope["brokerId"] | null, AccountScope["environment"] | null, string | null] {
  return scope ? scopeParameters(scope) : [null, null, null];
}

function mapScope(row: SqlRow): AccountScope {
  return {
    brokerId: requiredString(row, "broker_id") as AccountScope["brokerId"],
    environment: requiredString(row, "environment") as AccountScope["environment"],
    accountId: requiredString(row, "account_id"),
  };
}

function mapNullableScope(row: SqlRow): AccountScope | null {
  if (row.broker_id === null || row.broker_id === undefined) return null;
  return mapScope(row);
}

function mapInstrument(row: SqlRow): Instrument {
  const listedDate = nullableString(row, "listed_date");
  const delistedDate = nullableString(row, "delisted_date");
  const raw = nullableJson(row, "raw_json");
  return {
    symbol: requiredString(row, "symbol"),
    name: requiredString(row, "name"),
    market: requiredString(row, "market") as Instrument["market"],
    exchange: requiredString(row, "exchange") as Instrument["exchange"],
    active: requiredNumber(row, "active") === 1,
    ...(listedDate === null ? {} : { listedDate }),
    ...(delistedDate === null ? {} : { delistedDate }),
    ...(raw === null ? {} : { raw }),
  };
}

function mapDailyBar(row: SqlRow): DailyBar {
  return {
    symbol: requiredString(row, "symbol"),
    tradingDate: requiredString(row, "trading_date"),
    open: requiredNumber(row, "open_krw"),
    high: requiredNumber(row, "high_krw"),
    low: requiredNumber(row, "low_krw"),
    close: requiredNumber(row, "close_krw"),
    volume: requiredNumber(row, "volume"),
    adjusted: requiredNumber(row, "adjusted") === 1,
  };
}

function mapQuote(row: SqlRow): Quote {
  const open = nullableNumber(row, "open_krw");
  const high = nullableNumber(row, "high_krw");
  const low = nullableNumber(row, "low_krw");
  return {
    symbol: requiredString(row, "symbol"),
    price: requiredNumber(row, "price_krw"),
    cumulativeVolume: requiredNumber(row, "cumulative_volume"),
    tradingDate: requiredString(row, "trading_date"),
    tradingTime: requiredString(row, "trading_time"),
    receivedAt: requiredString(row, "received_at"),
    source: requiredString(row, "source_broker_id") as Quote["source"],
    exchange: requiredString(row, "exchange") as Quote["exchange"],
    stale: requiredNumber(row, "stale") === 1,
    ...(open === null ? {} : { open }),
    ...(high === null ? {} : { high }),
    ...(low === null ? {} : { low }),
  };
}

function mapStrategyConfig(row: SqlRow): StrategyConfigVersionRecord {
  return {
    id: requiredString(row, "id"),
    strategyId: requiredString(row, "strategy_id"),
    strategyVersion: requiredString(row, "strategy_version"),
    configVersion: requiredNumber(row, "config_version"),
    configHash: requiredString(row, "config_hash"),
    config: parseJson(row.config_json),
    createdAt: requiredString(row, "created_at"),
  };
}

function mapStrategyAssignment(row: SqlRow): StrategyAssignmentRecord {
  return {
    scope: mapScope(row),
    strategyConfigId: requiredString(row, "strategy_config_id"),
    enabled: requiredNumber(row, "enabled") === 1,
    assignedAt: requiredString(row, "assigned_at"),
    updatedAt: requiredString(row, "updated_at"),
  };
}

function mapSignal(row: SqlRow): SignalRecord {
  return {
    id: requiredString(row, "id"),
    scope: mapScope(row),
    strategyConfigId: requiredString(row, "strategy_config_id"),
    symbol: requiredString(row, "symbol"),
    action: requiredString(row, "action") as SignalRecord["action"],
    reasonCodes: parseJson<string[]>(row.reason_codes_json),
    metrics: parseJson<SignalRecord["metrics"]>(row.metrics_json),
    inputHash: requiredString(row, "input_hash"),
    observedAt: requiredString(row, "observed_at"),
    createdAt: requiredString(row, "created_at"),
  };
}

function mapOrderIntent(row: SqlRow): OrderIntentRecord {
  return {
    id: requiredString(row, "id"),
    scope: mapScope(row),
    signalId: nullableString(row, "signal_id"),
    idempotencyKey: requiredString(row, "idempotency_key"),
    clientOrderId: requiredString(row, "client_order_id"),
    symbol: requiredString(row, "symbol"),
    side: requiredString(row, "side") as OrderIntentRecord["side"],
    orderType: requiredString(row, "order_type") as OrderIntentRecord["orderType"],
    quantity: requiredNumber(row, "quantity"),
    limitPrice: nullableNumber(row, "limit_price_krw"),
    exchange: requiredString(row, "exchange") as OrderIntentRecord["exchange"],
    status: requiredString(row, "status") as OrderStatus,
    createdAt: requiredString(row, "created_at"),
    updatedAt: requiredString(row, "updated_at"),
  };
}

function mapOrder(row: SqlRow): OrderRecord {
  return {
    id: requiredString(row, "id"),
    intentId: nullableString(row, "intent_id"),
    scope: mapScope(row),
    brokerOrderId: nullableString(row, "broker_order_id"),
    originalBrokerOrderId: nullableString(row, "original_broker_order_id"),
    exchange: requiredString(row, "exchange") as OrderRecord["exchange"],
    symbol: requiredString(row, "symbol"),
    side: requiredString(row, "side") as OrderRecord["side"],
    orderType: requiredString(row, "order_type") as OrderRecord["orderType"],
    orderedQuantity: requiredNumber(row, "ordered_quantity"),
    filledQuantity: requiredNumber(row, "filled_quantity"),
    remainingQuantity: requiredNumber(row, "remaining_quantity"),
    limitPrice: nullableNumber(row, "limit_price_krw"),
    averageFillPrice: nullableNumber(row, "average_fill_price_krw"),
    status: requiredString(row, "status") as OrderStatus,
    orderedAt: requiredString(row, "ordered_at"),
    brokerUpdatedAt: nullableString(row, "broker_updated_at"),
    revision: requiredNumber(row, "revision"),
    raw: nullableJson(row, "raw_json"),
    createdAt: requiredString(row, "created_at"),
    updatedAt: requiredString(row, "updated_at"),
  };
}

function mapOrderEvent(row: SqlRow): OrderEventRecord {
  return {
    id: requiredNumber(row, "id"),
    scope: mapScope(row),
    orderId: requiredString(row, "order_id"),
    dedupeKey: requiredString(row, "dedupe_key"),
    brokerEventId: nullableString(row, "broker_event_id"),
    eventType: requiredString(row, "event_type"),
    fromStatus: nullableString(row, "from_status") as OrderStatus | null,
    toStatus: requiredString(row, "to_status") as OrderStatus,
    eventAt: requiredString(row, "event_at"),
    receivedAt: requiredString(row, "received_at"),
    payload: parseJson(row.payload_json),
  };
}

function mapFill(row: SqlRow): FillRecord {
  return {
    id: requiredString(row, "id"),
    scope: mapScope(row),
    orderId: requiredString(row, "order_id"),
    brokerExecutionId: requiredString(row, "broker_execution_id"),
    brokerOrderId: requiredString(row, "broker_order_id"),
    symbol: requiredString(row, "symbol"),
    side: requiredString(row, "side") as FillRecord["side"],
    quantity: requiredNumber(row, "quantity"),
    price: requiredNumber(row, "price_krw"),
    fee: requiredNumber(row, "fee_krw"),
    tax: requiredNumber(row, "tax_krw"),
    executedAt: requiredString(row, "executed_at"),
    receivedAt: requiredString(row, "received_at"),
    raw: nullableJson(row, "raw_json"),
  };
}

function mapPosition(row: SqlRow): BrokerPosition {
  const name = nullableString(row, "name");
  return {
    symbol: requiredString(row, "symbol"),
    quantity: requiredNumber(row, "quantity"),
    availableQuantity: requiredNumber(row, "available_quantity"),
    averagePrice: requiredNumber(row, "average_price_krw"),
    currentPrice: requiredNumber(row, "current_price_krw"),
    marketValue: requiredNumber(row, "market_value_krw"),
    unrealizedPnl: requiredNumber(row, "unrealized_pnl_krw"),
    unrealizedPnlBps: requiredNumber(row, "unrealized_pnl_bps"),
    ...(name === null ? {} : { name }),
  };
}

function mapBalanceSnapshot(row: SqlRow): BalanceSnapshotRecord {
  return {
    id: requiredNumber(row, "id"),
    scope: mapScope(row),
    cash: requiredNumber(row, "cash_krw"),
    availableCash: requiredNumber(row, "available_cash_krw"),
    totalEvaluation: requiredNumber(row, "total_evaluation_krw"),
    realizedPnlToday: requiredNumber(row, "realized_pnl_today_krw"),
    unrealizedPnl: requiredNumber(row, "unrealized_pnl_krw"),
    fetchedAt: requiredString(row, "fetched_at"),
    raw: nullableJson(row, "raw_json"),
  };
}

function mapDailyPnl(row: SqlRow): DailyPnlRecord {
  return {
    scope: mapScope(row),
    tradingDate: requiredString(row, "trading_date"),
    realizedPnl: requiredNumber(row, "realized_pnl_krw"),
    unrealizedPnl: requiredNumber(row, "unrealized_pnl_krw"),
    totalPnl: requiredNumber(row, "total_pnl_krw"),
    totalEvaluation: requiredNumber(row, "total_evaluation_krw"),
    updatedAt: requiredString(row, "updated_at"),
  };
}

function mapRiskReservation(row: SqlRow): RiskReservationRecord {
  return {
    intentId: requiredString(row, "intent_id"),
    scope: mapScope(row),
    budgetKey: requiredString(row, "budget_key"),
    amount: requiredNumber(row, "amount_krw"),
    status: requiredString(row, "status") as RiskReservationRecord["status"],
    createdAt: requiredString(row, "created_at"),
    updatedAt: requiredString(row, "updated_at"),
  };
}

function mapHealthEvent(row: SqlRow): HealthEventRecord {
  return {
    id: requiredNumber(row, "id"),
    scope: mapScope(row),
    health: parseJson<BrokerHealth>(row.payload_json),
    occurredAt: requiredString(row, "occurred_at"),
  };
}

function mapErrorLog(row: SqlRow): ErrorLogRecord {
  return {
    id: requiredNumber(row, "id"),
    scope: mapNullableScope(row),
    severity: requiredString(row, "severity") as ErrorLogRecord["severity"],
    code: nullableString(row, "code"),
    message: requiredString(row, "message"),
    details: nullableJson(row, "details_json"),
    occurredAt: requiredString(row, "occurred_at"),
  };
}

function mapAuditLog(row: SqlRow): AuditLogRecord {
  return {
    id: requiredNumber(row, "id"),
    actor: requiredString(row, "actor"),
    action: requiredString(row, "action"),
    scope: mapNullableScope(row),
    entityType: nullableString(row, "entity_type"),
    entityId: nullableString(row, "entity_id"),
    payload: parseJson(row.payload_json),
    occurredAt: requiredString(row, "occurred_at"),
  };
}

function mapOutbox(row: SqlRow): OutboxRecord {
  return {
    id: requiredString(row, "id"),
    scope: mapScope(row),
    aggregateType: requiredString(row, "aggregate_type"),
    aggregateId: requiredString(row, "aggregate_id"),
    eventType: requiredString(row, "event_type"),
    dedupeKey: requiredString(row, "dedupe_key"),
    payload: parseJson(row.payload_json),
    status: requiredString(row, "status") as OutboxRecord["status"],
    attempts: requiredNumber(row, "attempts"),
    availableAt: requiredString(row, "available_at"),
    leasedUntil: nullableString(row, "leased_until"),
    leaseOwner: nullableString(row, "lease_owner"),
    lastError: nullableString(row, "last_error"),
    createdAt: requiredString(row, "created_at"),
    updatedAt: requiredString(row, "updated_at"),
  };
}

function mapDerivativesAccount(row: SqlRow): DerivativesAccountRecord {
  return {
    accountKey: requiredString(row, "account_key") as DerivativesAccountKey,
    scope: {
      providerId: requiredString(row, "provider_id") as DerivativesAccountRecord["scope"]["providerId"],
      product: "derivatives",
      environment: requiredString(row, "environment") as DerivativesAccountRecord["scope"]["environment"],
      accountId: requiredString(row, "account_id"),
      accountProductCode: requiredString(row, "account_product_code"),
    },
    enabled: requiredNumber(row, "enabled") === 1,
    createdAt: requiredString(row, "created_at"),
    updatedAt: requiredString(row, "updated_at"),
  };
}

function mapDerivativesContract(row: SqlRow): DerivativesContractRecord {
  const raw = nullableJson(row, "raw_json");
  return {
    id: requiredString(row, "id"),
    providerId: requiredString(row, "provider_id") as DerivativesContractRecord["providerId"],
    contractCode: requiredString(row, "contract_code"),
    name: requiredString(row, "name"),
    contractType: requiredString(row, "contract_type") as DerivativesContractRecord["contractType"],
    underlyingCode: requiredString(row, "underlying_code"),
    multiplierKrw: requiredNumber(row, "multiplier_krw"),
    priceScale: requiredNumber(row, "price_scale"),
    expiryDate: requiredString(row, "expiry_date"),
    active: requiredNumber(row, "active") === 1,
    ...(raw === null ? {} : { raw }),
    createdAt: requiredString(row, "created_at"),
    updatedAt: requiredString(row, "updated_at"),
  };
}

function mapDerivativesOrderIntent(row: SqlRow): DerivativesOrderIntentRecord {
  return {
    id: requiredString(row, "id"),
    accountKey: requiredString(row, "account_key") as DerivativesAccountKey,
    idempotencyKey: requiredString(row, "idempotency_key"),
    clientOrderId: requiredString(row, "client_order_id"),
    contractId: requiredString(row, "contract_id"),
    action: requiredString(row, "action") as DerivativesOrderIntentRecord["action"],
    direction: requiredString(row, "direction") as DerivativesOrderIntentRecord["direction"],
    purpose: requiredString(row, "purpose") as DerivativesOrderIntentRecord["purpose"],
    quantity: requiredNumber(row, "quantity"),
    limitPriceTicks: nullableNumber(row, "limit_price_ticks"),
    status: requiredString(row, "status") as OrderStatus,
    createdAt: requiredString(row, "created_at"),
    updatedAt: requiredString(row, "updated_at"),
  };
}

function mapDerivativesOrder(row: SqlRow): DerivativesOrderRecord {
  return {
    id: requiredString(row, "id"),
    intentId: requiredString(row, "intent_id"),
    accountKey: requiredString(row, "account_key") as DerivativesAccountKey,
    brokerOrderId: nullableString(row, "broker_order_id"),
    originalBrokerOrderId: nullableString(row, "original_broker_order_id"),
    contractId: requiredString(row, "contract_id"),
    action: requiredString(row, "action") as DerivativesOrderRecord["action"],
    direction: requiredString(row, "direction") as DerivativesOrderRecord["direction"],
    purpose: requiredString(row, "purpose") as DerivativesOrderRecord["purpose"],
    orderedQuantity: requiredNumber(row, "ordered_quantity"),
    filledQuantity: requiredNumber(row, "filled_quantity"),
    remainingQuantity: requiredNumber(row, "remaining_quantity"),
    limitPriceTicks: nullableNumber(row, "limit_price_ticks"),
    averageFillPriceTicks: nullableNumber(row, "average_fill_price_ticks"),
    status: requiredString(row, "status") as OrderStatus,
    orderedAt: requiredString(row, "ordered_at"),
    brokerUpdatedAt: nullableString(row, "broker_updated_at"),
    raw: nullableJson(row, "raw_json"),
    createdAt: requiredString(row, "created_at"),
    updatedAt: requiredString(row, "updated_at"),
  };
}

function mapDerivativesFill(row: SqlRow): DerivativesFillRecord {
  return {
    id: requiredString(row, "id"),
    accountKey: requiredString(row, "account_key") as DerivativesAccountKey,
    orderId: requiredString(row, "order_id"),
    brokerExecutionId: requiredString(row, "broker_execution_id"),
    brokerOrderId: requiredString(row, "broker_order_id"),
    quantity: requiredNumber(row, "quantity"),
    priceTicks: requiredNumber(row, "price_ticks"),
    feeKrw: requiredNumber(row, "fee_krw"),
    executedAt: requiredString(row, "executed_at"),
    receivedAt: requiredString(row, "received_at"),
    raw: nullableJson(row, "raw_json"),
  };
}

function mapDerivativesPosition(row: SqlRow): DerivativesPositionRecord {
  return {
    accountKey: requiredString(row, "account_key") as DerivativesAccountKey,
    contractId: requiredString(row, "contract_id"),
    netQuantity: requiredNumber(row, "net_quantity"),
    averagePriceTicks: requiredNumber(row, "average_price_ticks"),
    currentPriceTicks: requiredNumber(row, "current_price_ticks"),
    marginRequiredKrw: requiredNumber(row, "margin_required_krw"),
    unrealizedPnlKrw: requiredNumber(row, "unrealized_pnl_krw"),
    brokerUpdatedAt: requiredString(row, "broker_updated_at"),
    raw: nullableJson(row, "raw_json"),
    updatedAt: requiredString(row, "updated_at"),
  };
}

function mapDerivativesPurposeLedger(row: SqlRow): DerivativesPurposeLedgerRecord {
  return {
    accountKey: requiredString(row, "account_key") as DerivativesAccountKey,
    contractId: requiredString(row, "contract_id"),
    purpose: requiredString(row, "purpose") as DerivativesPositionPurpose,
    signedQuantity: requiredNumber(row, "signed_quantity"),
    averagePriceTicks: requiredNumber(row, "average_price_ticks"),
    realizedPnlKrw: requiredNumber(row, "realized_pnl_krw"),
    updatedAt: requiredString(row, "updated_at"),
  };
}

function mapDerivativesHedgeTarget(row: SqlRow): DerivativesHedgeTargetRecord {
  return {
    accountKey: requiredString(row, "account_key") as DerivativesAccountKey,
    contractId: requiredString(row, "contract_id"),
    sourceEquityExposureKrw: requiredNumber(row, "source_equity_exposure_krw"),
    hedgeRatioBps: requiredNumber(row, "hedge_ratio_bps"),
    targetSignedQuantity: requiredNumber(row, "target_signed_quantity"),
    actualHedgeSignedQuantity: requiredNumber(row, "actual_hedge_signed_quantity"),
    inputHash: requiredString(row, "input_hash"),
    status: requiredString(row, "status") as DerivativesHedgeTargetRecord["status"],
    updatedAt: requiredString(row, "updated_at"),
  };
}

function mapEngineLease(row: SqlRow): EngineLeaseRecord {
  return {
    name: requiredString(row, "name"),
    ownerId: requiredString(row, "owner_id"),
    acquiredAt: requiredString(row, "acquired_at"),
    heartbeatAt: requiredString(row, "heartbeat_at"),
    expiresAt: requiredString(row, "expires_at"),
  };
}

function validatePlaceOrder(request: CreateOrderIntentInput["request"]): void {
  assertPositiveInteger("order.quantity", request.quantity);
  if (request.orderType === "limit") {
    if (request.limitPrice === undefined) {
      throw new Error("limitPrice is required for limit orders");
    }
    assertPositiveInteger("order.limitPrice", request.limitPrice);
  } else if (request.limitPrice !== undefined) {
    assertNonNegativeInteger("order.limitPrice", request.limitPrice);
  }
}

function validateBrokerOrder(order: BrokerOrder): void {
  assertPositiveInteger("brokerOrder.orderedQuantity", order.orderedQuantity);
  assertNonNegativeInteger("brokerOrder.filledQuantity", order.filledQuantity);
  assertNonNegativeInteger("brokerOrder.remainingQuantity", order.remainingQuantity);
  if (order.filledQuantity > order.orderedQuantity) {
    throw new Error("Broker order filled quantity exceeds ordered quantity");
  }
  if (order.remainingQuantity > order.orderedQuantity) {
    throw new Error("Broker order remaining quantity exceeds ordered quantity");
  }
  if (order.limitPrice !== undefined) {
    assertNonNegativeInteger("brokerOrder.limitPrice", order.limitPrice);
  }
}

function validatePosition(position: BrokerPosition): void {
  assertNonNegativeInteger("position.quantity", position.quantity);
  assertNonNegativeInteger("position.availableQuantity", position.availableQuantity);
  assertNonNegativeInteger("position.averagePrice", position.averagePrice);
  assertNonNegativeInteger("position.currentPrice", position.currentPrice);
  assertSafeInteger("position.marketValue", position.marketValue);
  assertSafeInteger("position.unrealizedPnl", position.unrealizedPnl);
  assertSafeInteger("position.unrealizedPnlBps", position.unrealizedPnlBps);
}

function assertPositiveInteger(name: string, value: number): void {
  assertSafeInteger(name, value);
  if (value <= 0) throw new RangeError(`${name} must be a positive integer`);
}

function assertNonNegativeInteger(name: string, value: number): void {
  assertSafeInteger(name, value);
  if (value < 0) throw new RangeError(`${name} must be a non-negative integer`);
}

function assertSafeInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value)) throw new TypeError(`${name} must be a safe integer`);
}

function assertNonEmptyString(name: string, value: string): void {
  if (value.trim().length === 0) throw new TypeError(`${name} must not be empty`);
}

function requiredString(row: SqlRow, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new TypeError(`Expected string column ${key}`);
  return value;
}

function nullableString(row: SqlRow, key: string): string | null {
  const value = row[key];
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new TypeError(`Expected nullable string column ${key}`);
  return value;
}

function requiredNumber(row: SqlRow, key: string): number {
  const value = row[key];
  if (typeof value === "bigint") return Number(value);
  if (typeof value !== "number") throw new TypeError(`Expected number column ${key}`);
  return value;
}

function nullableNumber(row: SqlRow, key: string): number | null {
  const value = row[key];
  if (value === null || value === undefined) return null;
  if (typeof value === "bigint") return Number(value);
  if (typeof value !== "number") throw new TypeError(`Expected nullable number column ${key}`);
  return value;
}

function parseJson<T = unknown>(value: unknown): T {
  if (typeof value !== "string") throw new TypeError("Expected serialized JSON string");
  return JSON.parse(value) as T;
}

function nullableJson(row: SqlRow, key: string): unknown {
  const value = row[key];
  return value === null || value === undefined ? null : parseJson(value);
}

function stringifyJson(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new TypeError("Value is not JSON serializable");
  return serialized;
}

function stringifySafeJson(value: unknown): string {
  return stringifyJson(redactSensitive(value));
}

function toSqlBoolean(value: boolean): 0 | 1 {
  return value ? 1 : 0;
}

function placeholders(count: number): string {
  if (!Number.isInteger(count) || count <= 0) throw new RangeError("count must be positive");
  return Array.from({ length: count }, () => "?").join(", ");
}

function normalizeLimit(
  value: number | undefined,
  defaultValue: number,
  maximum: number,
): number {
  const normalized = value ?? defaultValue;
  assertPositiveInteger("limit", normalized);
  return Math.min(normalized, maximum);
}

function runtimeScopeKey(scope: RuntimeScope): string {
  if (!scope) return "global";
  return `account:${scope.brokerId}:${scope.environment}:${encodeURIComponent(scope.accountId)}`;
}

function addMilliseconds(isoDateTime: string, milliseconds: number): string {
  const epoch = Date.parse(isoDateTime);
  if (!Number.isFinite(epoch)) throw new TypeError(`Invalid ISO date-time: ${isoDateTime}`);
  return new Date(epoch + milliseconds).toISOString();
}
