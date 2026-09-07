import { describe, expect, it } from "vitest";
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
});

describe("KIS websocket send callback", () => {
  it("accepts both Node success callback forms", () => {
    expect(kisWebSocketSendSucceeded(undefined)).toBe(true);
    expect(kisWebSocketSendSucceeded(null)).toBe(true);
    expect(kisWebSocketSendSucceeded(new Error("send failed"))).toBe(false);
  });
});
