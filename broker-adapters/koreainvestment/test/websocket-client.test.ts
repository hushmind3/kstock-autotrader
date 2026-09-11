import { describe, expect, it } from "vitest";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { WebSocketServer } from "ws";
import { DEFAULT_KIS_WS_UNSUBSCRIBE_TR_TYPE } from "../src/constants.js";
import {
  KisWebSocketClient,
  kisRefusalState,
  kisWebSocketSendSucceeded,
} from "../src/websocket-client.js";

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
});

describe("KIS websocket send callback", () => {
  it("accepts both Node success callback forms", () => {
    expect(kisWebSocketSendSucceeded(undefined)).toBe(true);
    expect(kisWebSocketSendSucceeded(null)).toBe(true);
    expect(kisWebSocketSendSucceeded(new Error("send failed"))).toBe(false);
  });
});
