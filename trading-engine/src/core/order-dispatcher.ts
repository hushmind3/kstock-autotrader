import { randomUUID } from "node:crypto";
import {
  BrokerRejectedError,
  koreanTradingDate,
  stableHash,
  toIsoDateTime,
  type AppSettings,
  type BrokerAdapter,
  type BrokerHealth,
  type BrokerRuntimeSettings,
  type Quote,
} from "@kstock/shared";
import { TradingRepository, type SignalRecord } from "@kstock/database";
import { RiskManager, type RiskCheckInput } from "./risk-manager.js";

export interface DispatchSignalInput {
  adapter: BrokerAdapter;
  appSettings: AppSettings;
  brokerSettings: BrokerRuntimeSettings;
  signal: SignalRecord;
  quote: Quote;
  health?: BrokerHealth;
  riskContext: Omit<
    RiskCheckInput,
    "appSettings" | "brokerSettings" | "health" | "side" | "symbol" | "quote"
  >;
}

export interface DispatchSignalResult {
  submitted: boolean;
  orderId?: string;
  reasonCodes: string[];
  outcome?: "ACCEPTED" | "REJECTED" | "INDETERMINATE";
}

export class OrderDispatcher {
  readonly #riskManager = new RiskManager();

  constructor(private readonly repository: TradingRepository) {}

  async dispatch(input: DispatchSignalInput): Promise<DispatchSignalResult> {
    if (input.signal.action !== "BUY" && input.signal.action !== "SELL") {
      return { submitted: false, reasonCodes: ["SIGNAL_NOT_ACTIONABLE"] };
    }
    const side = input.signal.action === "BUY" ? "buy" : "sell";
    const risk = this.#riskManager.check({
      ...input.riskContext,
      appSettings: input.appSettings,
      brokerSettings: input.brokerSettings,
      health: input.health ?? input.adapter.getHealth(),
      side,
      symbol: input.signal.symbol,
      quote: input.quote,
    });
    if (!risk.allowed) return { submitted: false, reasonCodes: risk.reasonCodes };

    const tradingDate = koreanTradingDate();
    const idempotencyKey = stableHash({
      scope: input.adapter.scope,
      tradingDate,
      strategyConfigId: input.signal.strategyConfigId,
      symbol: input.signal.symbol,
      side,
      automated: true,
      // One signal is one logical order. A daily key would wrongly suppress
      // later entries and confirmed-cancellation retries in the same session.
      signalId: input.signal.id,
    });
    const intentId = randomUUID();
    const orderId = randomUUID();
    const outboxId = randomUUID();
    const clientOrderId = randomUUID();
    let created;
    try {
      created = this.repository.createOrderIntent({
        id: intentId,
        orderId,
        outboxId,
        scope: input.adapter.scope,
        signalId: input.signal.id,
        idempotencyKey,
        request: { clientOrderId, ...risk.request },
        ...(risk.reservationAmount > 0
          ? {
              reservation: {
                budgetKey: `daily:${tradingDate}`,
                amount: risk.reservationAmount,
                maximumActiveAmount: Math.max(
                  0,
                  input.brokerSettings.orderPolicy.dailyInvestmentLimit -
                    input.riskContext.dailyInvestedAmount,
                ),
              },
            }
          : {}),
        outboxPayload: { request: { clientOrderId, ...risk.request }, signalId: input.signal.id },
      });
    } catch (error) {
      return {
        submitted: false,
        reasonCodes: [
          error instanceof Error && error.name === "ActiveOrderConflictError"
            ? "ACTIVE_ORDER_EXISTS"
            : error instanceof Error && error.name === "RiskBudgetExceededError"
              ? "ATOMIC_RISK_BUDGET_EXCEEDED"
              : "ORDER_INTENT_PERSIST_FAILED",
        ],
      };
    }
    if (!created.created) {
      return { submitted: false, orderId: created.order.id, reasonCodes: ["DUPLICATE_ORDER_BLOCKED"] };
    }

    const now = toIsoDateTime();
    this.repository.applyOrderEvent({
      scope: input.adapter.scope,
      orderId,
      dedupeKey: `local:sending:${intentId}`,
      eventType: "SEND_STARTED",
      toStatus: "SENDING",
      eventAt: now,
    });

    try {
      const result = await input.adapter.placeOrder({ clientOrderId, ...risk.request });
      const eventAt = toIsoDateTime();
      if (result.outcome === "ACCEPTED") {
        this.repository.applyOrderEvent({
          scope: input.adapter.scope,
          orderId,
          dedupeKey: `local:accepted:${intentId}`,
          eventType: "BROKER_ACCEPTED",
          toStatus: "ACKED",
          eventAt,
          ...(result.brokerOrderId ? { brokerOrderId: result.brokerOrderId } : {}),
          ...(result.originalBrokerOrderId
            ? { originalBrokerOrderId: result.originalBrokerOrderId }
            : {}),
          raw: result.raw,
        });
        this.repository.markOutboxDone(outboxId);
      } else if (result.outcome === "REJECTED") {
        this.repository.applyOrderEvent({
          scope: input.adapter.scope,
          orderId,
          dedupeKey: `local:rejected:${intentId}`,
          eventType: "BROKER_REJECTED",
          toStatus: "REJECTED",
          eventAt,
          raw: result.raw,
        });
        this.repository.setRiskReservationStatus(intentId, "RELEASED");
        this.repository.markOutboxDone(outboxId);
      } else {
        this.markIndeterminate(input, orderId, outboxId, intentId, result.message ?? "Order acknowledgement was indeterminate", result.raw);
      }
      this.repository.appendAudit({
        actor: "trading-engine",
        action: `ORDER_${result.outcome}`,
        scope: input.adapter.scope,
        entityType: "order",
        entityId: orderId,
        payload: { code: result.code, message: result.message },
      });
      return {
        submitted: result.outcome === "ACCEPTED",
        orderId,
        reasonCodes: [result.outcome],
        outcome: result.outcome,
      };
    } catch (error) {
      if (error instanceof BrokerRejectedError) {
        this.repository.applyOrderEvent({
          scope: input.adapter.scope,
          orderId,
          dedupeKey: `local:rejected:${intentId}`,
          eventType: "BROKER_REJECTED",
          toStatus: "REJECTED",
          eventAt: toIsoDateTime(),
        });
        this.repository.setRiskReservationStatus(intentId, "RELEASED");
        this.repository.markOutboxDone(outboxId);
        return { submitted: false, orderId, reasonCodes: ["BROKER_REJECTED"], outcome: "REJECTED" };
      }
      const message = error instanceof Error ? error.message : String(error);
      this.markIndeterminate(input, orderId, outboxId, intentId, message);
      return { submitted: false, orderId, reasonCodes: ["ORDER_STATUS_INDETERMINATE"], outcome: "INDETERMINATE" };
    }
  }

  private markIndeterminate(
    input: DispatchSignalInput,
    orderId: string,
    outboxId: string,
    intentId: string,
    message: string,
    raw?: unknown,
  ): void {
    this.repository.applyOrderEvent({
      scope: input.adapter.scope,
      orderId,
      dedupeKey: `local:unknown:${intentId}`,
      eventType: "BROKER_ACK_UNKNOWN",
      toStatus: "UNKNOWN",
      eventAt: toIsoDateTime(),
      raw,
    });
    this.repository.blockOutbox(outboxId, message);
    this.repository.appendError({
      scope: input.adapter.scope,
      severity: "critical",
      code: "ORDER_INDETERMINATE",
      message: "주문 접수 여부를 확인할 수 없어 해당 계좌의 신규 주문을 차단해야 합니다.",
      details: { orderId, message },
    });
  }
}
