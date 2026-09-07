import { delay } from "./utils.js";

export type KisRequestKind = "query" | "account" | "order";

/**
 * A single serialized scheduler enforces both KIS's account-wide REST ceiling and
 * the optional per-kind ceilings. Serialization also prevents microbursts that a
 * simple token bucket would allow at a one-second boundary.
 */
export class KisRequestLimiter {
  readonly #globalIntervalMs: number;
  readonly #kindIntervals: Record<KisRequestKind, number>;
  #tail: Promise<void> = Promise.resolve();
  #lastGlobalAt = 0;
  #globalBlockedUntil = 0;
  readonly #lastKindAt: Record<KisRequestKind, number> = {
    query: 0,
    account: 0,
    order: 0,
  };
  readonly #kindBlockedUntil: Record<KisRequestKind, number> = {
    query: 0,
    account: 0,
    order: 0,
  };

  constructor(
    globalRequestsPerSecond: number,
    queryRequestsPerSecond: number,
    orderRequestsPerSecond: number,
    accountRequestsPerSecond = queryRequestsPerSecond,
  ) {
    for (const value of [
      globalRequestsPerSecond,
      queryRequestsPerSecond,
      orderRequestsPerSecond,
      accountRequestsPerSecond,
    ]) {
      if (!Number.isFinite(value) || value <= 0) {
        throw new TypeError("KIS request limits must be positive numbers");
      }
    }
    this.#globalIntervalMs = Math.ceil(1_000 / globalRequestsPerSecond);
    this.#kindIntervals = {
      query: Math.ceil(1_000 / queryRequestsPerSecond),
      account: Math.ceil(1_000 / accountRequestsPerSecond),
      order: Math.ceil(1_000 / orderRequestsPerSecond),
    };
  }

  acquire(kind: KisRequestKind): Promise<void> {
    const run = this.#tail.then(async () => {
      // Recompute after every wait. A broker throttle response can extend the
      // cooldown while this acquisition is already queued.
      while (true) {
        const now = Date.now();
        const earliest = Math.max(
          this.#lastGlobalAt + this.#globalIntervalMs,
          this.#lastKindAt[kind] + this.#kindIntervals[kind],
          this.#globalBlockedUntil,
          this.#kindBlockedUntil[kind],
        );
        if (earliest <= now) break;
        await delay(earliest - now);
      }
      const acquiredAt = Date.now();
      this.#lastGlobalAt = acquiredAt;
      this.#lastKindAt[kind] = acquiredAt;
    });
    this.#tail = run.catch(() => undefined);
    return run;
  }

  /**
   * Extend the next admission after KIS reports a gateway/ledger throttle.
   * Mutations are never replayed here; the cooldown only protects later calls.
   */
  defer(kind: KisRequestKind, milliseconds: number, globally = false): void {
    if (!Number.isFinite(milliseconds) || milliseconds <= 0) return;
    const until = Date.now() + Math.ceil(milliseconds);
    this.#kindBlockedUntil[kind] = Math.max(this.#kindBlockedUntil[kind], until);
    if (globally) this.#globalBlockedUntil = Math.max(this.#globalBlockedUntil, until);
  }
}

export class PacedLimiter {
  readonly #intervalMs: number;
  #tail: Promise<void> = Promise.resolve();
  #lastAt = 0;

  constructor(requestsPerSecond: number) {
    if (!Number.isFinite(requestsPerSecond) || requestsPerSecond <= 0) {
      throw new TypeError("requestsPerSecond must be positive");
    }
    this.#intervalMs = Math.ceil(1_000 / requestsPerSecond);
  }

  acquire(): Promise<void> {
    const run = this.#tail.then(async () => {
      const wait = this.#lastAt + this.#intervalMs - Date.now();
      if (wait > 0) await delay(wait);
      this.#lastAt = Date.now();
    });
    this.#tail = run.catch(() => undefined);
    return run;
  }
}
