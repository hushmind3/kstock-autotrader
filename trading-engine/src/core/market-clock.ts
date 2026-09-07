import type { Exchange, MarketCalendarDay } from "@kstock/shared";

export type MarketSessionState =
  | "CLOSED"
  | "PREOPEN"
  | "OPEN"
  | "AFTER_HOURS"
  | "HOLIDAY";

export type MarketVenueId =
  | "KRX_EQUITY"
  | "NXT_EQUITY"
  | "KRX_DERIVATIVES_DAY"
  | "KRX_DERIVATIVES_NIGHT";

export type VenueSessionState = MarketSessionState | "BREAK";

export interface MarketVenueSession {
  id: MarketVenueId;
  label: string;
  kind: "equity" | "derivatives";
  state: VenueSessionState;
  /** Stable machine-readable phase; the web app supplies the Korean wording. */
  phase: string;
  orderable: boolean;
  tradingDate: string;
  nextTransitionAt: string;
  checkedAt: string;
}

export interface MarketSession {
  /** Compatibility aggregate. Actual order gates use the venue entries. */
  state: MarketSessionState;
  tradingDate: string;
  isTradingDay: boolean;
  nextTransitionAt: string;
  checkedAt: string;
  orderableExchanges: Exchange[];
  sessions: MarketVenueSession[];
}

interface KoreanParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: string;
}

interface SessionPeriod {
  startSecond: number;
  /** May exceed 86,400 for a session which ends on the next calendar day. */
  endSecond: number;
  state: Exclude<VenueSessionState, "CLOSED" | "HOLIDAY">;
  phase: string;
  orderable: boolean;
}

interface VenueSchedule {
  id: MarketVenueId;
  label: string;
  kind: MarketVenueSession["kind"];
  periods: readonly SessionPeriod[];
}

const SECOND = 1_000;
const DAY_SECONDS = 24 * 60 * 60;

function at(hour: number, minute = 0, second = 0): number {
  return hour * 60 * 60 + minute * 60 + second;
}

/**
 * Current official schedules are data, not branching engine logic. A future
 * effective-dated schedule (including a longer/24-hour market) can replace
 * these records without changing strategy, account or order code.
 */
const CURRENT_SCHEDULES: readonly VenueSchedule[] = [
  {
    id: "KRX_EQUITY",
    label: "KRX 현물",
    kind: "equity",
    periods: [
      { startSecond: at(8, 30), endSecond: at(9), state: "PREOPEN", phase: "OPENING_AUCTION", orderable: false },
      { startSecond: at(9), endSecond: at(15, 30), state: "OPEN", phase: "REGULAR", orderable: true },
      { startSecond: at(15, 30), endSecond: at(18), state: "AFTER_HOURS", phase: "AFTER_HOURS", orderable: false },
    ],
  },
  {
    id: "NXT_EQUITY",
    label: "NXT 현물",
    kind: "equity",
    periods: [
      { startSecond: at(8), endSecond: at(8, 50), state: "OPEN", phase: "PRE_MARKET", orderable: true },
      { startSecond: at(8, 50), endSecond: at(9, 0, 30), state: "BREAK", phase: "OPENING_AUCTION_BREAK", orderable: false },
      { startSecond: at(9, 0, 30), endSecond: at(15, 20), state: "OPEN", phase: "MAIN_MARKET", orderable: true },
      { startSecond: at(15, 20), endSecond: at(15, 40), state: "BREAK", phase: "CLOSING_AUCTION_BREAK", orderable: false },
      { startSecond: at(15, 40), endSecond: at(20), state: "OPEN", phase: "AFTER_MARKET", orderable: true },
    ],
  },
  {
    id: "KRX_DERIVATIVES_DAY",
    label: "코스피200 선물 주간",
    kind: "derivatives",
    periods: [
      { startSecond: at(8, 30), endSecond: at(8, 45), state: "PREOPEN", phase: "OPENING_AUCTION", orderable: false },
      { startSecond: at(8, 45), endSecond: at(15, 45), state: "OPEN", phase: "DAY_SESSION", orderable: true },
    ],
  },
  {
    id: "KRX_DERIVATIVES_NIGHT",
    label: "코스피200 선물 야간",
    kind: "derivatives",
    periods: [
      { startSecond: at(17, 50), endSecond: at(18), state: "PREOPEN", phase: "OPENING_AUCTION", orderable: false },
      { startSecond: at(18), endSecond: DAY_SECONDS + at(6), state: "OPEN", phase: "NIGHT_SESSION", orderable: true },
    ],
  },
] as const;

function koreanParts(now: Date): KoreanParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    weekday: "short",
  }).formatToParts(now);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  return {
    year: Number(value("year")),
    month: Number(value("month")),
    day: Number(value("day")),
    hour: Number(value("hour")),
    minute: Number(value("minute")),
    second: Number(value("second")),
    weekday: value("weekday"),
  };
}

function kstInstant(year: number, month: number, day: number, hour: number, minute: number): Date {
  return new Date(Date.UTC(year, month - 1, day, hour - 9, minute));
}

function ymd(parts: KoreanParts): string {
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

function parseConfiguredHolidays(): Set<string> {
  return new Set(
    (process.env.KSTOCK_MARKET_HOLIDAYS ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter((value) => /^\d{4}-\d{2}-\d{2}$/.test(value)),
  );
}

function plusDays(instant: Date, days: number): Date {
  return new Date(instant.getTime() + days * DAY_SECONDS * SECOND);
}

export class MarketClock {
  readonly #holidays = parseConfiguredHolidays();
  readonly #officialCalendar = new Map<string, boolean>();
  #krxBrokerStatus: {
    state: Exclude<MarketSessionState, "HOLIDAY">;
    tradingDate: string;
    observedAt: string;
  } | null = null;
  #timer: NodeJS.Timeout | null = null;
  #lastState: MarketSessionState | null = null;
  #lastSignature: string | null = null;

  current(now = new Date()): MarketSession {
    const parts = koreanParts(now);
    const tradingDate = ymd(parts);
    let sessions = CURRENT_SCHEDULES.map((schedule) => this.#venueSession(schedule, now));

    const brokerStatus = this.#krxBrokerStatus;
    if (brokerStatus?.tradingDate === tradingDate) {
      sessions = sessions.map((session) => {
        if (session.id !== "KRX_EQUITY") return session;
        // An OPEN message cannot extend configured hours. A non-open official
        // state may always close the KRX route fail-safely.
        if (brokerStatus.state === "OPEN" && !session.orderable) return session;
        return {
          ...session,
          state: brokerStatus.state,
          phase: `BROKER_${brokerStatus.state}`,
          orderable: brokerStatus.state === "OPEN" && session.orderable,
        };
      });
    }

    const krx = sessions.find((session) => session.id === "KRX_EQUITY");
    const nxt = sessions.find((session) => session.id === "NXT_EQUITY");
    const krxOpen = krx?.orderable === true;
    const nxtOpen = nxt?.orderable === true;
    const orderableExchanges: Exchange[] = [
      ...(krxOpen ? (["KRX"] as const) : []),
      ...(nxtOpen ? (["NXT"] as const) : []),
      ...(krxOpen || nxtOpen ? (["SOR"] as const) : []),
    ];
    const tradingDay = this.#isTradingDate(tradingDate);
    let state: MarketSessionState;
    if (krxOpen || nxtOpen) state = "OPEN";
    else if (!tradingDay) state = "HOLIDAY";
    else if (krx?.state === "PREOPEN" || nxt?.state === "PREOPEN") state = "PREOPEN";
    else if (krx?.state === "AFTER_HOURS" || nxt?.state === "AFTER_HOURS") state = "AFTER_HOURS";
    else state = "CLOSED";

    const transitionTimes = sessions
      .map((session) => Date.parse(session.nextTransitionAt))
      .filter((value) => Number.isFinite(value) && value > now.getTime());
    const nextTransition = transitionTimes.length > 0
      ? new Date(Math.min(...transitionTimes))
      : plusDays(now, 1);
    return {
      state,
      tradingDate,
      isTradingDay: tradingDay,
      nextTransitionAt: nextTransition.toISOString(),
      checkedAt: now.toISOString(),
      orderableExchanges,
      sessions,
    };
  }

  applyOfficialCalendar(days: MarketCalendarDay[]): void {
    for (const day of days) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(day.tradingDate)) {
        this.#officialCalendar.set(day.tradingDate, day.isOpen);
      }
    }
  }

  applyBrokerStatus(
    state: Exclude<MarketSessionState, "HOLIDAY">,
    observedAt: string,
  ): void {
    const instant = new Date(observedAt);
    if (!Number.isFinite(instant.getTime())) return;
    this.#krxBrokerStatus = {
      state,
      tradingDate: ymd(koreanParts(instant)),
      observedAt,
    };
    const current = this.current();
    this.#lastState = current.state;
    this.#lastSignature = this.#signature(current);
  }

  clearBrokerStatus(): void {
    this.#krxBrokerStatus = null;
    const current = this.current();
    this.#lastState = current.state;
    this.#lastSignature = this.#signature(current);
  }

  start(onTransition: (current: MarketSession, previous: MarketSessionState | null) => void): void {
    this.stop();
    const tick = () => {
      const current = this.current();
      const signature = this.#signature(current);
      if (signature !== this.#lastSignature) {
        const previous = this.#lastState;
        this.#lastState = current.state;
        this.#lastSignature = signature;
        onTransition(current, previous);
      }
    };
    tick();
    this.#timer = setInterval(tick, 15_000);
    this.#timer.unref?.();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    this.#lastState = null;
    this.#lastSignature = null;
  }

  #signature(session: MarketSession): string {
    return session.sessions
      .map((item) => `${item.id}:${item.state}:${item.orderable ? 1 : 0}`)
      .join("|");
  }

  #isTradingDate(date: string): boolean {
    const parts = koreanParts(new Date(`${date}T12:00:00+09:00`));
    const weekend = parts.weekday === "Sat" || parts.weekday === "Sun";
    return !weekend && !this.#holidays.has(date) && this.#officialCalendar.get(date) !== false;
  }

  #venueSession(schedule: VenueSchedule, now: Date): MarketVenueSession {
    const nowParts = koreanParts(now);
    const todayStart = kstInstant(nowParts.year, nowParts.month, nowParts.day, 0, 0);
    let active: { period: SessionPeriod; baseDate: string; end: Date } | null = null;
    let next: Date | null = null;

    // Yesterday is required for the derivatives night session crossing 00:00.
    for (let dayOffset = -1; dayOffset <= 14; dayOffset += 1) {
      const baseStart = plusDays(todayStart, dayOffset);
      const baseDate = ymd(koreanParts(baseStart));
      if (!this.#isTradingDate(baseDate)) continue;
      for (const period of schedule.periods) {
        const start = new Date(baseStart.getTime() + period.startSecond * SECOND);
        const end = new Date(baseStart.getTime() + period.endSecond * SECOND);
        if (now >= start && now < end) active = { period, baseDate, end };
        if (start > now && (next === null || start < next)) next = start;
        if (end > now && (next === null || end < next)) next = end;
      }
    }

    if (active) {
      return {
        id: schedule.id,
        label: schedule.label,
        kind: schedule.kind,
        state: active.period.state,
        phase: active.period.phase,
        orderable: active.period.orderable,
        tradingDate: active.baseDate,
        nextTransitionAt: active.end.toISOString(),
        checkedAt: now.toISOString(),
      };
    }

    const tradingDay = this.#isTradingDate(ymd(nowParts));
    return {
      id: schedule.id,
      label: schedule.label,
      kind: schedule.kind,
      state: tradingDay ? "CLOSED" : "HOLIDAY",
      phase: "CLOSED",
      orderable: false,
      tradingDate: ymd(nowParts),
      nextTransitionAt: (next ?? plusDays(todayStart, 1)).toISOString(),
      checkedAt: now.toISOString(),
    };
  }
}
