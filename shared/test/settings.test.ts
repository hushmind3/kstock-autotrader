import { describe, expect, it } from "vitest";
import { AppSettingsSchema, createDefaultSettings } from "../src/settings.js";

describe("settings compatibility", () => {
  it("adds automation options without enabling new exits or altering saved account limits", () => {
    const legacy = createDefaultSettings();
    legacy.globalAutoTradingEnabled = true;
    const broker = legacy.brokers.kiwoom;
    broker.autoTradingEnabled = true;
    broker.orderPolicy.perTradeBudget = 5_000_000;
    const policy = broker.orderPolicy as unknown as Record<string, unknown>;
    for (const key of ["stopLossEnabled", "stopLossBps", "trailingProfitEnabled", "trailingActivationBps",
      "trailingDrawdownBps", "stagnationExitEnabled", "stagnationTradingDays", "stagnationMaxReturnBps", "reentryCooldownMinutes"]) {
      delete policy[key];
    }
    const parsed = AppSettingsSchema.parse(legacy);
    expect(parsed.globalAutoTradingEnabled).toBe(true);
    expect(parsed.brokers.kiwoom.autoTradingEnabled).toBe(true);
    expect(parsed.brokers.kiwoom.orderPolicy).toMatchObject({
      perTradeBudget: 5_000_000, stopLossEnabled: false, stopLossBps: 300,
      trailingProfitEnabled: false, trailingActivationBps: 300, trailingDrawdownBps: 150,
      stagnationExitEnabled: false, stagnationTradingDays: 5, stagnationMaxReturnBps: 100,
      reentryCooldownMinutes: 30,
    });
  });

  it("loads legacy settings with take-profit safely disabled", () => {
    const legacy = createDefaultSettings() as Record<string, unknown>;
    const brokers = legacy.brokers as Record<string, { orderPolicy: Record<string, unknown> }>;
    delete brokers.kiwoom.orderPolicy.takeProfitEnabled;
    delete brokers.kiwoom.orderPolicy.takeProfitBps;
    delete legacy.marketRegime;
    const parsed = AppSettingsSchema.parse(legacy);
    expect(parsed.brokers.kiwoom.orderPolicy.takeProfitEnabled).toBe(false);
    expect(parsed.brokers.kiwoom.orderPolicy.takeProfitBps).toBe(500);
    expect(parsed.marketRegime).toMatchObject({
      enabled: true,
      longPeriod: 60,
      minimumAboveLongMaBps: 3_500,
      minimumIntradayAdvancingBps: 3_000,
      minimumSampleSize: 100,
    });
  });

  it("accepts a strategy-specific primitive configuration object", () => {
    const settings = createDefaultSettings();
    settings.brokers.kiwoom.strategyId = "breakout-volume";
    settings.brokers.kiwoom.strategyConfig = {
      breakoutLookbackDays: 20,
      breakoutBufferBps: 10,
    };
    expect(AppSettingsSchema.parse(settings).brokers.kiwoom.strategyConfig).toEqual(settings.brokers.kiwoom.strategyConfig);
  });
});
