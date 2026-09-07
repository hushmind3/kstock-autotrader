import { describe, expect, it } from "vitest";
import type { Quote } from "@kstock/shared";
import {
  isFreshKiwoomRegularSessionQuote,
  isFreshVerifiedBrokerQuote,
} from "../src/core/trading-engine.js";

const now = new Date("2026-09-03T04:00:05.000Z"); // 13:00:05 KST
const fresh: Quote = {
  symbol: "005930",
  price: 70_000,
  cumulativeVolume: 1_000_000,
  tradingDate: "2026-09-03",
  tradingTime: "130003",
  receivedAt: "2026-09-03T04:00:04.000Z",
  source: "kiwoom",
  brokerTimestampVerified: true,
};

describe("Kiwoom mid-session OPEN evidence", () => {
  it("accepts only a current regular-session trade with verified broker fields", () => {
    expect(isFreshKiwoomRegularSessionQuote(fresh, now, 30_000)).toBe(true);
  });

  it.each([
    ["missing verification", { brokerTimestampVerified: undefined }],
    ["parser marked stale", { stale: true }],
    ["previous trading date", { tradingDate: "2026-09-02" }],
    ["pre-open time", { tradingTime: "085959" }],
    ["after-hours time", { tradingTime: "153001" }],
    ["old broker trade", { tradingTime: "125900" }],
    ["old receive time", { receivedAt: "2026-09-03T03:59:00.000Z" }],
    ["zero volume", { cumulativeVolume: 0 }],
  ])("rejects %s", (_name, patch) => {
    expect(isFreshKiwoomRegularSessionQuote({ ...fresh, ...patch }, now, 30_000)).toBe(false);
  });

  it("never accepts another broker as Kiwoom market evidence", () => {
    expect(
      isFreshKiwoomRegularSessionQuote(
        { ...fresh, source: "koreainvestment" },
        now,
        30_000,
      ),
    ).toBe(false);
  });

  it("accepts a verified KIS/NXT timestamp without imposing KRX regular hours", () => {
    const nxtNow = new Date("2026-09-02T23:10:05.000Z"); // 08:10:05 KST
    expect(isFreshVerifiedBrokerQuote({
      ...fresh,
      source: "koreainvestment",
      exchange: "NXT",
      tradingDate: "2026-09-03",
      tradingTime: "081003",
      receivedAt: "2026-09-02T23:10:04.000Z",
    }, nxtNow, 30_000)).toBe(true);
  });
});
