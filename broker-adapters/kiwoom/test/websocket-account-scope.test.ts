import { EventEmitter } from "node:events";

import type {
  AccountScope,
  BrokerEvent,
  CachedAccessToken,
  TokenStore,
} from "@kstock/shared";
import type WebSocket from "ws";
import { describe, expect, it } from "vitest";

import { KiwoomTokenManager } from "../src/auth.js";
import {
  KiwoomWebSocketClient,
  parseKiwoomKrxMarketStatusCode,
} from "../src/websocket.js";

const configuredRoot = "01234567";
const verifiedAccount = `${configuredRoot}01`;
const otherAccountWithSameRoot = `${configuredRoot}02`;

class MemoryTokenStore implements TokenStore {
  async get(): Promise<CachedAccessToken> {
    return {
      token: "cached-token",
      expiresAt: "2099-12-31T23:59:59.000Z",
    };
  }

  async set(): Promise<void> {}
  async delete(): Promise<void> {}
}

class FakeWebSocket extends EventEmitter {
  readyState = 1;

  send(raw: string): void {
    const packet = JSON.parse(raw) as { trnm?: string };
    if (packet.trnm === "LOGIN") {
      queueMicrotask(() => {
        this.emit("message", JSON.stringify({ trnm: "LOGIN", return_code: 0 }));
      });
    } else if (packet.trnm === "REG" || packet.trnm === "REMOVE") {
      queueMicrotask(() => {
        this.emit("message", JSON.stringify({ trnm: packet.trnm, return_code: 0 }));
      });
    }
  }

  terminate(): void {
    this.readyState = 3;
    this.emit("close");
  }

  close(): void {
    this.terminate();
  }

  receive(
    type: "00" | "04" | "0B",
    values: Record<string, string>,
    item = values["9001"] ?? "",
  ): void {
    this.emit("message", JSON.stringify({
      trnm: "REAL",
      data: [{ type, item, values }],
    }));
  }
}

interface Harness {
  client: KiwoomWebSocketClient;
  socket: FakeWebSocket;
  events: BrokerEvent[];
}

async function createHarness(): Promise<Harness> {
  const scope: AccountScope = {
    brokerId: "kiwoom",
    environment: "live",
    accountId: configuredRoot,
  };
  const tokenManager = new KiwoomTokenManager({
    baseUrl: "https://example.test",
    scope,
    credentials: {
      appKey: "app-key",
      appSecret: "app-secret",
      accountId: configuredRoot,
    },
    tokenStore: new MemoryTokenStore(),
  });
  const events: BrokerEvent[] = [];
  const socket = new FakeWebSocket();
  const client = new KiwoomWebSocketClient({
    url: "wss://example.test",
    scope,
    tokenManager,
    onEvent: (event) => events.push(event),
    onStatus: () => undefined,
    webSocketFactory: () => {
      queueMicrotask(() => socket.emit("open"));
      return socket as unknown as WebSocket;
    },
  });
  client.setVerifiedAccountId(verifiedAccount);
  await client.connect();
  events.length = 0;
  return { client, socket, events };
}

function orderValues(accountId?: string): Record<string, string> {
  return {
    ...(accountId === undefined ? {} : { "9201": accountId }),
    "9203": "0000001",
    "9001": "005930",
    "900": "2",
    "901": "70000",
    "902": "2",
    "905": "+매수",
    "913": "접수",
    "908": "090000",
  };
}

function balanceValues(accountId: string): Record<string, string> {
  return {
    "9201": accountId,
    "9001": "005930",
    "930": "2",
    "933": "2",
    "931": "70000",
    "10": "+71000",
  };
}

describe("Kiwoom WebSocket account scoping", () => {
  it("accepts a full 10-digit event for the verified account behind an 8-digit setting", async () => {
    const { client, socket, events } = await createHarness();
    socket.receive("00", orderValues(verifiedAccount));

    expect(events.filter((event) => event.type === "order")).toHaveLength(1);
    await client.disconnect();
  });

  it("drops order and balance events from another full account with the same root", async () => {
    const { client, socket, events } = await createHarness();
    socket.receive("00", orderValues(otherAccountWithSameRoot));
    socket.receive("04", balanceValues(otherAccountWithSameRoot));

    expect(events.filter((event) => event.type === "order")).toHaveLength(0);
    expect(events.filter((event) => event.type === "position")).toHaveLength(0);
    await client.disconnect();
  });

  it("fails closed when an account event omits FID 9201", async () => {
    const { client, socket, events } = await createHarness();
    socket.receive("00", orderValues());

    expect(events.filter((event) => event.type === "order")).toHaveLength(0);
    expect(events).toContainEqual(expect.objectContaining({
      type: "error",
      error: expect.objectContaining({ code: "WS_ACCOUNT_MISSING" }),
    }));
    await client.disconnect();
  });
});

describe("Kiwoom WebSocket quote normalization", () => {
  it("emits real-time trading dates in the shared YYYY-MM-DD format", async () => {
    const { client, socket, events } = await createHarness();
    socket.receive(
      "0B",
      { "10": "+71000", "13": "12345", "20": "091500" },
      "005930",
    );

    const event = events.find((candidate) => candidate.type === "quote");
    expect(event).toBeDefined();
    if (event?.type === "quote") {
      expect(event.quote.tradingDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
    await client.disconnect();
  });
});

describe("Kiwoom KRX market-operation status", () => {
  it.each([
    ["0", "PREOPEN"],
    ["3", "OPEN"],
    ["2", "OPEN"],
    ["4", "AFTER_HOURS"],
    ["8", "AFTER_HOURS"],
    ["a", "AFTER_HOURS"],
    ["b", "AFTER_HOURS"],
    ["c", "AFTER_HOURS"],
    ["9", "CLOSED"],
    ["d", "CLOSED"],
  ])("maps official KRX code %s to %s", (code, expected) => {
    expect(parseKiwoomKrxMarketStatusCode(code)).toBe(expected);
  });

  it.each(["P", "Q", "R", "S", "T", "U", "V", "e", "f", "o", "s", "unknown"])(
    "ignores non-KRX operation code %s instead of reporting a false close",
    (code) => {
      expect(parseKiwoomKrxMarketStatusCode(code)).toBeNull();
    },
  );
});
