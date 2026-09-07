import type {
  AppSettings,
  BrokerHealth,
  BrokerOrder,
  BrokerPosition,
  BrokerRuntimeSettings,
  OrderSide,
  PlaceOrderRequest,
  Quote,
} from "@kstock/shared";

export interface RiskCheckInput {
  appSettings: AppSettings;
  brokerSettings: BrokerRuntimeSettings;
  health: BrokerHealth;
  side: OrderSide;
  symbol: string;
  quote: Quote;
  positions: BrokerPosition[];
  openOrders: BrokerOrder[];
  dailyInvestedAmount: number;
  dailyTotalPnl: number;
  reservedAmount: number;
  availableCash: number | null;
  instrumentBuyAllowed: boolean;
  instrumentRestrictionCodes: string[];
  marketOpen: boolean;
  now?: Date;
}

export type RiskDecision =
  | { allowed: false; reasonCodes: string[] }
  | {
      allowed: true;
      reasonCodes: string[];
      request: Omit<PlaceOrderRequest, "clientOrderId">;
      reservationAmount: number;
    };

function krxTickSize(price: number): number {
  if (price < 2_000) return 1;
  if (price < 5_000) return 5;
  if (price < 20_000) return 10;
  if (price < 50_000) return 50;
  if (price < 200_000) return 100;
  if (price < 500_000) return 500;
  return 1_000;
}

function alignedLimitPrice(price: number, offsetBps: number, side: OrderSide): number {
  const raw = price * (1 + offsetBps / 10_000);
  const tick = krxTickSize(raw);
  return side === "buy" ? Math.floor(raw / tick) * tick : Math.ceil(raw / tick) * tick;
}

function quoteTradingInstant(quote: Quote): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(quote.tradingDate) || !/^\d{6}$/.test(quote.tradingTime)) {
    return null;
  }
  const hours = Number(quote.tradingTime.slice(0, 2));
  const minutes = Number(quote.tradingTime.slice(2, 4));
  const seconds = Number(quote.tradingTime.slice(4, 6));
  if (hours > 23 || minutes > 59 || seconds > 59) return null;
  const instant = Date.parse(
    `${quote.tradingDate}T${quote.tradingTime.slice(0, 2)}:${quote.tradingTime.slice(2, 4)}:${quote.tradingTime.slice(4, 6)}+09:00`,
  );
  return Number.isFinite(instant) ? instant : null;
}

export class RiskManager {
  check(input: RiskCheckInput): RiskDecision {
    const failures: string[] = [];
    if (input.appSettings.emergencyHalt) failures.push("GLOBAL_EMERGENCY_HALT");
    if (!input.appSettings.globalAutoTradingEnabled) failures.push("GLOBAL_AUTO_TRADING_OFF");
    if (!input.brokerSettings.enabled) failures.push("BROKER_DISABLED");
    if (!input.brokerSettings.autoTradingEnabled) failures.push("BROKER_AUTO_TRADING_OFF");
    if (input.health.state !== "CONNECTED") failures.push("BROKER_NOT_HEALTHY");
    if (!input.marketOpen) failures.push("MARKET_NOT_OPEN");
    if (!input.health.restConnected || !input.health.accountWebSocketConnected) {
      failures.push("ACCOUNT_CHANNEL_NOT_READY");
    }
    if (!input.health.marketWebSocketConnected) {
      failures.push("MARKET_CHANNEL_NOT_READY");
    }

    const now = input.now ?? new Date();
    const quoteAge = now.getTime() - new Date(input.quote.receivedAt).getTime();
    let quoteIsStale =
      input.quote.stale === true ||
      !Number.isFinite(quoteAge) ||
      quoteAge < -5_000 ||
      quoteAge > input.appSettings.staleQuoteMs;
    if (
      input.quote.source === "kiwoom" ||
      input.quote.brokerTimestampVerified === true
    ) {
      const tradingInstant = quoteTradingInstant(input.quote);
      const brokerQuoteAge = tradingInstant === null ? Number.NaN : now.getTime() - tradingInstant;
      quoteIsStale ||=
        !Number.isFinite(brokerQuoteAge) ||
        brokerQuoteAge < -5_000 ||
        brokerQuoteAge > input.appSettings.staleQuoteMs;
    }
    if (quoteIsStale) {
      failures.push("QUOTE_STALE");
    }
    const expectedRoute = input.brokerSettings.environment === "paper"
      ? "KRX"
      : input.brokerSettings.orderRoute;
    // Without a proven venue, a quote is not safe for an order: KRX, NXT and
    // the consolidated SOR feed can carry different executable prices during
    // their non-overlapping sessions.
    if (input.quote.exchange !== expectedRoute) {
      failures.push("QUOTE_ROUTE_MISMATCH");
    }
    if (input.quote.price <= 0) failures.push("INVALID_PRICE");
    if (input.openOrders.some((order) => order.symbol === input.symbol && order.side === input.side)) {
      failures.push("ACTIVE_ORDER_EXISTS");
    }

    const position = input.positions.find((row) => row.symbol === input.symbol);
    if (input.side === "sell") {
      if (!position || position.availableQuantity <= 0) failures.push("NO_SELLABLE_POSITION");
      if (failures.length > 0) return { allowed: false, reasonCodes: failures };
      return {
        allowed: true,
        reasonCodes: ["RISK_REDUCING_SELL"],
        request: {
          symbol: input.symbol,
          side: "sell",
          orderType: input.brokerSettings.orderPolicy.orderType,
          quantity: position?.availableQuantity ?? 0,
          ...(input.brokerSettings.orderPolicy.orderType === "limit"
            ? {
                limitPrice: alignedLimitPrice(
                  input.quote.price,
                  input.brokerSettings.orderPolicy.limitOffsetBps,
                  "sell",
                ),
              }
            : {}),
          exchange:
            input.brokerSettings.environment === "paper"
              ? "KRX"
              : input.brokerSettings.orderRoute,
        },
        reservationAmount: 0,
      };
    }

    if (input.appSettings.newBuysPaused || input.brokerSettings.newBuysPaused) {
      failures.push("NEW_BUYS_PAUSED");
    }
    if (!input.instrumentBuyAllowed) {
      failures.push("INSTRUMENT_RESTRICTED");
      failures.push(...input.instrumentRestrictionCodes.map((code) => `INSTRUMENT_${code}`));
    }
    if (input.dailyTotalPnl <= -input.brokerSettings.orderPolicy.dailyMaxLoss) {
      failures.push("DAILY_LOSS_LIMIT_REACHED");
    }
    const exposureSymbols = new Set(
      input.positions.filter((row) => row.quantity > 0).map((row) => row.symbol),
    );
    for (const order of input.openOrders) {
      if (
        order.side === "buy" &&
        order.remainingQuantity > 0 &&
        order.status !== "FILLED" &&
        order.status !== "CANCELED" &&
        order.status !== "REJECTED"
      ) {
        exposureSymbols.add(order.symbol);
      }
    }
    if (
      !exposureSymbols.has(input.symbol) &&
      exposureSymbols.size >= input.brokerSettings.orderPolicy.maxPositions
    ) {
      failures.push("MAX_POSITIONS_REACHED");
    }

    const buyLimitPrice = input.brokerSettings.orderPolicy.orderType === "limit"
      ? alignedLimitPrice(
          input.quote.price,
          input.brokerSettings.orderPolicy.limitOffsetBps,
          "buy",
        )
      : undefined;
    const sizingPrice = buyLimitPrice ?? input.quote.price;
    const quantity = Math.floor(input.brokerSettings.orderPolicy.perTradeBudget / sizingPrice);
    if (quantity < 1) failures.push("BUDGET_BELOW_ONE_SHARE");
    const estimatedAmount = quantity * sizingPrice;
    const accountExposure = input.positions.reduce((sum, row) => sum + Math.max(0, row.marketValue), 0);
    const symbolExposure = Math.max(0, position?.marketValue ?? 0);
    if (symbolExposure + estimatedAmount > input.brokerSettings.orderPolicy.perSymbolLimit) {
      failures.push("PER_SYMBOL_LIMIT_EXCEEDED");
    }
    if (accountExposure + input.reservedAmount + estimatedAmount > input.brokerSettings.orderPolicy.accountInvestmentLimit) {
      failures.push("ACCOUNT_INVESTMENT_LIMIT_EXCEEDED");
    }
    if (input.dailyInvestedAmount + input.reservedAmount + estimatedAmount > input.brokerSettings.orderPolicy.dailyInvestmentLimit) {
      failures.push("DAILY_INVESTMENT_LIMIT_EXCEEDED");
    }
    if (input.availableCash === null || !Number.isFinite(input.availableCash)) {
      failures.push("BALANCE_SNAPSHOT_MISSING");
    } else if (input.reservedAmount + estimatedAmount > input.availableCash) {
      failures.push("AVAILABLE_CASH_EXCEEDED");
    }
    if (failures.length > 0) return { allowed: false, reasonCodes: failures };

    return {
      allowed: true,
      reasonCodes: ["ALL_RISK_CHECKS_PASSED"],
      request: {
        symbol: input.symbol,
        side: "buy",
        orderType: input.brokerSettings.orderPolicy.orderType,
        quantity,
        ...(buyLimitPrice === undefined ? {} : { limitPrice: buyLimitPrice }),
        exchange:
          input.brokerSettings.environment === "paper"
            ? "KRX"
            : input.brokerSettings.orderRoute,
      },
      reservationAmount: estimatedAmount,
    };
  }
}

export { alignedLimitPrice, krxTickSize };
