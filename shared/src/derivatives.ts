import type { BrokerId, OrderStatus, TradingEnvironment } from "./domain.js";
import { z } from "zod";

/**
 * Derivatives are deliberately scoped separately from cash equities.  A broker
 * account number may be identical, but its product code and ledger must not be.
 */
export const DERIVATIVES_PRODUCT = "derivatives" as const;
export type DerivativesProduct = typeof DERIVATIVES_PRODUCT;
export type DerivativesProviderId = BrokerId;
export type DerivativesContractType = "FUTURE" | "CALL_OPTION" | "PUT_OPTION";
export type DerivativesOrderAction = "OPEN" | "CLOSE";
export type DerivativesDirection = "LONG" | "SHORT";
export type DerivativesPositionPurpose = "HEDGE" | "DIRECTIONAL";
export type DerivativesHedgeStatus = "DISABLED" | "READY" | "REBALANCING" | "BLOCKED";

export const DerivativesAutomationSettingsSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  /** Read-only account/quote synchronization can stay on while orders are off. */
  connectionEnabled: z.boolean().default(true),
  environment: z.enum(["live", "paper"]).default("live"),
  autoTradingEnabled: z.boolean().default(false),
  resumeAfterRestart: z.boolean().default(true),
  emergencyHalt: z.boolean().default(false),
  newPositionsPaused: z.boolean().default(true),
  mode: z.enum(["HEDGE", "DIRECTIONAL", "HEDGE_AND_DIRECTIONAL"]).default("HEDGE"),
  contractSelection: z.enum(["AUTO_MINI_KOSPI200", "MANUAL"]).default("AUTO_MINI_KOSPI200"),
  manualContractCode: z.string().trim().max(16).default(""),
  allowNightSession: z.boolean().default(true),
  orderType: z.enum(["MARKET", "LIMIT"]).default("MARKET"),
  limitOffsetTicks: z.number().int().min(-20).max(20).default(0),
  unfilledTimeoutSeconds: z.number().int().min(10).max(3_600).default(60),
  maxContracts: z.number().int().min(1).max(100).default(2),
  maxDailyLossKrw: z.number().int().min(10_000).max(1_000_000_000).default(100_000),
  maxMarginUsageBps: z.number().int().min(100).max(10_000).default(5_000),
  hedge: z.object({
    enabled: z.boolean().default(false),
    hedgeRatioBps: z.number().int().min(1).max(10_000).default(10_000),
    minRebalanceContracts: z.number().int().min(1).max(20).default(1),
  }).default(() => ({ enabled: false, hedgeRatioBps: 10_000, minRebalanceContracts: 1 })),
  directional: z.object({
    enabled: z.boolean().default(false),
    sideMode: z.enum(["BOTH", "LONG_ONLY", "SHORT_ONLY"]).default("BOTH"),
    fastPeriod: z.number().int().min(2).max(60).default(5),
    slowPeriod: z.number().int().min(3).max(120).default(20),
    minimumGapBps: z.number().int().min(0).max(2_000).default(15),
    targetContracts: z.number().int().min(1).max(100).default(1),
  }).default(() => ({
    enabled: false,
    sideMode: "BOTH" as const,
    fastPeriod: 5,
    slowPeriod: 20,
    minimumGapBps: 15,
    targetContracts: 1,
  })),
}).superRefine((value, context) => {
  if (value.contractSelection === "MANUAL" && !/^[A-Za-z0-9]{6,16}$/.test(value.manualContractCode)) {
    context.addIssue({
      code: "custom",
      path: ["manualContractCode"],
      message: "직접 선택한 선물 종목코드를 확인해 주세요.",
    });
  }
  if (value.directional.slowPeriod <= value.directional.fastPeriod) {
    context.addIssue({
      code: "custom",
      path: ["directional", "slowPeriod"],
      message: "느린 평균 기간은 빠른 평균 기간보다 길어야 합니다.",
    });
  }
  if (
    value.autoTradingEnabled &&
    !value.hedge.enabled &&
    !value.directional.enabled
  ) {
    context.addIssue({
      code: "custom",
      path: ["autoTradingEnabled"],
      message: "현물 보호 또는 상승·하락 추세매매 중 하나를 먼저 켜 주세요.",
    });
  }
});

export type DerivativesAutomationSettings = z.infer<typeof DerivativesAutomationSettingsSchema>;

export function createDefaultDerivativesAutomationSettings(): DerivativesAutomationSettings {
  return DerivativesAutomationSettingsSchema.parse({});
}

/** Stable key used by the derivatives tables; never aliases an equity scope. */
export type DerivativesAccountKey = string & { readonly __derivativesAccountKey: unique symbol };

export interface DerivativesAccountScope {
  providerId: DerivativesProviderId;
  product: DerivativesProduct;
  environment: TradingEnvironment;
  accountId: string;
  accountProductCode: string;
}

export interface DerivativesContract {
  id: string;
  providerId: DerivativesProviderId;
  contractCode: string;
  name: string;
  contractType: DerivativesContractType;
  underlyingCode: string;
  /** Won per index point. Persisted as an integer to avoid money rounding. */
  multiplierKrw: number;
  /** API price = priceTicks / priceScale. */
  priceScale: number;
  expiryDate: string;
  active: boolean;
  raw?: unknown;
}

export interface DerivativesOrderIntent {
  id: string;
  accountKey: DerivativesAccountKey;
  idempotencyKey: string;
  clientOrderId: string;
  contractId: string;
  action: DerivativesOrderAction;
  direction: DerivativesDirection;
  purpose: DerivativesPositionPurpose;
  quantity: number;
  limitPriceTicks?: number;
  status: OrderStatus;
  createdAt: string;
  updatedAt: string;
}

/** Positive is long, negative is short, and zero is flat. */
export interface DerivativesNetPosition {
  accountKey: DerivativesAccountKey;
  contractId: string;
  netQuantity: number;
  averagePriceTicks: number;
  currentPriceTicks: number;
  marginRequiredKrw: number;
  unrealizedPnlKrw: number;
  brokerUpdatedAt: string;
  raw?: unknown;
}

/**
 * Virtual allocations explain why the broker's one net position exists. Their
 * signed quantities must add up exactly to DerivativesNetPosition.netQuantity.
 */
export interface DerivativesPurposeAllocation {
  accountKey: DerivativesAccountKey;
  contractId: string;
  purpose: DerivativesPositionPurpose;
  signedQuantity: number;
  averagePriceTicks: number;
  realizedPnlKrw: number;
  updatedAt: string;
}

export interface DerivativesHedgeTarget {
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

/** OPEN LONG/CLOSE SHORT buy; OPEN SHORT/CLOSE LONG sell. */
export function derivativesOrderSide(
  action: DerivativesOrderAction,
  direction: DerivativesDirection,
): "buy" | "sell" {
  return (action === "OPEN") === (direction === "LONG") ? "buy" : "sell";
}

export function createDerivativesAccountKey(
  scope: DerivativesAccountScope,
): DerivativesAccountKey {
  const fields = [
    scope.providerId,
    scope.product,
    scope.environment,
    scope.accountId,
    scope.accountProductCode,
  ];
  if (fields.some((field) => field.trim().length === 0)) {
    throw new TypeError("Derivatives account scope fields must not be empty");
  }
  return fields.map(encodeURIComponent).join(":") as DerivativesAccountKey;
}
