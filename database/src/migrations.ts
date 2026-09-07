import type BetterSqlite3 from "better-sqlite3";

export const LATEST_SCHEMA_VERSION = 5;

interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

const ACCOUNT_SCOPE_COLUMNS = `
  broker_id TEXT NOT NULL CHECK (broker_id IN ('kiwoom', 'koreainvestment')),
  environment TEXT NOT NULL CHECK (environment IN ('live', 'paper')),
  account_id TEXT NOT NULL
`;

const migrations: readonly Migration[] = [
  {
    version: 1,
    name: "initial_trading_store",
    sql: `
      CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version > 0),
        updated_at TEXT NOT NULL
      );

      CREATE TABLE instruments (
        symbol TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        market TEXT NOT NULL CHECK (market = 'KOSPI'),
        exchange TEXT NOT NULL CHECK (exchange IN ('KRX', 'NXT', 'SOR')),
        active INTEGER NOT NULL CHECK (active IN (0, 1)),
        listed_date TEXT,
        delisted_date TEXT,
        raw_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_instruments_active_market
        ON instruments (active, market, symbol);

      CREATE TABLE daily_bars (
        symbol TEXT NOT NULL,
        trading_date TEXT NOT NULL,
        open_krw INTEGER NOT NULL CHECK (open_krw >= 0),
        high_krw INTEGER NOT NULL CHECK (high_krw >= 0),
        low_krw INTEGER NOT NULL CHECK (low_krw >= 0),
        close_krw INTEGER NOT NULL CHECK (close_krw >= 0),
        volume INTEGER NOT NULL CHECK (volume >= 0),
        adjusted INTEGER NOT NULL CHECK (adjusted IN (0, 1)),
        source_broker_id TEXT NOT NULL CHECK (source_broker_id IN ('kiwoom', 'koreainvestment')),
        received_at TEXT NOT NULL,
        PRIMARY KEY (symbol, trading_date),
        FOREIGN KEY (symbol) REFERENCES instruments(symbol) ON UPDATE CASCADE ON DELETE RESTRICT
      );
      CREATE INDEX idx_daily_bars_symbol_date_desc
        ON daily_bars (symbol, trading_date DESC);

      CREATE TABLE latest_quotes (
        source_broker_id TEXT NOT NULL CHECK (source_broker_id IN ('kiwoom', 'koreainvestment')),
        symbol TEXT NOT NULL,
        price_krw INTEGER NOT NULL CHECK (price_krw >= 0),
        open_krw INTEGER CHECK (open_krw IS NULL OR open_krw >= 0),
        high_krw INTEGER CHECK (high_krw IS NULL OR high_krw >= 0),
        low_krw INTEGER CHECK (low_krw IS NULL OR low_krw >= 0),
        cumulative_volume INTEGER NOT NULL CHECK (cumulative_volume >= 0),
        trading_date TEXT NOT NULL,
        trading_time TEXT NOT NULL,
        received_at TEXT NOT NULL,
        stale INTEGER NOT NULL DEFAULT 0 CHECK (stale IN (0, 1)),
        PRIMARY KEY (source_broker_id, symbol)
      );
      CREATE INDEX idx_latest_quotes_received_at
        ON latest_quotes (received_at DESC);

      CREATE TABLE strategy_config_versions (
        id TEXT PRIMARY KEY,
        strategy_id TEXT NOT NULL,
        strategy_version TEXT NOT NULL,
        config_version INTEGER NOT NULL CHECK (config_version > 0),
        config_hash TEXT NOT NULL,
        config_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (strategy_id, config_version),
        UNIQUE (strategy_id, strategy_version, config_hash)
      );

      CREATE TABLE strategy_assignments (
        ${ACCOUNT_SCOPE_COLUMNS},
        strategy_config_id TEXT NOT NULL,
        enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
        assigned_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (broker_id, environment, account_id),
        FOREIGN KEY (strategy_config_id) REFERENCES strategy_config_versions(id) ON DELETE RESTRICT
      );
      CREATE INDEX idx_strategy_assignments_config
        ON strategy_assignments (strategy_config_id, enabled);

      CREATE TABLE signals (
        id TEXT PRIMARY KEY,
        ${ACCOUNT_SCOPE_COLUMNS},
        strategy_config_id TEXT NOT NULL,
        symbol TEXT NOT NULL,
        action TEXT NOT NULL CHECK (action IN ('BUY', 'SELL', 'HOLD', 'NOT_READY')),
        reason_codes_json TEXT NOT NULL,
        metrics_json TEXT NOT NULL,
        input_hash TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (
          broker_id, environment, account_id,
          strategy_config_id, symbol, action, input_hash
        ),
        FOREIGN KEY (strategy_config_id) REFERENCES strategy_config_versions(id) ON DELETE RESTRICT
      );
      CREATE INDEX idx_signals_scope_observed
        ON signals (broker_id, environment, account_id, observed_at DESC);
      CREATE INDEX idx_signals_symbol_observed
        ON signals (symbol, observed_at DESC);

      CREATE TABLE order_intents (
        id TEXT PRIMARY KEY,
        ${ACCOUNT_SCOPE_COLUMNS},
        signal_id TEXT,
        idempotency_key TEXT NOT NULL,
        client_order_id TEXT NOT NULL,
        symbol TEXT NOT NULL,
        side TEXT NOT NULL CHECK (side IN ('buy', 'sell')),
        order_type TEXT NOT NULL CHECK (order_type IN ('market', 'limit')),
        quantity INTEGER NOT NULL CHECK (quantity > 0),
        limit_price_krw INTEGER CHECK (limit_price_krw IS NULL OR limit_price_krw > 0),
        exchange TEXT NOT NULL CHECK (exchange IN ('KRX', 'NXT', 'SOR')),
        status TEXT NOT NULL CHECK (status IN (
          'QUEUED', 'SENDING', 'ACKED', 'PARTIALLY_FILLED', 'FILLED',
          'CANCEL_REQUESTED', 'CANCELED', 'AMEND_REQUESTED', 'AMENDED',
          'REJECTED', 'UNKNOWN'
        )),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (broker_id, environment, account_id, idempotency_key),
        UNIQUE (broker_id, environment, account_id, client_order_id),
        FOREIGN KEY (signal_id) REFERENCES signals(id) ON DELETE SET NULL
      );
      CREATE UNIQUE INDEX ux_order_intents_active_guard
        ON order_intents (broker_id, environment, account_id, symbol, side)
        WHERE status IN (
          'QUEUED', 'SENDING', 'ACKED', 'PARTIALLY_FILLED',
          'CANCEL_REQUESTED', 'AMEND_REQUESTED', 'AMENDED', 'UNKNOWN'
        );
      CREATE INDEX idx_order_intents_scope_created
        ON order_intents (broker_id, environment, account_id, created_at DESC);

      CREATE TABLE orders (
        id TEXT PRIMARY KEY,
        intent_id TEXT UNIQUE,
        ${ACCOUNT_SCOPE_COLUMNS},
        broker_order_id TEXT,
        original_broker_order_id TEXT,
        symbol TEXT NOT NULL,
        side TEXT NOT NULL CHECK (side IN ('buy', 'sell')),
        order_type TEXT NOT NULL CHECK (order_type IN ('market', 'limit')),
        ordered_quantity INTEGER NOT NULL CHECK (ordered_quantity > 0),
        filled_quantity INTEGER NOT NULL DEFAULT 0 CHECK (filled_quantity >= 0),
        remaining_quantity INTEGER NOT NULL CHECK (remaining_quantity >= 0),
        limit_price_krw INTEGER CHECK (limit_price_krw IS NULL OR limit_price_krw > 0),
        average_fill_price_krw INTEGER CHECK (average_fill_price_krw IS NULL OR average_fill_price_krw >= 0),
        status TEXT NOT NULL CHECK (status IN (
          'QUEUED', 'SENDING', 'ACKED', 'PARTIALLY_FILLED', 'FILLED',
          'CANCEL_REQUESTED', 'CANCELED', 'AMEND_REQUESTED', 'AMENDED',
          'REJECTED', 'UNKNOWN'
        )),
        ordered_at TEXT NOT NULL,
        broker_updated_at TEXT,
        revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
        raw_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK (filled_quantity <= ordered_quantity),
        CHECK (remaining_quantity <= ordered_quantity),
        FOREIGN KEY (intent_id) REFERENCES order_intents(id) ON DELETE RESTRICT
      );
      CREATE UNIQUE INDEX ux_orders_broker_order_id
        ON orders (broker_id, environment, account_id, broker_order_id)
        WHERE broker_order_id IS NOT NULL;
      CREATE UNIQUE INDEX ux_orders_active_guard
        ON orders (broker_id, environment, account_id, symbol, side)
        WHERE status IN (
          'QUEUED', 'SENDING', 'ACKED', 'PARTIALLY_FILLED',
          'CANCEL_REQUESTED', 'AMEND_REQUESTED', 'AMENDED', 'UNKNOWN'
        );
      CREATE INDEX idx_orders_scope_status_updated
        ON orders (broker_id, environment, account_id, status, updated_at DESC);

      CREATE TABLE order_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ${ACCOUNT_SCOPE_COLUMNS},
        order_id TEXT NOT NULL,
        dedupe_key TEXT NOT NULL,
        broker_event_id TEXT,
        event_type TEXT NOT NULL,
        from_status TEXT,
        to_status TEXT NOT NULL,
        event_at TEXT NOT NULL,
        received_at TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        UNIQUE (broker_id, environment, account_id, dedupe_key),
        FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE RESTRICT
      );
      CREATE INDEX idx_order_events_order_id
        ON order_events (order_id, id);
      CREATE INDEX idx_order_events_scope_received
        ON order_events (broker_id, environment, account_id, received_at DESC);

      CREATE TABLE fills (
        id TEXT PRIMARY KEY,
        ${ACCOUNT_SCOPE_COLUMNS},
        order_id TEXT NOT NULL,
        broker_execution_id TEXT NOT NULL,
        broker_order_id TEXT NOT NULL,
        symbol TEXT NOT NULL,
        side TEXT NOT NULL CHECK (side IN ('buy', 'sell')),
        quantity INTEGER NOT NULL CHECK (quantity > 0),
        price_krw INTEGER NOT NULL CHECK (price_krw >= 0),
        fee_krw INTEGER NOT NULL DEFAULT 0 CHECK (fee_krw >= 0),
        tax_krw INTEGER NOT NULL DEFAULT 0 CHECK (tax_krw >= 0),
        executed_at TEXT NOT NULL,
        received_at TEXT NOT NULL,
        raw_json TEXT,
        UNIQUE (broker_id, environment, account_id, broker_execution_id),
        FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE RESTRICT
      );
      CREATE INDEX idx_fills_scope_executed
        ON fills (broker_id, environment, account_id, executed_at DESC);
      CREATE INDEX idx_fills_order_id ON fills (order_id, executed_at);

      CREATE TABLE positions (
        ${ACCOUNT_SCOPE_COLUMNS},
        symbol TEXT NOT NULL,
        name TEXT,
        quantity INTEGER NOT NULL CHECK (quantity >= 0),
        available_quantity INTEGER NOT NULL CHECK (available_quantity >= 0),
        average_price_krw INTEGER NOT NULL CHECK (average_price_krw >= 0),
        current_price_krw INTEGER NOT NULL CHECK (current_price_krw >= 0),
        market_value_krw INTEGER NOT NULL,
        unrealized_pnl_krw INTEGER NOT NULL,
        unrealized_pnl_bps INTEGER NOT NULL,
        fetched_at TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
        PRIMARY KEY (broker_id, environment, account_id, symbol)
      );
      CREATE INDEX idx_positions_scope_quantity
        ON positions (broker_id, environment, account_id, quantity DESC);

      CREATE TABLE balance_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ${ACCOUNT_SCOPE_COLUMNS},
        cash_krw INTEGER NOT NULL,
        available_cash_krw INTEGER NOT NULL,
        total_evaluation_krw INTEGER NOT NULL,
        realized_pnl_today_krw INTEGER NOT NULL,
        unrealized_pnl_krw INTEGER NOT NULL,
        fetched_at TEXT NOT NULL,
        raw_json TEXT
      );
      CREATE INDEX idx_balance_snapshots_scope_fetched
        ON balance_snapshots (broker_id, environment, account_id, fetched_at DESC);

      CREATE TABLE pnl_daily (
        ${ACCOUNT_SCOPE_COLUMNS},
        trading_date TEXT NOT NULL,
        realized_pnl_krw INTEGER NOT NULL,
        unrealized_pnl_krw INTEGER NOT NULL,
        total_pnl_krw INTEGER NOT NULL,
        total_evaluation_krw INTEGER NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (broker_id, environment, account_id, trading_date)
      );
      CREATE INDEX idx_pnl_daily_scope_date
        ON pnl_daily (broker_id, environment, account_id, trading_date DESC);

      CREATE TABLE risk_reservations (
        intent_id TEXT PRIMARY KEY,
        ${ACCOUNT_SCOPE_COLUMNS},
        budget_key TEXT NOT NULL,
        amount_krw INTEGER NOT NULL CHECK (amount_krw >= 0),
        status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'CONSUMED', 'RELEASED')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (intent_id) REFERENCES order_intents(id) ON DELETE RESTRICT
      );
      CREATE INDEX idx_risk_reservations_active_budget
        ON risk_reservations (
          broker_id, environment, account_id, budget_key, status
        );

      CREATE TABLE runtime_state (
        scope_key TEXT NOT NULL,
        state_key TEXT NOT NULL,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (scope_key, state_key)
      );

      CREATE TABLE health_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ${ACCOUNT_SCOPE_COLUMNS},
        connection_state TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        occurred_at TEXT NOT NULL
      );
      CREATE INDEX idx_health_events_scope_occurred
        ON health_events (broker_id, environment, account_id, occurred_at DESC);

      CREATE TABLE error_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        broker_id TEXT CHECK (broker_id IS NULL OR broker_id IN ('kiwoom', 'koreainvestment')),
        environment TEXT CHECK (environment IS NULL OR environment IN ('live', 'paper')),
        account_id TEXT,
        severity TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'error', 'critical')),
        code TEXT,
        message TEXT NOT NULL,
        details_json TEXT,
        occurred_at TEXT NOT NULL,
        CHECK (
          (broker_id IS NULL AND environment IS NULL AND account_id IS NULL)
          OR (broker_id IS NOT NULL AND environment IS NOT NULL AND account_id IS NOT NULL)
        )
      );
      CREATE INDEX idx_error_logs_occurred ON error_logs (occurred_at DESC);
      CREATE INDEX idx_error_logs_scope_occurred
        ON error_logs (broker_id, environment, account_id, occurred_at DESC);

      CREATE TABLE audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        actor TEXT NOT NULL,
        action TEXT NOT NULL,
        broker_id TEXT CHECK (broker_id IS NULL OR broker_id IN ('kiwoom', 'koreainvestment')),
        environment TEXT CHECK (environment IS NULL OR environment IN ('live', 'paper')),
        account_id TEXT,
        entity_type TEXT,
        entity_id TEXT,
        payload_json TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        CHECK (
          (broker_id IS NULL AND environment IS NULL AND account_id IS NULL)
          OR (broker_id IS NOT NULL AND environment IS NOT NULL AND account_id IS NOT NULL)
        )
      );
      CREATE INDEX idx_audit_log_occurred ON audit_log (occurred_at DESC);
      CREATE INDEX idx_audit_log_entity ON audit_log (entity_type, entity_id, occurred_at DESC);

      CREATE TABLE outbox (
        id TEXT PRIMARY KEY,
        ${ACCOUNT_SCOPE_COLUMNS},
        aggregate_type TEXT NOT NULL,
        aggregate_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        dedupe_key TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('PENDING', 'PROCESSING', 'DONE', 'BLOCKED', 'FAILED')),
        attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        available_at TEXT NOT NULL,
        leased_until TEXT,
        lease_owner TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (broker_id, environment, account_id, dedupe_key)
      );
      CREATE INDEX idx_outbox_dispatch
        ON outbox (status, available_at, leased_until, created_at);
      CREATE INDEX idx_outbox_aggregate
        ON outbox (aggregate_type, aggregate_id);

      CREATE TABLE engine_lease (
        name TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        acquired_at TEXT NOT NULL,
        heartbeat_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );
    `,
  },
  {
    version: 2,
    name: "broker_order_ids_are_unique_per_trading_day",
    sql: `
      DROP INDEX ux_orders_broker_order_id;
      CREATE UNIQUE INDEX ux_orders_broker_order_day
        ON orders (
          broker_id, environment, account_id, broker_order_id,
          substr(ordered_at, 1, 10)
        )
        WHERE broker_order_id IS NOT NULL;
    `,
  },
  {
    version: 3,
    name: "persist_quote_and_order_exchange_routes",
    sql: `
      ALTER TABLE latest_quotes
        ADD COLUMN exchange TEXT NOT NULL DEFAULT 'KRX'
        CHECK (exchange IN ('KRX', 'NXT', 'SOR'));

      ALTER TABLE orders
        ADD COLUMN exchange TEXT NOT NULL DEFAULT 'KRX'
        CHECK (exchange IN ('KRX', 'NXT', 'SOR'));

      UPDATE orders
      SET exchange = COALESCE(
        (SELECT order_intents.exchange
         FROM order_intents
         WHERE order_intents.id = orders.intent_id),
        'KRX'
      );
    `,
  },
  {
    version: 4,
    name: "separate_derivatives_account_and_position_ledgers",
    sql: `
      CREATE TABLE derivatives_accounts (
        account_key TEXT PRIMARY KEY,
        provider_id TEXT NOT NULL CHECK (provider_id IN ('kiwoom', 'koreainvestment')),
        product TEXT NOT NULL DEFAULT 'derivatives' CHECK (product = 'derivatives'),
        environment TEXT NOT NULL CHECK (environment IN ('live', 'paper')),
        account_id TEXT NOT NULL,
        account_product_code TEXT NOT NULL,
        enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (provider_id, product, environment, account_id, account_product_code)
      );

      CREATE TABLE derivatives_contracts (
        id TEXT PRIMARY KEY,
        provider_id TEXT NOT NULL CHECK (provider_id IN ('kiwoom', 'koreainvestment')),
        contract_code TEXT NOT NULL,
        name TEXT NOT NULL,
        contract_type TEXT NOT NULL CHECK (contract_type IN ('FUTURE', 'CALL_OPTION', 'PUT_OPTION')),
        underlying_code TEXT NOT NULL,
        multiplier_krw INTEGER NOT NULL CHECK (typeof(multiplier_krw) = 'integer' AND multiplier_krw > 0),
        price_scale INTEGER NOT NULL CHECK (typeof(price_scale) = 'integer' AND price_scale > 0),
        expiry_date TEXT NOT NULL,
        active INTEGER NOT NULL CHECK (active IN (0, 1)),
        raw_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (provider_id, contract_code)
      );
      CREATE INDEX idx_derivatives_contracts_active_expiry
        ON derivatives_contracts (provider_id, active, expiry_date, contract_code);

      CREATE TABLE derivatives_order_intents (
        id TEXT PRIMARY KEY,
        account_key TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        client_order_id TEXT NOT NULL,
        contract_id TEXT NOT NULL,
        action TEXT NOT NULL CHECK (action IN ('OPEN', 'CLOSE')),
        direction TEXT NOT NULL CHECK (direction IN ('LONG', 'SHORT')),
        purpose TEXT NOT NULL CHECK (purpose IN ('HEDGE', 'DIRECTIONAL')),
        quantity INTEGER NOT NULL CHECK (typeof(quantity) = 'integer' AND quantity > 0),
        limit_price_ticks INTEGER CHECK (limit_price_ticks IS NULL OR (typeof(limit_price_ticks) = 'integer' AND limit_price_ticks > 0)),
        status TEXT NOT NULL CHECK (status IN (
          'QUEUED', 'SENDING', 'ACKED', 'PARTIALLY_FILLED', 'FILLED',
          'CANCEL_REQUESTED', 'CANCELED', 'AMEND_REQUESTED', 'AMENDED',
          'REJECTED', 'UNKNOWN'
        )),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (account_key, idempotency_key),
        UNIQUE (account_key, client_order_id),
        FOREIGN KEY (account_key) REFERENCES derivatives_accounts(account_key) ON DELETE RESTRICT,
        FOREIGN KEY (contract_id) REFERENCES derivatives_contracts(id) ON DELETE RESTRICT
      );
      CREATE UNIQUE INDEX ux_derivatives_intents_active_guard
        ON derivatives_order_intents (account_key, contract_id, purpose, action, direction)
        WHERE status IN (
          'QUEUED', 'SENDING', 'ACKED', 'PARTIALLY_FILLED',
          'CANCEL_REQUESTED', 'AMEND_REQUESTED', 'AMENDED', 'UNKNOWN'
        );
      CREATE INDEX idx_derivatives_intents_account_status
        ON derivatives_order_intents (account_key, status, updated_at DESC);

      CREATE TABLE derivatives_orders (
        id TEXT PRIMARY KEY,
        intent_id TEXT NOT NULL UNIQUE,
        account_key TEXT NOT NULL,
        broker_order_id TEXT,
        original_broker_order_id TEXT,
        contract_id TEXT NOT NULL,
        action TEXT NOT NULL CHECK (action IN ('OPEN', 'CLOSE')),
        direction TEXT NOT NULL CHECK (direction IN ('LONG', 'SHORT')),
        purpose TEXT NOT NULL CHECK (purpose IN ('HEDGE', 'DIRECTIONAL')),
        ordered_quantity INTEGER NOT NULL CHECK (typeof(ordered_quantity) = 'integer' AND ordered_quantity > 0),
        filled_quantity INTEGER NOT NULL DEFAULT 0 CHECK (typeof(filled_quantity) = 'integer' AND filled_quantity >= 0),
        remaining_quantity INTEGER NOT NULL CHECK (typeof(remaining_quantity) = 'integer' AND remaining_quantity >= 0),
        limit_price_ticks INTEGER CHECK (limit_price_ticks IS NULL OR (typeof(limit_price_ticks) = 'integer' AND limit_price_ticks > 0)),
        average_fill_price_ticks INTEGER CHECK (average_fill_price_ticks IS NULL OR (typeof(average_fill_price_ticks) = 'integer' AND average_fill_price_ticks >= 0)),
        status TEXT NOT NULL CHECK (status IN (
          'QUEUED', 'SENDING', 'ACKED', 'PARTIALLY_FILLED', 'FILLED',
          'CANCEL_REQUESTED', 'CANCELED', 'AMEND_REQUESTED', 'AMENDED',
          'REJECTED', 'UNKNOWN'
        )),
        ordered_at TEXT NOT NULL,
        broker_updated_at TEXT,
        raw_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK (filled_quantity <= ordered_quantity),
        CHECK (remaining_quantity <= ordered_quantity),
        FOREIGN KEY (intent_id) REFERENCES derivatives_order_intents(id) ON DELETE RESTRICT,
        FOREIGN KEY (account_key) REFERENCES derivatives_accounts(account_key) ON DELETE RESTRICT,
        FOREIGN KEY (contract_id) REFERENCES derivatives_contracts(id) ON DELETE RESTRICT
      );
      CREATE UNIQUE INDEX ux_derivatives_orders_broker_day
        ON derivatives_orders (account_key, broker_order_id, substr(ordered_at, 1, 10))
        WHERE broker_order_id IS NOT NULL;
      CREATE INDEX idx_derivatives_orders_recovery
        ON derivatives_orders (account_key, status, updated_at DESC);

      CREATE TABLE derivatives_fills (
        id TEXT PRIMARY KEY,
        account_key TEXT NOT NULL,
        order_id TEXT NOT NULL,
        broker_execution_id TEXT NOT NULL,
        broker_order_id TEXT NOT NULL,
        quantity INTEGER NOT NULL CHECK (typeof(quantity) = 'integer' AND quantity > 0),
        price_ticks INTEGER NOT NULL CHECK (typeof(price_ticks) = 'integer' AND price_ticks >= 0),
        fee_krw INTEGER NOT NULL DEFAULT 0 CHECK (typeof(fee_krw) = 'integer' AND fee_krw >= 0),
        executed_at TEXT NOT NULL,
        received_at TEXT NOT NULL,
        raw_json TEXT,
        UNIQUE (account_key, broker_execution_id),
        FOREIGN KEY (account_key) REFERENCES derivatives_accounts(account_key) ON DELETE RESTRICT,
        FOREIGN KEY (order_id) REFERENCES derivatives_orders(id) ON DELETE RESTRICT
      );
      CREATE INDEX idx_derivatives_fills_recovery
        ON derivatives_fills (account_key, executed_at DESC);

      CREATE TABLE derivatives_positions (
        account_key TEXT NOT NULL,
        contract_id TEXT NOT NULL,
        net_quantity INTEGER NOT NULL CHECK (typeof(net_quantity) = 'integer'),
        average_price_ticks INTEGER NOT NULL CHECK (typeof(average_price_ticks) = 'integer' AND average_price_ticks >= 0),
        current_price_ticks INTEGER NOT NULL CHECK (typeof(current_price_ticks) = 'integer' AND current_price_ticks >= 0),
        margin_required_krw INTEGER NOT NULL CHECK (typeof(margin_required_krw) = 'integer' AND margin_required_krw >= 0),
        unrealized_pnl_krw INTEGER NOT NULL CHECK (typeof(unrealized_pnl_krw) = 'integer'),
        broker_updated_at TEXT NOT NULL,
        raw_json TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (account_key, contract_id),
        FOREIGN KEY (account_key) REFERENCES derivatives_accounts(account_key) ON DELETE RESTRICT,
        FOREIGN KEY (contract_id) REFERENCES derivatives_contracts(id) ON DELETE RESTRICT
      );

      CREATE TABLE derivatives_purpose_ledger (
        account_key TEXT NOT NULL,
        contract_id TEXT NOT NULL,
        purpose TEXT NOT NULL CHECK (purpose IN ('HEDGE', 'DIRECTIONAL')),
        signed_quantity INTEGER NOT NULL CHECK (typeof(signed_quantity) = 'integer'),
        average_price_ticks INTEGER NOT NULL CHECK (typeof(average_price_ticks) = 'integer' AND average_price_ticks >= 0),
        realized_pnl_krw INTEGER NOT NULL CHECK (typeof(realized_pnl_krw) = 'integer'),
        updated_at TEXT NOT NULL,
        PRIMARY KEY (account_key, contract_id, purpose),
        FOREIGN KEY (account_key) REFERENCES derivatives_accounts(account_key) ON DELETE RESTRICT,
        FOREIGN KEY (contract_id) REFERENCES derivatives_contracts(id) ON DELETE RESTRICT
      );

      CREATE TABLE derivatives_hedge_targets (
        account_key TEXT NOT NULL,
        contract_id TEXT NOT NULL,
        source_equity_exposure_krw INTEGER NOT NULL CHECK (typeof(source_equity_exposure_krw) = 'integer' AND source_equity_exposure_krw >= 0),
        hedge_ratio_bps INTEGER NOT NULL CHECK (typeof(hedge_ratio_bps) = 'integer' AND hedge_ratio_bps >= 0),
        target_signed_quantity INTEGER NOT NULL CHECK (typeof(target_signed_quantity) = 'integer'),
        actual_hedge_signed_quantity INTEGER NOT NULL CHECK (typeof(actual_hedge_signed_quantity) = 'integer'),
        input_hash TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('DISABLED', 'READY', 'REBALANCING', 'BLOCKED')),
        updated_at TEXT NOT NULL,
        PRIMARY KEY (account_key, contract_id),
        FOREIGN KEY (account_key) REFERENCES derivatives_accounts(account_key) ON DELETE RESTRICT,
        FOREIGN KEY (contract_id) REFERENCES derivatives_contracts(id) ON DELETE RESTRICT
      );
    `,
  },
  {
    version: 5,
    name: "zero_remainder_unknown_orders_are_historical",
    sql: `
      DROP INDEX IF EXISTS ux_orders_active_guard;
      CREATE UNIQUE INDEX ux_orders_active_guard
        ON orders (broker_id, environment, account_id, symbol, side)
        WHERE remaining_quantity > 0
          AND status IN (
            'QUEUED', 'SENDING', 'ACKED', 'PARTIALLY_FILLED',
            'CANCEL_REQUESTED', 'AMEND_REQUESTED', 'AMENDED', 'UNKNOWN'
          );
    `,
  },
];

export function configureDatabase(
  database: BetterSqlite3.Database,
  busyTimeoutMs: number,
): void {
  database.pragma("journal_mode = WAL");
  database.pragma("foreign_keys = ON");
  database.pragma(`busy_timeout = ${Math.max(0, Math.trunc(busyTimeoutMs))}`);
  database.pragma("synchronous = FULL");
  database.pragma("trusted_schema = OFF");
}

export function quickCheck(database: BetterSqlite3.Database): void {
  const rows = database.pragma("quick_check") as Array<Record<string, unknown>>;
  const failures = rows
    .flatMap((row) => Object.values(row))
    .map(String)
    .filter((value) => value.toLowerCase() !== "ok");
  if (failures.length > 0) {
    throw new Error(`SQLite quick_check failed: ${failures.join("; ")}`);
  }
}

export function migrateDatabase(database: BetterSqlite3.Database): number {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )
  `);

  const appliedRows = database
    .prepare("SELECT version FROM schema_migrations ORDER BY version")
    .all() as Array<{ version: number }>;
  const applied = new Set(appliedRows.map((row) => row.version));

  for (const migration of migrations) {
    if (applied.has(migration.version)) continue;
    const apply = database.transaction(() => {
      database.exec(migration.sql);
      database
        .prepare(
          `INSERT INTO schema_migrations (version, name, applied_at)
           VALUES (?, ?, ?)`,
        )
        .run(migration.version, migration.name, new Date().toISOString());
    });
    apply.immediate();
  }

  const row = database
    .prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations")
    .get() as { version: number };
  if (row.version > LATEST_SCHEMA_VERSION) {
    throw new Error(
      `Database schema ${row.version} is newer than supported version ${LATEST_SCHEMA_VERSION}`,
    );
  }
  return row.version;
}
