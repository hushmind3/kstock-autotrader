import { z } from "zod";
import { BROKER_IDS } from "./domain.js";

export const OrderPolicySchema = z.object({
  orderType: z.enum(["market", "limit"]).default("market"),
  limitOffsetBps: z.number().int().min(-1000).max(1000).default(0),
  takeProfitEnabled: z.boolean().default(false),
  takeProfitBps: z.number().int().min(1).max(10_000).default(500),
  perTradeBudget: z.number().int().positive().default(500_000),
  perSymbolLimit: z.number().int().positive().default(1_000_000),
  accountInvestmentLimit: z.number().int().positive().default(5_000_000),
  dailyInvestmentLimit: z.number().int().positive().default(2_000_000),
  dailyMaxLoss: z.number().int().positive().default(200_000),
  maxPositions: z.number().int().min(1).max(100).default(5),
  unfilledTimeoutSeconds: z.number().int().min(10).max(86_400).default(120),
  cancelRemainderOnTimeout: z.boolean().default(true),
});

export const MovingAverageSettingsSchema = z
  .object({
    shortPeriod: z.number().int().min(2).max(120).default(21),
    longPeriod: z.number().int().min(3).max(250).default(60),
    slopeLookbackDays: z.number().int().min(1).max(20).default(3),
    minShortSlopeBps: z.number().int().min(-5000).max(5000).default(1),
    minLongSlopeBps: z.number().int().min(-5000).max(5000).default(-100),
    volumeLookbackDays: z.number().int().min(1).max(120).default(20),
    minAverageVolume: z.number().int().min(0).default(100_000),
    minCurrentVolume: z.number().int().min(0).default(0),
    sellOnShortSlopeBps: z.number().int().min(-5000).max(5000).default(-1),
    sellBelowMaBufferBps: z.number().int().min(-1000).max(1000).default(0),
  })
  .refine((value) => value.longPeriod > value.shortPeriod, {
    message: "장기 이동평균 기간은 단기 이동평균 기간보다 길어야 합니다.",
    path: ["longPeriod"],
  });

export type MovingAverageSettings = z.infer<typeof MovingAverageSettingsSchema>;

export const StrategyConfigValueSchema = z.union([
  z.number(),
  z.string(),
  z.boolean(),
  z.null(),
]);

export const StrategyConfigSchema = z.record(
  z.string(),
  StrategyConfigValueSchema,
);

export type StrategyConfigValue = z.infer<typeof StrategyConfigValueSchema>;
export type StrategyConfig = z.infer<typeof StrategyConfigSchema>;

export const BrokerRuntimeSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  autoTradingEnabled: z.boolean().default(false),
  newBuysPaused: z.boolean().default(true),
  /**
   * KRX sends only to the Korea Exchange, NXT sends only to Nextrade and SOR
   * lets the broker choose the executable/best venue. Existing accounts stay
   * on KRX until the operator explicitly changes this setting.
   */
  orderRoute: z.enum(["KRX", "NXT", "SOR"]).default("KRX"),
  /** Resume the persisted armed state after a clean process/server restart. */
  resumeAfterRestart: z.boolean().default(true),
  environment: z.enum(["live", "paper"]).default("paper"),
  strategyId: z.string().min(1).default("moving-average"),
  strategyConfig: StrategyConfigSchema.default(() => MovingAverageSettingsSchema.parse({})),
  orderPolicy: OrderPolicySchema.default(() => OrderPolicySchema.parse({})),
});

export const AppSettingsSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  globalAutoTradingEnabled: z.boolean().default(false),
  emergencyHalt: z.boolean().default(true),
  newBuysPaused: z.boolean().default(true),
  staleQuoteMs: z.number().int().min(1_000).max(600_000).default(30_000),
  scanIntervalMs: z.number().int().min(1_000).max(300_000).default(5_000),
  quoteSweepIntervalMs: z.number().int().min(10_000).max(3_600_000).default(120_000),
  brokers: z.record(z.enum(BROKER_IDS), BrokerRuntimeSettingsSchema).default(() => ({
    kiwoom: BrokerRuntimeSettingsSchema.parse({}),
    koreainvestment: BrokerRuntimeSettingsSchema.parse({}),
  })),
});

export type OrderPolicy = z.infer<typeof OrderPolicySchema>;
export type BrokerRuntimeSettings = z.infer<typeof BrokerRuntimeSettingsSchema>;
export type AppSettings = z.infer<typeof AppSettingsSchema>;

export const AppSettingsPatchSchema = AppSettingsSchema.partial().extend({
  brokers: z.record(z.enum(BROKER_IDS), BrokerRuntimeSettingsSchema.partial()).optional(),
});

export function createDefaultSettings(): AppSettings {
  return AppSettingsSchema.parse({});
}
