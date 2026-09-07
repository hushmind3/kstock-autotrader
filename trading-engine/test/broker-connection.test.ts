import { describe, expect, it } from "vitest";
import type { BrokerHealth } from "@kstock/shared";
import { summarizeBrokerConnection } from "../src/core/broker-connection.js";

function connectedHealth(overrides: Partial<BrokerHealth> = {}): BrokerHealth {
  return {
    state: "CONNECTED",
    restConnected: true,
    marketWebSocketConnected: true,
    accountWebSocketConnected: true,
    checkedAt: "2026-09-02T00:00:00.000Z",
    ...overrides,
  };
}

describe("broker connection readiness", () => {
  it("reports completed authentication/account sync separately from market-status waiting", () => {
    const connection = summarizeBrokerConnection({
      environment: "live",
      enabled: true,
      credentialsStored: true,
      health: connectedHealth(),
      accountSynchronized: true,
      marketStatusConfirmed: false,
      orderWindowOpen: true,
    });

    expect(connection).toMatchObject({
      stage: "WAITING_MARKET_STATUS",
      credentialsStored: true,
      brokerAuthenticated: true,
      accountSynchronized: true,
      marketStatusConfirmed: false,
      readyForOrders: false,
      runtimeState: "CONNECTED",
    });
    expect(connection.message).toContain("인증과 계좌 동기화가 완료");
    expect(connection.message).not.toContain("인증 또는 연결에 실패");
  });

  it("does not hide a raw WebSocket degradation behind market-status waiting", () => {
    const connection = summarizeBrokerConnection({
      environment: "live",
      enabled: true,
      credentialsStored: true,
      health: connectedHealth({
        state: "DEGRADED",
        accountWebSocketConnected: false,
        lastError: "account stream disconnected",
      }),
      accountSynchronized: true,
      marketStatusConfirmed: false,
      orderWindowOpen: true,
    });

    expect(connection).toMatchObject({
      stage: "DEGRADED",
      brokerAuthenticated: true,
      accountSynchronized: true,
      accountWebSocketConnected: false,
      readyForOrders: false,
      lastError: "account stream disconnected",
    });
  });

  it("fails readiness when a transport flag contradicts CONNECTED state", () => {
    const connection = summarizeBrokerConnection({
      environment: "live",
      enabled: true,
      credentialsStored: true,
      health: connectedHealth({ marketWebSocketConnected: false }),
      accountSynchronized: true,
      marketStatusConfirmed: true,
      orderWindowOpen: true,
    });

    expect(connection).toMatchObject({
      stage: "DEGRADED",
      marketWebSocketConnected: false,
      readyForOrders: false,
    });
  });

  it("distinguishes authentication failure from saved credentials", () => {
    const connection = summarizeBrokerConnection({
      environment: "live",
      enabled: true,
      credentialsStored: true,
      health: connectedHealth({
        state: "ERROR",
        restConnected: false,
        marketWebSocketConnected: false,
        accountWebSocketConnected: false,
        lastError: "authentication denied",
      }),
      accountSynchronized: false,
      marketStatusConfirmed: false,
      orderWindowOpen: true,
    });

    expect(connection).toMatchObject({
      stage: "ERROR",
      credentialsStored: true,
      brokerAuthenticated: false,
      accountSynchronized: false,
      readyForOrders: false,
    });
  });

  it("reports order readiness only after all connection prerequisites complete", () => {
    expect(summarizeBrokerConnection({
      environment: "live",
      enabled: true,
      credentialsStored: true,
      health: connectedHealth(),
      accountSynchronized: true,
      marketStatusConfirmed: true,
      orderWindowOpen: true,
    })).toMatchObject({
      stage: "READY",
      readyForOrders: true,
    });
  });

  it("keeps a healthy connection ready while the selected market is closed", () => {
    expect(summarizeBrokerConnection({
      environment: "live",
      enabled: true,
      credentialsStored: true,
      health: connectedHealth(),
      accountSynchronized: true,
      marketStatusConfirmed: false,
      orderWindowOpen: false,
    })).toMatchObject({
      stage: "READY",
      readyForOrders: false,
      orderWindowOpen: false,
      runtimeState: "CONNECTED",
    });
  });
});
