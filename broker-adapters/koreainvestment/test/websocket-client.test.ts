import { describe, expect, it } from "vitest";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { WebSocketServer } from "ws";
import { DEFAULT_KIS_WS_UNSUBSCRIBE_TR_TYPE } from "../src/constants.js";
import {
  KisWebSocketClient,
  kisRefusalState,
  kisWebSocketSendSucceeded,
  parseKisRealtimeQuote,
} from "../src/websocket-client.js";

function quoteFields(overrides: Record<number, string> = {}): string[] {
  const fields = Array.from({ length: 47 }, () => "");
  Object.assign(fields, {
    0: "005930",
    1: "091500",
    2: "71000",
    7: "70500",
    8: "71500",
    9: "70000",
    13: "12345",
    33: "20260914",
    45: "2",
    46: "69000",
    ...overrides,
  });
  return fields;
}

describe("KIS realtime quote normalization", () => {
  it("omits a fractional optional OHLC field and keeps the tradable tick", () => {
    expect(parseKisRealtimeQuote(
      quoteFields({ 7: "70500.25" }),
      "KRX",
      new Date("2026-09-14T00:15:00.000Z"),
    )).toMatchObject({
      symbol: "005930",
      price: 71_000,
      high: 71_500,
      low: 70_000,
      cumulativeVolume: 12_345,
      tradingDate: "2026-09-14",
      tradingTime: "091500",
      brokerTimestampVerified: true,
    });
    expect(parseKisRealtimeQuote(quoteFields({ 7: "70500.25" }))).not.toHaveProperty("open");
  });

  it.each([
    [{ 2: "71000.25" }, "fractional required price"],
    [{ 13: "12345.5" }, "fractional cumulative volume"],
    [{ 13: "not-a-number" }, "non-numeric cumulative volume"],
    [{ 13: "" }, "missing cumulative volume"],
  ] as const)("drops a tick with %s (%s)", (overrides) => {
    expect(parseKisRealtimeQuote(quoteFields(overrides))).toBeNull();
  });
});

describe("KIS account notice normalization", () => {
  it("uses the documented numeric refusal flag", () => {
    expect(kisRefusalState("0")).toBe("approved");
    expect(kisRefusalState("1")).toBe("refused");
  });

  it("fails closed for an undocumented refusal flag", () => {
    expect(kisRefusalState("")).toBe("unknown");
    expect(kisRefusalState("unexpected")).toBe("unknown");
  });
});

describe("KIS websocket subscription budget", () => {
  it("reserves the account-notice slot and caps market quotes at the safe 40-slot limit", () => {
    const client = new KisWebSocketClient({
      url: "ws://example.invalid",
      environment: "paper",
      cano: "12345678",
      htsId: "test-hts-id",
      unsubscribeTrType: "2",
      approvalKey: async () => "approval",
      onQuote: () => undefined,
      onOrder: () => undefined,
      onExecution: () => undefined,
      onConnection: () => undefined,
      onError: () => undefined,
    });

    expect(client.quoteLimit).toBe(40);
  });

  it("sends the official register/unregister values when replacing quote subscriptions", async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await once(server, "listening");
    const requests: Array<{ header: { tr_type: string }; body: { input: { tr_id: string; tr_key: string } } }> = [];
    server.on("connection", (socket) => {
      socket.on("message", (data) => {
        const request = JSON.parse(data.toString()) as (typeof requests)[number];
        requests.push(request);
        socket.send(JSON.stringify({
          header: request.body.input,
          body: { rt_cd: "0", msg1: request.header.tr_type === "1" ? "SUBSCRIBE SUCCESS" : "UNSUBSCRIBE SUCCESS" },
        }));
      });
    });
    const client = new KisWebSocketClient({
      url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}`,
      environment: "paper",
      cano: "12345678",
      htsId: undefined,
      unsubscribeTrType: DEFAULT_KIS_WS_UNSUBSCRIBE_TR_TYPE,
      approvalKey: async () => "local-test-approval",
      onQuote: () => undefined,
      onOrder: () => undefined,
      onExecution: () => undefined,
      onConnection: () => undefined,
      onError: () => undefined,
    });
    try {
      await client.start();
      await client.replaceQuoteSubscriptions(["005930"]);
      await client.replaceQuoteSubscriptions([]);

      expect(requests.map((request) => request.header.tr_type)).toEqual(["1", "2"]);
      expect(requests.map((request) => request.body.input)).toEqual([
        { tr_id: "H0STCNT0", tr_key: "005930" },
        { tr_id: "H0STCNT0", tr_key: "005930" },
      ]);
    } finally {
      await client.stop();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("keeps 47-field multi-record quote frames aligned and drops unrequested symbols", async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await once(server, "listening");
    const quotes: Array<{ symbol: string; price: number; open?: number; cumulativeVolume: number }> = [];
    server.on("connection", (socket) => {
      socket.on("message", (data) => {
        const request = JSON.parse(data.toString()) as {
          body: { input: { tr_id: string; tr_key: string } };
        };
        socket.send(JSON.stringify({
          header: request.body.input,
          body: { rt_cd: "0", msg1: "SUBSCRIBE SUCCESS" },
        }));
        if (request.body.input.tr_key === "005930") {
          const requested = quoteFields({ 0: "005930", 2: "71000", 7: "70500", 46: "249500" });
          const unrequested = quoteFields({ 0: "000660", 1: "091501", 2: "343000", 7: "343210.75" });
          socket.send(`0|H0STCNT0|002|${[...requested, ...unrequested].join("^")}`);
        }
      });
    });
    const errors: string[] = [];
    const client = new KisWebSocketClient({
      url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}`,
      environment: "paper",
      cano: "12345678",
      htsId: undefined,
      unsubscribeTrType: DEFAULT_KIS_WS_UNSUBSCRIBE_TR_TYPE,
      approvalKey: async () => "local-test-approval",
      onQuote: (quote) => quotes.push(quote),
      onOrder: () => undefined,
      onExecution: () => undefined,
      onConnection: () => undefined,
      onError: (message) => errors.push(message),
    });
    try {
      await client.start();
      await client.replaceQuoteSubscriptions(["005930"]);
      await new Promise((resolve) => setTimeout(resolve, 25));

      expect(quotes).toEqual([
        expect.objectContaining({
          symbol: "005930",
          price: 71_000,
          open: 70_500,
          cumulativeVolume: 12_345,
        }),
      ]);
      expect(errors).toEqual([]);
    } finally {
      await client.stop();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("rejects a quote frame whose field count cannot form exact records", async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await once(server, "listening");
    const quotes: unknown[] = [];
    const errors: string[] = [];
    server.on("connection", (socket) => {
      socket.on("message", (data) => {
        const request = JSON.parse(data.toString()) as {
          body: { input: { tr_id: string; tr_key: string } };
        };
        socket.send(JSON.stringify({
          header: request.body.input,
          body: { rt_cd: "0", msg1: "SUBSCRIBE SUCCESS" },
        }));
        socket.send(`0|H0STCNT0|002|${quoteFields().join("^")}`);
      });
    });
    const client = new KisWebSocketClient({
      url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}`,
      environment: "paper",
      cano: "12345678",
      htsId: undefined,
      unsubscribeTrType: DEFAULT_KIS_WS_UNSUBSCRIBE_TR_TYPE,
      approvalKey: async () => "local-test-approval",
      onQuote: (quote) => quotes.push(quote),
      onOrder: () => undefined,
      onExecution: () => undefined,
      onConnection: () => undefined,
      onError: (message) => errors.push(message),
    });
    try {
      await client.start();
      await client.replaceQuoteSubscriptions(["005930"]);
      await new Promise((resolve) => setTimeout(resolve, 25));

      expect(quotes).toEqual([]);
      expect(errors).toEqual([
        expect.stringContaining("Malformed KIS realtime quote frame"),
      ]);
    } finally {
      await client.stop();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});

describe("KIS websocket send callback", () => {
  it("accepts both Node success callback forms", () => {
    expect(kisWebSocketSendSucceeded(undefined)).toBe(true);
    expect(kisWebSocketSendSucceeded(null)).toBe(true);
    expect(kisWebSocketSendSucceeded(new Error("send failed"))).toBe(false);
  });
});
