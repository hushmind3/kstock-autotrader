import type { Instrument } from "./domain.js";

export const INSTRUMENT_RESTRICTION_CODES = [
  "DELISTING",
  "TRADING_SUSPENDED",
  "LIQUIDATION_TRADING",
  "MANAGED_ISSUE",
  "MARKET_WARNING",
  "MARKET_WARNING_FORECAST",
  "INVESTMENT_CAUTION",
  "AUDIT_ISSUE",
  "LOW_LIQUIDITY_DESIGNATION",
  "SHORT_TERM_OVERHEATED",
  "DISCLOSURE_VIOLATION",
  "HIGH_RISK_EXCHANGE_PRODUCT",
  "SPAC",
] as const;

export type InstrumentRestrictionCode =
  (typeof INSTRUMENT_RESTRICTION_CODES)[number];

export interface InstrumentSafetyMetadata {
  source: string;
  buyAllowed: boolean;
  restrictionCodes: InstrumentRestrictionCode[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function createInstrumentSafetyMetadata(
  source: string,
  restrictionCodes: readonly InstrumentRestrictionCode[],
): InstrumentSafetyMetadata {
  return {
    source,
    buyAllowed: restrictionCodes.length === 0,
    restrictionCodes: [...new Set(restrictionCodes)],
  };
}

export function readInstrumentSafetyMetadata(
  instrument: Instrument,
): InstrumentSafetyMetadata {
  const raw = isRecord(instrument.raw) ? instrument.raw : null;
  const safety = raw && isRecord(raw.safety) ? raw.safety : null;
  const restrictionCodes = Array.isArray(safety?.restrictionCodes)
    ? safety.restrictionCodes.filter(
        (value): value is InstrumentRestrictionCode =>
          typeof value === "string" &&
          (INSTRUMENT_RESTRICTION_CODES as readonly string[]).includes(value),
      )
    : [];
  if (safety && typeof safety.buyAllowed === "boolean") {
    return {
      source: typeof safety.source === "string" ? safety.source : "broker-universe",
      buyAllowed: instrument.active && safety.buyAllowed && restrictionCodes.length === 0,
      restrictionCodes,
    };
  }
  return {
    source: "legacy-instrument-record",
    buyAllowed: instrument.active,
    restrictionCodes: instrument.active ? [] : ["DELISTING"],
  };
}

export function isInstrumentBuyAllowed(instrument: Instrument | null): boolean {
  return instrument !== null && readInstrumentSafetyMetadata(instrument).buyAllowed;
}
