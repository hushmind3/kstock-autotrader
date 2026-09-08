import { describe, expect, it } from "vitest";
import { MarketClock } from "../src/core/market-clock.js";
import { didOrderRouteWindowChange } from "../src/core/trading-engine.js";

describe("MarketClock", () => {
  it("recognizes the regular KRX session in Asia/Seoul", () => {
    const session = new MarketClock().current(new Date("2026-08-31T01:00:00.000Z"));
    expect(session.tradingDate).toBe("2026-08-31");
    expect(session.state).toBe("OPEN");
    expect(session.nextTransitionAt).toBe("2026-08-31T06:20:00.000Z");
    expect(session.orderableExchanges).toEqual(["KRX", "NXT", "SOR"]);
  });

  it("fails closed on weekends", () => {
    const session = new MarketClock().current(new Date("2026-09-05T01:00:00.000Z"));
    expect(session.state).toBe("HOLIDAY");
    expect(session.isTradingDay).toBe(false);
  });

  it("uses the persisted official opening-day calendar", () => {
    const clock = new MarketClock();
    clock.applyOfficialCalendar([{ tradingDate: "2026-09-01", isOpen: false }]);
    const session = clock.current(new Date("2026-09-01T01:00:00.000Z"));
    expect(session.state).toBe("HOLIDAY");
    expect(session.isTradingDay).toBe(false);
  });

  it("finds the latest completed session using weekends and the official calendar", () => {
    const clock = new MarketClock();
    clock.applyOfficialCalendar([{ tradingDate: "2026-09-04", isOpen: false }]);
    expect(clock.previousTradingDate("2026-09-07")).toBe("2026-09-03");
  });

  it("lets a KRX broker event close only KRX while NXT remains independent", () => {
    const clock = new MarketClock();
    clock.applyBrokerStatus("CLOSED", "2026-08-31T01:00:00.000Z");
    const session = clock.current(new Date("2026-08-31T01:01:00.000Z"));
    expect(session.state).toBe("OPEN");
    expect(session.orderableExchanges).toEqual(["NXT", "SOR"]);
    expect(session.sessions.find((item) => item.id === "KRX_EQUITY")?.state).toBe("CLOSED");
  });

  it("does not let a stale OPEN event extend the regular session", () => {
    const clock = new MarketClock();
    clock.applyBrokerStatus("OPEN", "2026-08-31T01:00:00.000Z");
    const session = clock.current(new Date("2026-08-31T07:00:00.000Z"));
    expect(session.state).toBe("OPEN");
    expect(session.orderableExchanges).toEqual(["NXT", "SOR"]);
    expect(session.sessions.find((item) => item.id === "KRX_EQUITY")?.state).toBe("AFTER_HOURS");
  });

  it("drops a stale broker transition after its connection is lost", () => {
    const clock = new MarketClock();
    clock.applyBrokerStatus("PREOPEN", "2026-08-31T00:00:00.000Z");
    expect(
      clock.current(new Date("2026-08-31T01:00:00.000Z")).sessions
        .find((item) => item.id === "KRX_EQUITY")?.state,
    ).toBe("PREOPEN");

    clock.clearBrokerStatus();

    expect(
      clock.current(new Date("2026-08-31T01:00:00.000Z")).sessions
        .find((item) => item.id === "KRX_EQUITY")?.state,
    ).toBe("OPEN");
  });

  it("opens NXT pre-market before KRX", () => {
    const session = new MarketClock().current(new Date("2026-08-30T23:10:00.000Z"));
    expect(session.tradingDate).toBe("2026-08-31");
    expect(session.orderableExchanges).toEqual(["NXT", "SOR"]);
    expect(session.sessions.find((item) => item.id === "NXT_EQUITY")).toMatchObject({
      state: "OPEN",
      phase: "PRE_MARKET",
      orderable: true,
    });
  });

  it.each([
    ["2026-08-30T22:59:59.000Z", "CLOSED", false, []],
    ["2026-08-30T23:00:00.000Z", "OPEN", true, ["NXT", "SOR"]],
    ["2026-08-30T23:50:00.000Z", "BREAK", false, []],
    ["2026-08-31T00:00:30.000Z", "OPEN", true, ["KRX", "NXT", "SOR"]],
    ["2026-08-31T06:20:00.000Z", "BREAK", false, ["KRX", "SOR"]],
    ["2026-08-31T06:40:00.000Z", "OPEN", true, ["NXT", "SOR"]],
    ["2026-08-31T11:00:00.000Z", "CLOSED", false, []],
  ] as const)("applies the exact NXT boundary at %s", (instant, state, orderable, routes) => {
    const session = new MarketClock().current(new Date(instant));
    const nxt = session.sessions
      .find((item) => item.id === "NXT_EQUITY");
    expect(nxt).toMatchObject({ state, orderable });
    expect(session.orderableExchanges).toEqual(routes);
  });

  it("blocks both equity routes during the KRX closing auction and NXT break", () => {
    const session = new MarketClock().current(new Date("2026-08-31T06:35:00.000Z"));
    expect(session.orderableExchanges).toEqual([]);
    expect(session.state).toBe("AFTER_HOURS");
    expect(session.sessions.find((item) => item.id === "NXT_EQUITY")?.state).toBe("BREAK");
  });

  it("opens the NXT after-market after its closing break", () => {
    const session = new MarketClock().current(new Date("2026-08-31T07:00:00.000Z"));
    expect(session.orderableExchanges).toEqual(["NXT", "SOR"]);
    expect(session.sessions.find((item) => item.id === "NXT_EQUITY")?.phase).toBe("AFTER_MARKET");
  });

  it("keeps Friday's derivatives night session open after midnight Saturday", () => {
    const session = new MarketClock().current(new Date("2026-09-04T17:00:00.000Z"));
    expect(session.sessions.find((item) => item.id === "KRX_DERIVATIVES_NIGHT")).toMatchObject({
      state: "OPEN",
      tradingDate: "2026-09-04",
      orderable: true,
    });
  });

  it("invalidates only the route whose order window actually changed", () => {
    const clock = new MarketClock();
    const beforeNxtBreak = clock.current(new Date("2026-08-30T23:49:59.000Z"));
    const duringNxtBreak = clock.current(new Date("2026-08-30T23:50:00.000Z"));
    expect(didOrderRouteWindowChange(beforeNxtBreak, duringNxtBreak, "NXT")).toBe(true);
    expect(didOrderRouteWindowChange(beforeNxtBreak, duringNxtBreak, "SOR")).toBe(true);
    expect(didOrderRouteWindowChange(beforeNxtBreak, duringNxtBreak, "KRX")).toBe(false);

    const beforeNxtClose = clock.current(new Date("2026-08-31T06:19:59.000Z"));
    const afterNxtClose = clock.current(new Date("2026-08-31T06:20:00.000Z"));
    expect(didOrderRouteWindowChange(beforeNxtClose, afterNxtClose, "NXT")).toBe(true);
    // SOR remains continuously orderable through KRX, so a KRX/NXT handoff
    // must not erase its valid order-window confirmation.
    expect(didOrderRouteWindowChange(beforeNxtClose, afterNxtClose, "SOR")).toBe(false);
  });
});
