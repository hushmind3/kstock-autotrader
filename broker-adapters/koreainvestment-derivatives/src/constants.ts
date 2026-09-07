import type { TradingEnvironment } from "@kstock/shared";

export const KIS_DERIVATIVE_PRODUCT_CODE = "03" as const;

export const KIS_DERIVATIVE_PATHS = {
  order: "/uapi/domestic-futureoption/v1/trading/order",
  amendCancel: "/uapi/domestic-futureoption/v1/trading/order-rvsecncl",
  dayBalance: "/uapi/domestic-futureoption/v1/trading/inquire-balance",
  nightBalance: "/uapi/domestic-futureoption/v1/trading/inquire-ngt-balance",
  dayOrders: "/uapi/domestic-futureoption/v1/trading/inquire-ccnl",
  nightOrders: "/uapi/domestic-futureoption/v1/trading/inquire-ngt-ccnl",
  currentPrice: "/uapi/domestic-futureoption/v1/quotations/inquire-price",
  futuresBoard: "/uapi/domestic-futureoption/v1/quotations/display-board-futures",
  dailyChart: "/uapi/domestic-futureoption/v1/quotations/inquire-daily-fuopchartprice",
  orderableQuantity: "/uapi/domestic-futureoption/v1/trading/inquire-psbl-order",
  nightOrderableQuantity: "/uapi/domestic-futureoption/v1/trading/inquire-psbl-ngt-order",
} as const;

export const KIS_DERIVATIVE_TR_IDS = {
  live: {
    dayOrder: "TTTO1101U",
    nightOrder: "STTN1101U",
    dayAmendCancel: "TTTO1103U",
    nightAmendCancel: "TTTN1103U",
    dayBalance: "CTFO6118R",
    nightBalance: "CTFN6118R",
    dayOrders: "TTTO5201R",
    nightOrders: "STTN5201R",
  },
  paper: {
    dayOrder: "VTTO1101U",
    dayAmendCancel: "VTTO1103U",
    dayBalance: "VTFO6118R",
    dayOrders: "VTTO5201R",
  },
  currentPrice: "FHMIF10000000",
  futuresBoard: "FHPIF05030200",
  dailyChart: "FHKIF03020100",
  orderableQuantity: {
    live: "TTTO5105R",
    paper: "VTTO5105R",
  },
  nightOrderableQuantity: "STTN5105R",
  realtime: {
    day: {
      INDEX_FUTURE: "H0IFCNT0",
      INDEX_OPTION: "H0IOCNT0",
      STOCK_FUTURE: "H0ZFCNT0",
      STOCK_OPTION: "H0ZOCNT0",
      COMMODITY_FUTURE: "H0CFCNT0",
    },
    night: {
      INDEX_FUTURE: "H0MFCNT0",
      INDEX_OPTION: "H0EUCNT0",
    },
    notice: {
      day: "H0IFCNI0",
      paperDay: "H0IFCNI9",
      nightFuture: "H0MFCNI0",
      nightOption: "H0EUCNI0",
    },
  },
} as const;

export function derivativeRequestsPerSecond(environment: TradingEnvironment): number {
  return environment === "live" ? 18 : 1;
}

/**
 * Sources (current official KIS Open API examples, accessed 2026-09-05):
 * - examples_user/domestic_futureoption/domestic_futureoption_functions.py
 * - examples_user/domestic_futureoption/domestic_futureoption_functions_ws.py
 * - legacy/websocket/python/ws_domestic_future.py (paper notice TR mapping)
 *
 * KIS documents no night-order TR ID for the paper environment. The adapter
 * therefore rejects paper-night operations before a request is dispatched.
 */
