import { describe, expect, it } from "vitest";
import {
  createDefaultSettings,
  type BrokerHealth,
  type BrokerOrder,
  type BrokerPosition,
  type Quote,
} from "@kstock/shared";
import { RiskManager } from "../src/core/risk-manager.js";

const connected: BrokerHealth = {
  state: "CONNECTED",
  restConnected: true,
  marketWebSocketConnected: true,
  accountWebSocketConnected: true,
  checkedAt: "2026-08-31T01:00:00.000Z",
};
const quote: Quote = {
  symbol: "005930",
  price: 70_000,
  cumulativeVolume: 1_000_000,
  tradingDate: "2026-08-31",
  tradingTime: "100000",
  receivedAt: "2026-08-31T01:00:00.000Z",
  source: "kiwoom",
  exchange: "KRX",
};

describe("RiskManager", () => {
  it("recycles capital beyond daily turnover limits while retaining loss and cash gates", () => {
    const settings = createDefaultSettings();
    Object.assign(settings, { emergencyHalt: false, globalAutoTradingEnabled: true, newBuysPaused: false });
    const brokerSettings = settings.brokers.kiwoom;
    Object.assign(brokerSettings, { enabled: true, autoTradingEnabled: true, newBuysPaused: false });
    Object.assign(brokerSettings.orderPolicy, { dailyInvestmentLimitEnabled: false, sizeToAvailableBudget: true, estimatedRoundTripCostBps: 30 });
    const input = { appSettings: settings, brokerSettings, health: connected, side: "buy" as const,
      symbol: "005930", quote, positions: [], openOrders: [], dailyInvestedAmount: 1000000000,
      dailyTotalPnl: 0, reservedAmount: 0, availableCash: 1000000, instrumentBuyAllowed: true,
      instrumentRestrictionCodes: [], marketOpen: true, now: new Date("2026-08-31T01:00:01Z") };
    expect(new RiskManager().check(input).allowed).toBe(true);
    expect(new RiskManager().check({ ...input, availableCash: 0 }).allowed).toBe(false);
    expect(new RiskManager().check({ ...input, dailyTotalPnl: -brokerSettings.orderPolicy.dailyMaxLoss }).allowed).toBe(false);
    brokerSettings.orderPolicy.dailyInvestmentLimitEnabled = true;
    expect(new RiskManager().check(input).allowed).toBe(false);
  });
  it("does not allow a real buy merely because cash was deposited", () => {
    const settings = createDefaultSettings();
    const decision = new RiskManager().check({
      appSettings: settings,
      brokerSettings: settings.brokers.kiwoom,
      health: connected,
      side: "buy",
      symbol: "005930",
      quote,
      positions: [],
      openOrders: [],
      dailyInvestedAmount: 0,
      dailyTotalPnl: 0,
      reservedAmount: 0,
      availableCash: 100_000_000,
      instrumentBuyAllowed: true,
      instrumentRestrictionCodes: [],
      marketOpen: true,
      now: new Date("2026-08-31T01:00:01.000Z"),
    });

    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.reasonCodes).toEqual(expect.arrayContaining([
        "GLOBAL_EMERGENCY_HALT",
        "GLOBAL_AUTO_TRADING_OFF",
        "BROKER_DISABLED",
        "BROKER_AUTO_TRADING_OFF",
        "NEW_BUYS_PAUSED",
      ]));
    }
  });

  it("fails closed while the persisted emergency halt is set", () => {
    const settings = createDefaultSettings();
    const decision = new RiskManager().check({
      appSettings: settings,
      brokerSettings: settings.brokers.kiwoom,
      health: connected,
      side: "buy",
      symbol: "005930",
      quote,
      positions: [],
      openOrders: [],
      dailyInvestedAmount: 0,
      dailyTotalPnl: 0,
      reservedAmount: 0,
      availableCash: 1_000_000,
      instrumentBuyAllowed: true,
      instrumentRestrictionCodes: [],
      marketOpen: true,
      now: new Date("2026-08-31T01:00:01.000Z"),
    });
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.reasonCodes).toContain("GLOBAL_EMERGENCY_HALT");
  });

  it("sizes an order only after all gates pass", () => {
    const settings = createDefaultSettings();
    settings.emergencyHalt = false;
    settings.globalAutoTradingEnabled = true;
    settings.newBuysPaused = false;
    settings.brokers.kiwoom.enabled = true;
    settings.brokers.kiwoom.autoTradingEnabled = true;
    settings.brokers.kiwoom.newBuysPaused = false;
    const decision = new RiskManager().check({
      appSettings: settings,
      brokerSettings: settings.brokers.kiwoom,
      health: connected,
      side: "buy",
      symbol: "005930",
      quote,
      positions: [],
      openOrders: [],
      dailyInvestedAmount: 0,
      dailyTotalPnl: 0,
      reservedAmount: 0,
      availableCash: 1_000_000,
      instrumentBuyAllowed: true,
      instrumentRestrictionCodes: [],
      marketOpen: true,
      now: new Date("2026-08-31T01:00:01.000Z"),
    });
    expect(decision.allowed).toBe(true);
    if (decision.allowed) expect(decision.request.quantity).toBe(7);
  });

  it("never sends an order using a quote from a different configured market", () => {
    const settings = createDefaultSettings();
    settings.emergencyHalt = false;
    settings.globalAutoTradingEnabled = true;
    settings.newBuysPaused = false;
    settings.brokers.kiwoom.enabled = true;
    settings.brokers.kiwoom.autoTradingEnabled = true;
    settings.brokers.kiwoom.newBuysPaused = false;
    settings.brokers.kiwoom.environment = "live";
    settings.brokers.kiwoom.orderRoute = "NXT";
    const decision = new RiskManager().check({
      appSettings: settings,
      brokerSettings: settings.brokers.kiwoom,
      health: connected,
      side: "buy",
      symbol: "005930",
      quote: { ...quote, exchange: "KRX" },
      positions: [],
      openOrders: [],
      dailyInvestedAmount: 0,
      dailyTotalPnl: 0,
      reservedAmount: 0,
      availableCash: 1_000_000,
      instrumentBuyAllowed: true,
      instrumentRestrictionCodes: [],
      marketOpen: true,
      now: new Date("2026-08-31T01:00:01.000Z"),
    });

    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.reasonCodes).toContain("QUOTE_ROUTE_MISMATCH");
  });

  it("fails closed when a quote does not identify its executable market", () => {
    const settings = createDefaultSettings();
    settings.emergencyHalt = false;
    settings.globalAutoTradingEnabled = true;
    settings.newBuysPaused = false;
    settings.brokers.kiwoom.enabled = true;
    settings.brokers.kiwoom.autoTradingEnabled = true;
    settings.brokers.kiwoom.newBuysPaused = false;
    const { exchange: _exchange, ...quoteWithoutExchange } = quote;
    const decision = new RiskManager().check({
      appSettings: settings,
      brokerSettings: settings.brokers.kiwoom,
      health: connected,
      side: "buy",
      symbol: quote.symbol,
      quote: quoteWithoutExchange,
      positions: [],
      openOrders: [],
      dailyInvestedAmount: 0,
      dailyTotalPnl: 0,
      reservedAmount: 0,
      availableCash: 1_000_000,
      instrumentBuyAllowed: true,
      instrumentRestrictionCodes: [],
      marketOpen: true,
      now: new Date("2026-08-31T01:00:01.000Z"),
    });

    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.reasonCodes).toContain("QUOTE_ROUTE_MISMATCH");
  });

  it("rejects a Kiwoom quote whose receive time is fresh but broker trade time is stale", () => {
    const settings = createDefaultSettings();
    settings.emergencyHalt = false;
    settings.globalAutoTradingEnabled = true;
    settings.newBuysPaused = false;
    settings.brokers.kiwoom.enabled = true;
    settings.brokers.kiwoom.autoTradingEnabled = true;
    settings.brokers.kiwoom.newBuysPaused = false;
    const decision = new RiskManager().check({
      appSettings: settings,
      brokerSettings: settings.brokers.kiwoom,
      health: connected,
      side: "buy",
      symbol: quote.symbol,
      quote: {
        ...quote,
        tradingTime: "095000",
        receivedAt: "2026-08-31T01:00:00.000Z",
      },
      positions: [],
      openOrders: [],
      dailyInvestedAmount: 0,
      dailyTotalPnl: 0,
      reservedAmount: 0,
      availableCash: 1_000_000,
      instrumentBuyAllowed: true,
      instrumentRestrictionCodes: [],
      marketOpen: true,
      now: new Date("2026-08-31T01:00:01.000Z"),
    });

    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.reasonCodes).toContain("QUOTE_STALE");
  });

  it("rejects a quote explicitly marked stale by the broker parser", () => {
    const settings = createDefaultSettings();
    settings.emergencyHalt = false;
    settings.globalAutoTradingEnabled = true;
    settings.newBuysPaused = false;
    settings.brokers.kiwoom.enabled = true;
    settings.brokers.kiwoom.autoTradingEnabled = true;
    settings.brokers.kiwoom.newBuysPaused = false;
    const decision = new RiskManager().check({
      appSettings: settings,
      brokerSettings: settings.brokers.kiwoom,
      health: connected,
      side: "buy",
      symbol: quote.symbol,
      quote: { ...quote, stale: true },
      positions: [],
      openOrders: [],
      dailyInvestedAmount: 0,
      dailyTotalPnl: 0,
      reservedAmount: 0,
      availableCash: 1_000_000,
      instrumentBuyAllowed: true,
      instrumentRestrictionCodes: [],
      marketOpen: true,
      now: new Date("2026-08-31T01:00:01.000Z"),
    });

    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.reasonCodes).toContain("QUOTE_STALE");
  });

  it("blocks orders when the market-data WebSocket is disconnected", () => {
    const settings = createDefaultSettings();
    settings.emergencyHalt = false;
    settings.globalAutoTradingEnabled = true;
    settings.newBuysPaused = false;
    settings.brokers.kiwoom.enabled = true;
    settings.brokers.kiwoom.autoTradingEnabled = true;
    settings.brokers.kiwoom.newBuysPaused = false;
    const decision = new RiskManager().check({
      appSettings: settings,
      brokerSettings: settings.brokers.kiwoom,
      health: { ...connected, marketWebSocketConnected: false },
      side: "buy",
      symbol: quote.symbol,
      quote,
      positions: [],
      openOrders: [],
      dailyInvestedAmount: 0,
      dailyTotalPnl: 0,
      reservedAmount: 0,
      availableCash: 1_000_000,
      instrumentBuyAllowed: true,
      instrumentRestrictionCodes: [],
      marketOpen: true,
      now: new Date("2026-08-31T01:00:01.000Z"),
    });

    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.reasonCodes).toContain("MARKET_CHANNEL_NOT_READY");
  });

  it("blocks a buy that exceeds the latest actual orderable cash", () => {
    const settings = createDefaultSettings();
    settings.emergencyHalt = false;
    settings.globalAutoTradingEnabled = true;
    settings.newBuysPaused = false;
    settings.brokers.kiwoom.enabled = true;
    settings.brokers.kiwoom.autoTradingEnabled = true;
    settings.brokers.kiwoom.newBuysPaused = false;
    const decision = new RiskManager().check({
      appSettings: settings,
      brokerSettings: settings.brokers.kiwoom,
      health: connected,
      side: "buy",
      symbol: "005930",
      quote,
      positions: [],
      openOrders: [],
      dailyInvestedAmount: 0,
      dailyTotalPnl: 0,
      reservedAmount: 0,
      availableCash: 100_000,
      instrumentBuyAllowed: true,
      instrumentRestrictionCodes: [],
      marketOpen: true,
      now: new Date("2026-08-31T01:00:01.000Z"),
    });
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.reasonCodes).toContain("AVAILABLE_CASH_EXCEEDED");
  });

  it("sizes and reserves a limit buy at the aligned limit price", () => {
    const settings = createDefaultSettings();
    settings.emergencyHalt = false;
    settings.globalAutoTradingEnabled = true;
    settings.newBuysPaused = false;
    settings.brokers.kiwoom.enabled = true;
    settings.brokers.kiwoom.autoTradingEnabled = true;
    settings.brokers.kiwoom.newBuysPaused = false;
    settings.brokers.kiwoom.orderPolicy.orderType = "limit";
    settings.brokers.kiwoom.orderPolicy.limitOffsetBps = 1_000;

    const decision = new RiskManager().check({
      appSettings: settings,
      brokerSettings: settings.brokers.kiwoom,
      health: connected,
      side: "buy",
      symbol: quote.symbol,
      quote,
      positions: [],
      openOrders: [],
      dailyInvestedAmount: 0,
      dailyTotalPnl: 0,
      reservedAmount: 0,
      availableCash: 1_000_000,
      instrumentBuyAllowed: true,
      instrumentRestrictionCodes: [],
      marketOpen: true,
      now: new Date("2026-08-31T01:00:01.000Z"),
    });

    expect(decision.allowed).toBe(true);
    if (decision.allowed) {
      expect(decision.request.limitPrice).toBe(77_000);
      expect(decision.request.quantity).toBe(6);
      expect(decision.reservationAmount).toBe(462_000);
    }
  });

  it("counts distinct pending buy symbols toward the maximum position count", () => {
    const settings = createDefaultSettings();
    settings.emergencyHalt = false;
    settings.globalAutoTradingEnabled = true;
    settings.newBuysPaused = false;
    settings.brokers.kiwoom.enabled = true;
    settings.brokers.kiwoom.autoTradingEnabled = true;
    settings.brokers.kiwoom.newBuysPaused = false;
    settings.brokers.kiwoom.orderPolicy.maxPositions = 2;
    const positions: BrokerPosition[] = [{
      symbol: "005930",
      quantity: 1,
      availableQuantity: 1,
      averagePrice: 70_000,
      currentPrice: 70_000,
      marketValue: 70_000,
      unrealizedPnl: 0,
      unrealizedPnlBps: 0,
    }];
    const openOrders: BrokerOrder[] = [{
      brokerOrderId: "pending-buy",
      symbol: "000660",
      side: "buy",
      orderType: "market",
      orderedQuantity: 1,
      filledQuantity: 0,
      remainingQuantity: 1,
      status: "ACKED",
      orderedAt: "2026-08-31T01:00:00.000Z",
    }];

    const decision = new RiskManager().check({
      appSettings: settings,
      brokerSettings: settings.brokers.kiwoom,
      health: connected,
      side: "buy",
      symbol: "035420",
      quote: { ...quote, symbol: "035420" },
      positions,
      openOrders,
      dailyInvestedAmount: 0,
      dailyTotalPnl: 0,
      reservedAmount: 0,
      availableCash: 1_000_000,
      instrumentBuyAllowed: true,
      instrumentRestrictionCodes: [],
      marketOpen: true,
      now: new Date("2026-08-31T01:00:01.000Z"),
    });

    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.reasonCodes).toContain("MAX_POSITIONS_REACHED");
  });

  it("blocks a buy for a broker-designated risky instrument", () => {
    const settings = createDefaultSettings();
    settings.emergencyHalt = false;
    settings.globalAutoTradingEnabled = true;
    settings.newBuysPaused = false;
    settings.brokers.kiwoom.enabled = true;
    settings.brokers.kiwoom.autoTradingEnabled = true;
    settings.brokers.kiwoom.newBuysPaused = false;

    const decision = new RiskManager().check({
      appSettings: settings,
      brokerSettings: settings.brokers.kiwoom,
      health: connected,
      side: "buy",
      symbol: quote.symbol,
      quote,
      positions: [],
      openOrders: [],
      dailyInvestedAmount: 0,
      dailyTotalPnl: 0,
      reservedAmount: 0,
      availableCash: 1_000_000,
      instrumentBuyAllowed: false,
      instrumentRestrictionCodes: ["MANAGED_ISSUE", "MARKET_WARNING"],
      marketOpen: true,
      now: new Date("2026-08-31T01:00:01.000Z"),
    });

    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.reasonCodes).toEqual(expect.arrayContaining([
        "INSTRUMENT_RESTRICTED",
        "INSTRUMENT_MANAGED_ISSUE",
        "INSTRUMENT_MARKET_WARNING",
      ]));
    }
  });

  it("blocks only new buys while the market-wide trend is weak", () => {
    const settings = createDefaultSettings();
    settings.emergencyHalt = false;
    settings.globalAutoTradingEnabled = true;
    settings.newBuysPaused = false;
    settings.brokers.kiwoom.enabled = true;
    settings.brokers.kiwoom.autoTradingEnabled = true;
    settings.brokers.kiwoom.newBuysPaused = false;
    const base = {
      appSettings: settings,
      brokerSettings: settings.brokers.kiwoom,
      health: connected,
      symbol: quote.symbol,
      quote,
      positions: [] as BrokerPosition[],
      openOrders: [] as BrokerOrder[],
      dailyInvestedAmount: 0,
      dailyTotalPnl: 0,
      reservedAmount: 0,
      availableCash: 1_000_000,
      instrumentBuyAllowed: true,
      instrumentRestrictionCodes: [] as string[],
      marketRegimeBuyAllowed: false,
      marketRegimeReasonCode: "MARKET_REGIME_INTRADAY_BREADTH_WEAK",
      marketOpen: true,
      now: new Date("2026-08-31T01:00:01.000Z"),
    };

    const buy = new RiskManager().check({ ...base, side: "buy" });
    expect(buy.allowed).toBe(false);
    if (!buy.allowed) {
      expect(buy.reasonCodes).toContain("MARKET_REGIME_INTRADAY_BREADTH_WEAK");
    }

    const sell = new RiskManager().check({
      ...base,
      side: "sell",
      positions: [{
        symbol: quote.symbol,
        quantity: 2,
        availableQuantity: 2,
        averagePrice: 60_000,
        currentPrice: quote.price,
        marketValue: quote.price * 2,
        unrealizedPnl: 20_000,
        unrealizedPnlBps: 1_666,
      }],
    });
    expect(sell.allowed).toBe(true);
    if (sell.allowed) expect(sell.request.side).toBe("sell");
  });
});
