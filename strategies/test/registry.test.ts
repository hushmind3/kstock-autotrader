import { describe, expect, it } from "vitest";
import { StrategyRegistry } from "../src/registry.js";

describe("StrategyRegistry metadata", () => {
  it("publishes independent built-in strategies and editable defaults", () => {
    const strategies = new StrategyRegistry().list();
    expect(strategies.map((strategy) => strategy.id)).toEqual([
      "moving-average",
      "breakout-volume",
      "rsi-bollinger-rebound",
    ]);
    for (const strategy of strategies) {
      expect(strategy.description.length).toBeGreaterThan(0);
      expect(strategy.configFields.length).toBeGreaterThan(0);
      expect(Object.keys(strategy.defaultConfig).length).toBeGreaterThan(0);
    }
  });
});
