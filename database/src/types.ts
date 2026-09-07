import type {
  AccountScope,
  BrokerExecution,
  BrokerHealth,
  BrokerId,
  BrokerOrder,
  BrokerPosition,
  DerivativesAccountKey,
  DerivativesAccountScope,
  DerivativesContract,
  DerivativesDirection,
  DerivativesHedgeStatus,
  DerivativesOrderAction,
  DerivativesPositionPurpose,
  Exchange,
  OrderSide,
  OrderStatus,
  OrderType,
  PlaceOrderRequest,
  StrategyAction,
  TradingEnvironment,
} from "@kstock/shared";

export interface DerivativesAccountRecord {
  accountKey: DerivativesAccountKey;
  scope: DerivativesAccountScope;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface UpsertDerivativesAccountInput {
  scope: DerivativesAccountScope;
  enabled: boolean;
  updatedAt?: string;
}

export interface DerivativesContractRecord extends DerivativesContract {
  createdAt: string;
  updatedAt: string;
}

export interface UpsertDerivativesContractInput {
  contract: DerivativesContract;
  updatedAt?: string;
}

export interface DerivativesOrderIntentRecord {
  id: string;
  accountKey: DerivativesAccountKey;
  idempotencyKey: string;
  clientOrderId: string;
  contractId: string;
  action: DerivativesOrderAction;
  direction: DerivativesDirection;
  purpose: DerivativesPositionPurpose;
  quantity: number;
  limitPriceTicks: number | null;
  status: OrderStatus;
  createdAt: string;
  updatedAt: string;
}

export interface DerivativesOrderRecord {
  id: string;
  intentId: string;
  accountKey: DerivativesAccountKey;
  brokerOrderId: string | null;
  originalBrokerOrderId: string | null;
  contractId: string;
  action: DerivativesOrderAction;
  direction: DerivativesDirection;
  purpose: DerivativesPositionPurpose;
  orderedQuantity: number;
  filledQuantity: number;
  remainingQuantity: number;
  limitPriceTicks: number | null;
  averageFillPriceTicks: number | null;
  status: OrderStatus;
  orderedAt: string;
  brokerUpdatedAt: string | null;
  raw: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface CreateDerivativesOrderIntentInput {
  id: string;
  orderId?: string;
  accountKey: DerivativesAccountKey;
  idempotencyKey: string;
  clientOrderId: string;
  contractId: string;
  action: DerivativesOrderAction;
  direction: DerivativesDirection;
  purpose: DerivativesPositionPurpose;
  quantity: number;
  limitPriceTicks?: number;
  createdAt?: string;
}

export interface CreateDerivativesOrderIntentResult {
  created: boolean;
  intent: DerivativesOrderIntentRecord;
  order: DerivativesOrderRecord;
}

export interface ApplyDerivativesOrderUpdateInput {
  accountKey: DerivativesAccountKey;
  orderId: string;
  status: OrderStatus;
  brokerOrderId?: string;
  originalBrokerOrderId?: string;
  filledQuantity?: number;
  remainingQuantity?: number;
  averageFillPriceTicks?: number;
  brokerUpdatedAt?: string;
  raw?: unknown;
  updatedAt?: string;
}

export interface DerivativesFillRecord {
  id: string;
  accountKey: DerivativesAccountKey;
  orderId: string;
  brokerExecutionId: string;
  brokerOrderId: string;
  quantity: number;
  priceTicks: number;
  feeKrw: number;
  executedAt: string;
  receivedAt: string;
  raw: unknown;
}

export interface RecordDerivativesFillInput {
  id: string;
  accountKey: DerivativesAccountKey;
  orderId: string;
  brokerExecutionId: string;
  brokerOrderId: string;
  quantity: number;
  priceTicks: number;
  feeKrw?: number;
  executedAt: string;
  receivedAt?: string;
  raw?: unknown;
}

export interface DerivativesPositionRecord {
  accountKey: DerivativesAccountKey;
  contractId: string;
  netQuantity: number;
  averagePriceTicks: number;
  currentPriceTicks: number;
  marginRequiredKrw: number;
  unrealizedPnlKrw: number;
  brokerUpdatedAt: string;
  raw: unknown;
  updatedAt: string;
}

export interface UpsertDerivativesPositionInput
  extends Omit<DerivativesPositionRecord, "raw" | "updatedAt"> {
  raw?: unknown;
  updatedAt?: string;
}

export interface DerivativesPurposeLedgerRecord {
  accountKey: DerivativesAccountKey;
  contractId: string;
  purpose: DerivativesPositionPurpose;
  signedQuantity: number;
  averagePriceTicks: number;
  realizedPnlKrw: number;
  updatedAt: string;
}

export interface ReplaceDerivativesPurposeLedgerInput {
  accountKey: DerivativesAccountKey;
  contractId: string;
  allocations: Array<{
    purpose: DerivativesPositionPurpose;
    signedQuantity: number;
    averagePriceTicks: number;
    realizedPnlKrw: number;
  }>;
  updatedAt?: string;
}

export interface DerivativesPositionConsistency {
  accountKey: DerivativesAccountKey;
  contractId: string;
  brokerNetQuantity: number;
  allocatedQuantity: number;
  difference: number;
  consistent: boolean;
}

export interface DerivativesHedgeTargetRecord {
  accountKey: DerivativesAccountKey;
  contractId: string;
  sourceEquityExposureKrw: number;
  hedgeRatioBps: number;
  targetSignedQuantity: number;
  actualHedgeSignedQuantity: number;
  inputHash: string;
  status: DerivativesHedgeStatus;
  updatedAt: string;
}

export interface UpsertDerivativesHedgeTargetInput
  extends Omit<DerivativesHedgeTargetRecord, "updatedAt"> {
  updatedAt?: string;
}

export interface TradingRepositoryOptions {
  filename: string;
  readonly?: boolean;
  fileMustExist?: boolean;
  busyTimeoutMs?: number;
  ensureDirectory?: boolean;
}

export interface PersistedAccountScope {
  brokerId: BrokerId;
  environment: TradingEnvironment;
  accountId: string;
}

export interface StrategyConfigVersionRecord {
  id: string;
  strategyId: string;
  strategyVersion: string;
  configVersion: number;
  configHash: string;
  config: unknown;
  createdAt: string;
}

export interface CreateStrategyConfigVersionInput {
  id: string;
  strategyId: string;
  strategyVersion: string;
  config: unknown;
  configHash?: string;
  configVersion?: number;
  createdAt?: string;
}

export interface StrategyAssignmentRecord {
  scope: AccountScope;
  strategyConfigId: string;
  enabled: boolean;
  assignedAt: string;
  updatedAt: string;
}

export interface AssignStrategyInput {
  scope: AccountScope;
  strategyConfigId: string;
  enabled: boolean;
  assignedAt?: string;
}

export interface SignalRecord {
  id: string;
  scope: AccountScope;
  strategyConfigId: string;
  symbol: string;
  action: StrategyAction;
  reasonCodes: string[];
  metrics: Record<string, number | string | boolean | null>;
  inputHash: string;
  observedAt: string;
  createdAt: string;
}

export interface InsertSignalInput {
  id: string;
  scope: AccountScope;
  strategyConfigId: string;
  symbol: string;
  action: StrategyAction;
  reasonCodes: string[];
  metrics: Record<string, number | string | boolean | null>;
  inputHash: string;
  observedAt: string;
  createdAt?: string;
}

export interface OrderIntentRecord {
  id: string;
  scope: AccountScope;
  signalId: string | null;
  idempotencyKey: string;
  clientOrderId: string;
  symbol: string;
  side: OrderSide;
  orderType: OrderType;
  quantity: number;
  limitPrice: number | null;
  exchange: Exchange;
  status: OrderStatus;
  createdAt: string;
  updatedAt: string;
}

export interface OrderRecord {
  id: string;
  intentId: string | null;
  scope: AccountScope;
  brokerOrderId: string | null;
  originalBrokerOrderId: string | null;
  /** Durable original order route, used again for cancel/amend after restart. */
  exchange: Exchange;
  symbol: string;
  side: OrderSide;
  orderType: OrderType;
  orderedQuantity: number;
  filledQuantity: number;
  remainingQuantity: number;
  limitPrice: number | null;
  averageFillPrice: number | null;
  status: OrderStatus;
  orderedAt: string;
  brokerUpdatedAt: string | null;
  revision: number;
  raw: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface RiskReservationInput {
  budgetKey: string;
  amount: number;
  maximumActiveAmount?: number;
  committedAmount?: number;
}

export interface CreateOrderIntentInput {
  id: string;
  orderId?: string;
  outboxId: string;
  scope: AccountScope;
  signalId?: string;
  idempotencyKey: string;
  request: PlaceOrderRequest;
  reservation?: RiskReservationInput;
  outboxPayload?: unknown;
  createdAt?: string;
}

export interface CreateOrderIntentResult {
  created: boolean;
  intent: OrderIntentRecord;
  order: OrderRecord;
  outbox: OutboxRecord;
}

export interface OrderEventRecord {
  id: number;
  scope: AccountScope;
  orderId: string;
  dedupeKey: string;
  brokerEventId: string | null;
  eventType: string;
  fromStatus: OrderStatus | null;
  toStatus: OrderStatus;
  eventAt: string;
  receivedAt: string;
  payload: unknown;
}

export interface ApplyOrderEventInput {
  scope: AccountScope;
  orderId: string;
  dedupeKey: string;
  eventType: string;
  toStatus: OrderStatus;
  eventAt: string;
  receivedAt?: string;
  brokerEventId?: string;
  brokerOrderId?: string;
  originalBrokerOrderId?: string;
  /** Broker-reported route for external orders; local intents keep their requested route. */
  exchange?: Exchange;
  filledQuantity?: number;
  remainingQuantity?: number;
  averageFillPrice?: number;
  brokerUpdatedAt?: string;
  raw?: unknown;
  allowCorrection?: boolean;
}

export interface ApplyOrderEventResult {
  applied: boolean;
  order: OrderRecord;
  event: OrderEventRecord | null;
}

export interface OrderListFilter {
  statuses?: OrderStatus[];
  symbol?: string;
  updatedFrom?: string;
  limit?: number;
}

export interface ReconciledOrderInput {
  scope: AccountScope;
  brokerOrder: BrokerOrder;
  receivedAt?: string;
  allowCorrection?: boolean;
}

export interface FillRecord {
  id: string;
  scope: AccountScope;
  orderId: string;
  brokerExecutionId: string;
  brokerOrderId: string;
  symbol: string;
  side: OrderSide;
  quantity: number;
  price: number;
  fee: number;
  tax: number;
  executedAt: string;
  receivedAt: string;
  raw: unknown;
}

export interface RecordExecutionInput {
  scope: AccountScope;
  execution: BrokerExecution;
  fillId?: string;
  fee?: number;
  tax?: number;
  receivedAt?: string;
}

export interface RecordExecutionResult {
  inserted: boolean;
  fill: FillRecord | null;
  order: OrderRecord;
}

export interface BalanceSnapshotRecord {
  id: number;
  scope: AccountScope;
  cash: number;
  availableCash: number;
  totalEvaluation: number;
  realizedPnlToday: number;
  unrealizedPnl: number;
  fetchedAt: string;
  raw: unknown;
}

export interface SaveBalanceSnapshotInput {
  scope: AccountScope;
  cash: number;
  availableCash: number;
  totalEvaluation: number;
  realizedPnlToday: number;
  unrealizedPnl: number;
  fetchedAt: string;
  raw?: unknown;
}

export interface DailyPnlRecord {
  scope: AccountScope;
  tradingDate: string;
  realizedPnl: number;
  unrealizedPnl: number;
  totalPnl: number;
  totalEvaluation: number;
  updatedAt: string;
}

export interface UpsertDailyPnlInput {
  scope: AccountScope;
  tradingDate: string;
  realizedPnl: number;
  unrealizedPnl: number;
  totalPnl: number;
  totalEvaluation: number;
  updatedAt?: string;
}

export interface RiskReservationRecord {
  intentId: string;
  scope: AccountScope;
  budgetKey: string;
  amount: number;
  status: "ACTIVE" | "CONSUMED" | "RELEASED";
  createdAt: string;
  updatedAt: string;
}

export type RuntimeScope = AccountScope | null;

export interface HealthEventRecord {
  id: number;
  scope: AccountScope;
  health: BrokerHealth;
  occurredAt: string;
}

export type ErrorSeverity = "info" | "warning" | "error" | "critical";

export interface AppendErrorInput {
  scope?: AccountScope;
  severity: ErrorSeverity;
  code?: string;
  message: string;
  details?: unknown;
  occurredAt?: string;
}

export interface ErrorLogRecord {
  id: number;
  scope: AccountScope | null;
  severity: ErrorSeverity;
  code: string | null;
  message: string;
  details: unknown;
  occurredAt: string;
}

export interface AppendAuditInput {
  actor: string;
  action: string;
  scope?: AccountScope;
  entityType?: string;
  entityId?: string;
  payload?: unknown;
  occurredAt?: string;
}

export interface AuditLogRecord {
  id: number;
  actor: string;
  action: string;
  scope: AccountScope | null;
  entityType: string | null;
  entityId: string | null;
  payload: unknown;
  occurredAt: string;
}

export type OutboxStatus = "PENDING" | "PROCESSING" | "DONE" | "BLOCKED" | "FAILED";

export interface OutboxRecord {
  id: string;
  scope: AccountScope;
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  dedupeKey: string;
  payload: unknown;
  status: OutboxStatus;
  attempts: number;
  availableAt: string;
  leasedUntil: string | null;
  leaseOwner: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ClaimOutboxOptions {
  ownerId: string;
  now?: string;
  leaseMs?: number;
  limit?: number;
}

export interface EngineLeaseRecord {
  name: string;
  ownerId: string;
  acquiredAt: string;
  heartbeatAt: string;
  expiresAt: string;
}

export interface AcquireEngineLeaseInput {
  name: string;
  ownerId: string;
  now?: string;
  ttlMs?: number;
}

export interface PositionReplacementInput {
  scope: AccountScope;
  positions: BrokerPosition[];
  fetchedAt: string;
}

export class ActiveOrderConflictError extends Error {
  constructor(
    readonly scope: AccountScope,
    readonly symbol: string,
    readonly side: OrderSide,
  ) {
    super(
      `An active ${side} order already exists for ${scope.brokerId}/${scope.environment}/${scope.accountId}/${symbol}`,
    );
    this.name = "ActiveOrderConflictError";
  }
}

export class RiskBudgetExceededError extends Error {
  constructor(
    readonly scope: AccountScope,
    readonly budgetKey: string,
    readonly attemptedAmount: number,
    readonly maximumAmount: number,
  ) {
    super(
      `Risk budget ${budgetKey} exceeded: ${attemptedAmount} > ${maximumAmount}`,
    );
    this.name = "RiskBudgetExceededError";
  }
}

export class InvalidOrderTransitionError extends Error {
  constructor(
    readonly fromStatus: OrderStatus,
    readonly toStatus: OrderStatus,
  ) {
    super(`Invalid order transition: ${fromStatus} -> ${toStatus}`);
    this.name = "InvalidOrderTransitionError";
  }
}

export class RecordNotFoundError extends Error {
  constructor(entity: string, id: string) {
    super(`${entity} not found: ${id}`);
    this.name = "RecordNotFoundError";
  }
}
