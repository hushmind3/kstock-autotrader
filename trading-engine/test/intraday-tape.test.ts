import { describe, expect, it } from "vitest";
import { createInMemoryTradingRepository } from "@kstock/database";
import type { Quote } from "@kstock/shared";
import { IntradayTape } from "../src/core/intraday-tape.js";
const scope = { brokerId: "kiwoom", environment: "live", accountId: "test" } as const;
const start = Date.parse("2026-09-11T01:00:00Z");
const time = (seconds: number) => new Date(start + seconds * 1000);
function quote(seconds: number): Quote {
  return { symbol: "005930", source: "kiwoom", exchange: "SOR", price: 10000 + seconds,
    cumulativeVolume: 1000 + seconds, tradingDate: "2026-09-11",
    tradingTime: new Date(time(seconds).getTime() + 9 * 3600000).toISOString().slice(11, 19).replaceAll(":", ""),
    receivedAt: time(seconds).toISOString(), brokerTimestampVerified: true };
}
describe("real intraday tape", () => {
  it("persists real samples, replaces same-second ticks, and restores without fabricating observations", () => {
    const repository = createInMemoryTradingRepository();
    try {
      const tape = new IntradayTape(repository);
      for (let second = 0; second <= 120; second++) expect(tape.observe(scope, quote(second), time(second))).toBe(true);
      tape.observe(scope, { ...quote(120), price: 10125 }, time(120));
      tape.flush();
      const restored = new IntradayTape(repository).samples(scope, "SOR", "005930", time(120), 120);
      expect(restored).toHaveLength(121);
      expect(restored.at(-1)?.price).toBe(10125);
      expect(tape.samples(scope, "KRX", "005930", time(120))).toEqual([]);
      expect(tape.samples(scope, "SOR", "005930", time(151))).toEqual([]);
    } finally { repository.close(); }
  });
  it("rejects invalid, stale, unverified and reordered ticks and invalidates persisted history on reconnect", () => {
    const repository = createInMemoryTradingRepository();
    try {
      const tape = new IntradayTape(repository);
      tape.observe(scope, quote(10), time(10));
      expect(tape.observe(scope, quote(9), time(10))).toBe(false);
      expect(tape.observe(scope, { ...quote(11), brokerTimestampVerified: false }, time(11))).toBe(false);
      expect(tape.observe(scope, { ...quote(11), price: NaN }, time(11))).toBe(false);
      expect(tape.observe(scope, quote(11), time(40))).toBe(false);
      tape.flush();
      new IntradayTape(repository).resetScope(scope, time(12));
      const reset = new IntradayTape(repository);
      expect(reset.samples(scope, "SOR", "005930", time(12))).toEqual([]);
      expect(reset.observe(scope, quote(11), time(12))).toBe(false);
      expect(reset.observe(scope, quote(13), time(13))).toBe(true);
      reset.observe(scope, quote(50), time(50));
      expect(reset.samples(scope, "SOR", "005930", time(50))).toHaveLength(1);
    } finally { repository.close(); }
  });
});
