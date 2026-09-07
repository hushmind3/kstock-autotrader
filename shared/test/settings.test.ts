import { describe, expect, it } from "vitest";
import { AppSettingsSchema, createDefaultSettings } from "../src/settings.js";

describe("settings compatibility", () => {
  it("loads legacy settings with take-profit safely disabled", () => {
    const legacy = createDefaultSettings() as Record<string, unknown>;
    const brokers = legacy.brokers as Record<string, { orderPolicy: Record<string, unknown> }>;
    delete brokers.kiwoom.orderPolicy.takeProfitEnabled;
    delete brokers.kiwoom.orderPolicy.takeProfitBps;
    const parsed = AppSettingsSchema.parse(legacy);
    expect(parsed.brokers.kiwoom.orderPolicy.takeProfitEnabled).toBe(false);
    expect(parsed.brokers.kiwoom.orderPolicy.takeProfitBps).toBe(500);
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
