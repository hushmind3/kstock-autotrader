import type {
  BrokerHealth,
  ConnectionState,
  TradingEnvironment,
} from "@kstock/shared";

export type BrokerConnectionStage =
  | "DISABLED"
  | "CREDENTIALS_REQUIRED"
  | "CONNECTING"
  | "AUTHENTICATING"
  | "ACCOUNT_SYNCING"
  | "WAITING_MARKET_STATUS"
  | "READY"
  | "DEGRADED"
  | "ERROR";

export interface BrokerConnectionReadiness {
  environment: TradingEnvironment;
  stage: BrokerConnectionStage;
  credentialsStored: boolean;
  brokerAuthenticated: boolean;
  accountSynchronized: boolean;
  marketWebSocketConnected: boolean;
  accountWebSocketConnected: boolean;
  marketStatusConfirmed: boolean;
  orderWindowOpen: boolean;
  readyForOrders: boolean;
  runtimeState: ConnectionState | "CREDENTIALS_REQUIRED";
  message: string;
  lastError: string | null;
}

interface BrokerConnectionInput {
  environment: TradingEnvironment;
  enabled: boolean;
  credentialsStored: boolean;
  health: BrokerHealth | null;
  accountSynchronized: boolean;
  marketStatusConfirmed: boolean;
  orderWindowOpen: boolean;
}

/**
 * Keeps credential, broker transport, account reconciliation and market-session
 * readiness separate. In particular, a REST/account connection must not be
 * reported as an authentication failure while the engine is only waiting for
 * the first official market-status event of the trading date.
 */
export function summarizeBrokerConnection(
  input: BrokerConnectionInput,
): BrokerConnectionReadiness {
  const health = input.health;
  const brokerAuthenticated = health?.restConnected === true;
  const accountSynchronized = brokerAuthenticated && input.accountSynchronized;
  const marketWebSocketConnected = health?.marketWebSocketConnected === true;
  const accountWebSocketConnected = health?.accountWebSocketConnected === true;
  const runtimeState: ConnectionState | "CREDENTIALS_REQUIRED" = health?.state ?? (
    input.credentialsStored ? "DISABLED" : "CREDENTIALS_REQUIRED"
  );
  const base = {
    environment: input.environment,
    credentialsStored: input.credentialsStored,
    brokerAuthenticated,
    accountSynchronized,
    marketWebSocketConnected,
    accountWebSocketConnected,
    marketStatusConfirmed: input.marketStatusConfirmed,
    orderWindowOpen: input.orderWindowOpen,
    runtimeState,
    lastError: health?.lastError ?? null,
  };

  if (!input.credentialsStored) {
    return {
      ...base,
      stage: "CREDENTIALS_REQUIRED",
      readyForOrders: false,
      message: "API 자격정보가 아직 저장되지 않았습니다.",
    };
  }

  if (!input.enabled) {
    return {
      ...base,
      stage: "DISABLED",
      readyForOrders: false,
      message: "API 자격정보는 저장되어 있으며 증권사 연결은 꺼져 있습니다.",
    };
  }

  if (health === null) {
    return {
      ...base,
      stage: "CONNECTING",
      readyForOrders: false,
      message: "증권사 연결을 시작하고 있습니다.",
    };
  }

  if (health.state === "ERROR") {
    return {
      ...base,
      stage: "ERROR",
      readyForOrders: false,
      message: health.lastError
        ? `증권사 인증 또는 연결에 실패했습니다: ${health.lastError}`
        : "증권사 인증 또는 연결에 실패했습니다.",
    };
  }

  if (!brokerAuthenticated) {
    const authenticating = health.state === "AUTHENTICATING";
    return {
      ...base,
      stage: authenticating ? "AUTHENTICATING" : "CONNECTING",
      readyForOrders: false,
      message: authenticating
        ? "증권사 API 인증을 확인하고 있습니다."
        : "증권사 API 연결을 확인하고 있습니다.",
    };
  }

  if (!accountSynchronized) {
    return {
      ...base,
      stage: "ACCOUNT_SYNCING",
      readyForOrders: false,
      message: "증권사 API 인증은 완료됐고 계좌·주문 원장을 동기화하고 있습니다.",
    };
  }

  // This is the adapter's raw health. A transport/WebSocket degradation must
  // remain visible and must not be mislabeled as market-status waiting.
  if (
    health.state !== "CONNECTED" ||
    !marketWebSocketConnected ||
    !accountWebSocketConnected
  ) {
    return {
      ...base,
      stage: "DEGRADED",
      readyForOrders: false,
      message: health.lastError
        ? `인증과 계좌 동기화는 완료됐지만 실시간 연결이 불안정합니다: ${health.lastError}`
        : "인증과 계좌 동기화는 완료됐지만 실시간 연결이 준비되지 않았습니다.",
    };
  }

  if (!input.orderWindowOpen) {
    return {
      ...base,
      stage: "READY",
      readyForOrders: false,
      message: "증권사 인증, 계좌 동기화와 실시간 연결이 완료되었습니다. 현재 선택한 시장은 주문시간이 아닙니다.",
    };
  }

  if (!input.marketStatusConfirmed) {
    return {
      ...base,
      stage: "WAITING_MARKET_STATUS",
      readyForOrders: false,
      message: "증권사 인증과 계좌 동기화가 완료되었습니다. 공식 장 운영상태 확인을 기다리고 있습니다.",
    };
  }

  return {
    ...base,
    stage: "READY",
    readyForOrders: true,
    message: "증권사 인증, 계좌 동기화, 실시간 연결과 장 운영상태 확인이 완료되었습니다.",
  };
}
