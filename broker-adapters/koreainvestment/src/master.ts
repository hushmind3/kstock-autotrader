import { inflateRawSync } from "node:zlib";
import { TextDecoder } from "node:util";
import {
  BrokerTransportError,
  createInstrumentSafetyMetadata,
  type Instrument,
  type InstrumentRestrictionCode,
} from "@kstock/shared";
import { KIS_KOSPI_MASTER_URL } from "./constants.js";

const KOSPI_TAIL_WIDTHS = [
  2, 1, 4, 4, 4, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
  1, 1, 1, 1, 1, 1, 1, 1, 1, 9, 5, 5, 1, 1, 1, 2, 1, 1, 1, 2, 2, 2,
  3, 1, 3, 12, 12, 8, 15, 21, 2, 7, 1, 1, 1, 1, 1, 9, 9, 9, 5, 9, 8,
  9, 3, 1, 1, 1,
] as const;

// The official Python sample slices 228 text characters including the line
// ending. splitLines removes that terminator, leaving 227 fixed-width bytes.
const KOSPI_TAIL_BYTES = 227;
const MAX_MASTER_BYTES = 64 * 1024 * 1024;

function readUInt32(buffer: Buffer, offset: number): number {
  if (offset < 0 || offset + 4 > buffer.length) {
    throw new BrokerTransportError("Malformed KIS KOSPI ZIP", "KIS_MASTER_ZIP");
  }
  return buffer.readUInt32LE(offset);
}

function readUInt16(buffer: Buffer, offset: number): number {
  if (offset < 0 || offset + 2 > buffer.length) {
    throw new BrokerTransportError("Malformed KIS KOSPI ZIP", "KIS_MASTER_ZIP");
  }
  return buffer.readUInt16LE(offset);
}

function findEndOfCentralDirectory(buffer: Buffer): number {
  const minimum = Math.max(0, buffer.length - 65_557);
  for (let offset = buffer.length - 22; offset >= minimum; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x0605_4b50) return offset;
  }
  throw new BrokerTransportError(
    "KIS KOSPI master ZIP has no central directory",
    "KIS_MASTER_ZIP",
  );
}

export function extractMasterFromZip(zip: Buffer): Buffer {
  const eocd = findEndOfCentralDirectory(zip);
  const entries = readUInt16(zip, eocd + 10);
  let offset = readUInt32(zip, eocd + 16);

  for (let index = 0; index < entries; index += 1) {
    if (readUInt32(zip, offset) !== 0x0201_4b50) {
      throw new BrokerTransportError(
        "Malformed KIS KOSPI ZIP central entry",
        "KIS_MASTER_ZIP",
      );
    }
    const flags = readUInt16(zip, offset + 8);
    const method = readUInt16(zip, offset + 10);
    const compressedSize = readUInt32(zip, offset + 20);
    const uncompressedSize = readUInt32(zip, offset + 24);
    const nameLength = readUInt16(zip, offset + 28);
    const extraLength = readUInt16(zip, offset + 30);
    const commentLength = readUInt16(zip, offset + 32);
    const localOffset = readUInt32(zip, offset + 42);
    const name = zip
      .subarray(offset + 46, offset + 46 + nameLength)
      .toString("utf8");

    if (name.toLowerCase().endsWith(".mst")) {
      if ((flags & 0x1) !== 0) {
        throw new BrokerTransportError(
          "Encrypted KIS master ZIP is unsupported",
          "KIS_MASTER_ZIP_ENCRYPTED",
        );
      }
      if (uncompressedSize > MAX_MASTER_BYTES) {
        throw new BrokerTransportError(
          "KIS master ZIP entry is unexpectedly large",
          "KIS_MASTER_ZIP_SIZE",
        );
      }
      if (readUInt32(zip, localOffset) !== 0x0403_4b50) {
        throw new BrokerTransportError(
          "Malformed KIS KOSPI ZIP local entry",
          "KIS_MASTER_ZIP",
        );
      }
      const localNameLength = readUInt16(zip, localOffset + 26);
      const localExtraLength = readUInt16(zip, localOffset + 28);
      const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
      const compressed = zip.subarray(dataOffset, dataOffset + compressedSize);
      const data =
        method === 0
          ? Buffer.from(compressed)
          : method === 8
            ? inflateRawSync(compressed, { maxOutputLength: MAX_MASTER_BYTES })
            : undefined;
      if (data === undefined) {
        throw new BrokerTransportError(
          `Unsupported KIS master ZIP compression method ${method}`,
          "KIS_MASTER_ZIP_COMPRESSION",
        );
      }
      if (data.length !== uncompressedSize) {
        throw new BrokerTransportError(
          "KIS master ZIP size check failed",
          "KIS_MASTER_ZIP_SIZE",
        );
      }
      return data;
    }

    offset += 46 + nameLength + extraLength + commentLength;
  }

  throw new BrokerTransportError(
    "KIS KOSPI ZIP does not contain an MST file",
    "KIS_MASTER_ZIP",
  );
}

function splitLines(buffer: Buffer): Buffer[] {
  const lines: Buffer[] = [];
  let start = 0;
  while (start < buffer.length) {
    const newline = buffer.indexOf(0x0a, start);
    const end = newline < 0 ? buffer.length : newline;
    const withoutCarriageReturn =
      end > start && buffer[end - 1] === 0x0d ? end - 1 : end;
    if (withoutCarriageReturn > start) {
      lines.push(buffer.subarray(start, withoutCarriageReturn));
    }
    if (newline < 0) break;
    start = newline + 1;
  }
  return lines;
}

function decodeCp949(buffer: Buffer, decoder: TextDecoder): string {
  return decoder.decode(buffer).trim();
}

function positiveFlag(value: string | undefined): boolean {
  const normalized = value?.trim().toUpperCase() ?? "";
  return normalized !== "" && !["0", "00", "N", "NO", "FALSE"].includes(normalized);
}

function kisInstrumentRestrictions(fields: readonly string[], name: string): InstrumentRestrictionCode[] {
  const restrictions: InstrumentRestrictionCode[] = [];
  if (fields[34] === "Y") restrictions.push("TRADING_SUSPENDED");
  if (fields[35] === "Y") restrictions.push("LIQUIDATION_TRADING");
  if (fields[36] === "Y") restrictions.push("MANAGED_ISSUE");
  if (positiveFlag(fields[37])) restrictions.push("MARKET_WARNING");
  if (fields[38] === "Y") restrictions.push("MARKET_WARNING_FORECAST");
  if (fields[39] === "Y") restrictions.push("DISCLOSURE_VIOLATION");
  if (fields[6] === "Y") restrictions.push("LOW_LIQUIDITY_DESIGNATION");
  if (positiveFlag(fields[22])) restrictions.push("SHORT_TERM_OVERHEATED");
  if (positiveFlag(fields[12]) || /ETF|ETN|ELW|인버스|레버리지/.test(name.toUpperCase())) {
    restrictions.push("HIGH_RISK_EXCHANGE_PRODUCT");
  }
  if (fields[19] === "Y" || /스팩|SPAC|기업인수목적/.test(name.toUpperCase())) {
    restrictions.push("SPAC");
  }
  return [...new Set(restrictions)];
}

export function parseKospiMaster(data: Buffer): Instrument[] {
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder("euc-kr", { fatal: false });
  } catch (error) {
    throw new BrokerTransportError(
      "This Node.js runtime does not provide the euc-kr decoder required by the KIS master file",
      "KIS_MASTER_CP949",
      error,
    );
  }

  const instruments: Instrument[] = [];
  for (const line of splitLines(data)) {
    if (line.length < 21 + KOSPI_TAIL_BYTES) continue;
    const prefixEnd = line.length - KOSPI_TAIL_BYTES;
    const symbol = line.subarray(0, 9).toString("ascii").trim().toUpperCase();
    if (!/^[0-9A-Z]{6}$/.test(symbol)) continue;
    const standardCode = line.subarray(9, 21).toString("ascii").trim();
    const name = decodeCp949(line.subarray(21, prefixEnd), decoder);
    if (name === "") continue;

    const tail = line.subarray(prefixEnd);
    const fields: string[] = [];
    let cursor = 0;
    for (const width of KOSPI_TAIL_WIDTHS) {
      fields.push(tail.subarray(cursor, cursor + width).toString("ascii").trim());
      cursor += width;
    }
    if (cursor !== KOSPI_TAIL_BYTES) {
      throw new BrokerTransportError(
        "Internal KIS KOSPI master schema width mismatch",
        "KIS_MASTER_SCHEMA",
      );
    }

    const listedDate = fields[49] ?? "";
    const tradingSuspended = fields[34] === "Y";
    const liquidation = fields[35] === "Y";
    const restrictionCodes = kisInstrumentRestrictions(fields, name);
    const instrument: Instrument = {
      symbol,
      name,
      market: "KOSPI",
      exchange: "KRX",
      active: true,
      raw: {
        standardCode,
        groupCode: fields[0] ?? "",
        tradingSuspended,
        liquidation,
        managedIssue: fields[36] === "Y",
        marketWarning: fields[37] ?? "",
        kospiIndicator: fields[58] ?? "",
        lowLiquidity: fields[6] === "Y",
        shortTermOverheated: positiveFlag(fields[22]),
        warningForecast: fields[38] === "Y",
        disclosureViolation: fields[39] === "Y",
        etpProduct: positiveFlag(fields[12]),
        spac: fields[19] === "Y",
        safety: createInstrumentSafetyMetadata("kis-kospi-master", restrictionCodes),
      },
    };
    if (/^\d{8}$/.test(listedDate)) instrument.listedDate = listedDate;
    instruments.push(instrument);
  }

  if (instruments.length === 0) {
    throw new BrokerTransportError(
      "KIS KOSPI master contained no supported six-character instruments",
      "KIS_MASTER_EMPTY",
    );
  }
  instruments.sort((left, right) => left.symbol.localeCompare(right.symbol));
  return instruments;
}

export async function fetchKospiMaster(
  fetchImplementation: typeof fetch,
  url = KIS_KOSPI_MASTER_URL,
  timeoutMs = 30_000,
): Promise<Instrument[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImplementation(url, {
      method: "GET",
      signal: controller.signal,
      headers: { Accept: "application/zip" },
    });
    if (!response.ok) {
      throw new BrokerTransportError(
        `KIS KOSPI master download failed with HTTP ${response.status}`,
        "KIS_MASTER_HTTP",
      );
    }
    const zip = Buffer.from(await response.arrayBuffer());
    return parseKospiMaster(extractMasterFromZip(zip));
  } catch (error) {
    if (error instanceof BrokerTransportError) throw error;
    throw new BrokerTransportError(
      "Unable to download or parse the KIS KOSPI master",
      "KIS_MASTER_TRANSPORT",
      error instanceof Error ? { name: error.name, message: error.message } : undefined,
    );
  } finally {
    clearTimeout(timeout);
  }
}
