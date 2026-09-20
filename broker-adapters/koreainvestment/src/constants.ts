import type { Exchange, TradingEnvironment } from "@kstock/shared";

export const KIS_ENDPOINTS: Record<
  TradingEnvironment,
  { readonly rest: string; readonly webSocket: string }
> = {
  live: {
    rest: "https://openapi.koreainvestment.com:9443",
    webSocket: "ws://ops.koreainvestment.com:21000/tryitout",
  },
  paper: {
    rest: "https://openapivts.koreainvestment.com:29443",
    webSocket: "ws://ops.koreainvestment.com:31000/tryitout",
  },
};

export const KIS_PATHS = {
  accessToken: "/oauth2/tokenP",
  approval: "/oauth2/Approval",
  hashkey: "/uapi/hashkey",
  currentPrice: "/uapi/domestic-stock/v1/quotations/inquire-price",
  indexPrice: "/uapi/domestic-stock/v1/quotations/inquire-index-price",
  dailyBars:
    "/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice",
  multiPrice: "/uapi/domestic-stock/v1/quotations/intstock-multprice",
  holiday: "/uapi/domestic-stock/v1/quotations/chk-holiday",
  cashOrder: "/uapi/domestic-stock/v1/trading/order-cash",
  amendCancel: "/uapi/domestic-stock/v1/trading/order-rvsecncl",
  balance: "/uapi/domestic-stock/v1/trading/inquire-balance",
  buyingPower: "/uapi/domestic-stock/v1/trading/inquire-psbl-order",
  balanceRealizedPnl: "/uapi/domestic-stock/v1/trading/inquire-balance-rlz-pl",
  dailyExecutions: "/uapi/domestic-stock/v1/trading/inquire-daily-ccld",
  amendableOrders: "/uapi/domestic-stock/v1/trading/inquire-psbl-rvsecncl",
} as const;

export const KIS_TR_IDS = {
  live: {
    cashBuy: "TTTC0012U",
    cashSell: "TTTC0011U",
    amendCancel: "TTTC0013U",
    balance: "TTTC8434R",
    buyingPower: "TTTC8908R",
    balanceRealizedPnl: "TTTC8494R",
    dailyExecutions: "TTTC0081R",
    historicalExecutions: "CTSC9215R",
    amendableOrders: "TTTC0084R",
    accountNotice: "H0STCNI0",
  },
  paper: {
    cashBuy: "VTTC0012U",
    cashSell: "VTTC0011U",
    amendCancel: "VTTC0013U",
    balance: "VTTC8434R",
    buyingPower: "VTTC8908R",
    // KIS publishes no separate VTTC code for this endpoint. The same TR ID is
    // used against the selected live/paper base URL and a rejection is treated
    // as a reconciliation failure rather than inventing a profit value.
    balanceRealizedPnl: "TTTC8494R",
    dailyExecutions: "VTTC0081R",
    historicalExecutions: "VTSC9215R",
    amendableOrders: "VTTC0084R",
    accountNotice: "H0STCNI9",
  },
  quote: "FHKST01010100",
  indexPrice: "FHPUP02100000",
  dailyBars: "FHKST03010100",
  multiPrice: "FHKST11300006",
  realtimeTrade: "H0STCNT0",
  holiday: "CTCA0903R",
} as const;

/**
 * Official KIS domestic-stock market selectors. KIS calls the consolidated
 * KRX/NXT route `UN`, while the engine calls the same order/quote route SOR.
 */
export const KIS_QUOTE_MARKET_CODE: Readonly<Record<Exchange, "J" | "NX" | "UN">> = {
  KRX: "J",
  NXT: "NX",
  SOR: "UN",
};

/** Official KIS trade-tick websocket TR IDs for each domestic-stock route. */
export const KIS_REALTIME_TRADE_TR_ID: Readonly<
  Record<Exchange, "H0STCNT0" | "H0NXCNT0" | "H0UNCNT0">
> = {
  KRX: "H0STCNT0",
  NXT: "H0NXCNT0",
  SOR: "H0UNCNT0",
};

export const KIS_KOSPI_MASTER_URL =
  "https://new.real.download.dws.co.kr/common/master/kospi_code.mst.zip";

export const KIS_WS_TOTAL_SUBSCRIPTION_SLOTS = 41;
export const KIS_WS_SAFE_QUOTE_SUBSCRIPTION_SLOTS = 40;
export const KIS_MULTI_QUOTE_BATCH_SIZE = 30;

export type KisWebSocketUnsubscribeTrType = "0" | "2";

// The official examples_user/kis_auth.py unsubscribe() sends "2". Some endpoint
// docstrings say "0", but that value is rejected by the live websocket gateway.
// Retain the explicit compatibility override for environments that require it.
export const DEFAULT_KIS_WS_UNSUBSCRIBE_TR_TYPE: KisWebSocketUnsubscribeTrType =
  "2";

export function defaultRequestsPerSecond(
  environment: TradingEnvironment,
): number {
  return environment === "live" ? 18 : 1;
}
