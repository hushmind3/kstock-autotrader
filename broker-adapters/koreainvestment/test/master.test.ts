import { describe, expect, it } from "vitest";
import { readInstrumentSafetyMetadata } from "@kstock/shared";
import { parseKospiMaster } from "../src/master.js";

const widths = [
  2, 1, 4, 4, 4, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
  1, 1, 1, 1, 1, 1, 1, 1, 1, 9, 5, 5, 1, 1, 1, 2, 1, 1, 1, 2, 2, 2,
  3, 1, 3, 12, 12, 8, 15, 21, 2, 7, 1, 1, 1, 1, 1, 9, 9, 9, 5, 9, 8,
  9, 3, 1, 1, 1,
] as const;

function masterLine(overrides: Record<number, string> = {}): Buffer {
  const fields = widths.map((width, index) => (overrides[index] ?? "").padEnd(width).slice(0, width));
  const prefix = "005930".padEnd(9) + "KR7005930003" + "SAMSUNG";
  return Buffer.from(prefix + fields.join(""), "ascii");
}

describe("KIS KOSPI master safety parsing", () => {
  it("parses the official 227-byte tail after line endings are removed", () => {
    const [instrument] = parseKospiMaster(masterLine({ 49: "19750611" }));
    expect(instrument).toMatchObject({ symbol: "005930", name: "SAMSUNG", active: true });
    expect(readInstrumentSafetyMetadata(instrument!).buyAllowed).toBe(true);
  });

  it("normalizes broker restriction flags without dropping held-position monitoring", () => {
    const [instrument] = parseKospiMaster(masterLine({
      6: "Y",
      34: "Y",
      35: "Y",
      36: "Y",
      37: "02",
      38: "Y",
      39: "Y",
    }));
    const safety = readInstrumentSafetyMetadata(instrument!);
    expect(instrument?.active).toBe(true);
    expect(safety.buyAllowed).toBe(false);
    expect(safety.restrictionCodes).toEqual(expect.arrayContaining([
      "TRADING_SUSPENDED",
      "LIQUIDATION_TRADING",
      "MANAGED_ISSUE",
      "MARKET_WARNING",
      "MARKET_WARNING_FORECAST",
      "LOW_LIQUIDITY_DESIGNATION",
      "DISCLOSURE_VIOLATION",
    ]));
  });
});
