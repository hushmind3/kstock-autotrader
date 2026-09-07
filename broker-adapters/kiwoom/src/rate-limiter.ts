// Kiwoom enforces its documented per-second ceiling at the gateway. A small
// boundary margin avoids a request admitted at exactly 1,000 ms being counted
// in both of the broker's adjacent windows because of network/clock jitter.
const RATE_WINDOW_MS = 1_050;

/**
 * Evenly paced limiter. Kiwoom publishes a per-second count, but admitting the
 * whole allowance as one burst can still trip an individual TR's flow gate.
 */
class PacedLimiter {
  private readonly intervalMs: number;
  private tail: Promise<void> = Promise.resolve();
  private lastAt = 0;
  private blockedUntil = 0;

  constructor(private readonly requestsPerSecond: number) {
    if (!Number.isFinite(requestsPerSecond) || requestsPerSecond <= 0) {
      throw new RangeError("requestsPerSecond must be greater than zero");
    }
    this.intervalMs = Math.ceil(RATE_WINDOW_MS / requestsPerSecond);
  }

  acquire(): Promise<void> {
    const run = this.tail.then(async () => {
      while (true) {
        const waitMs = Math.max(
          this.lastAt + this.intervalMs,
          this.blockedUntil,
        ) - Date.now();
        if (waitMs <= 0) break;
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, waitMs);
          timer.unref?.();
        });
      }
      this.lastAt = Date.now();
    });
    this.tail = run.catch(() => undefined);
    return run;
  }

  defer(milliseconds: number): void {
    if (!Number.isFinite(milliseconds) || milliseconds <= 0) return;
    this.blockedUntil = Math.max(
      this.blockedUntil,
      Date.now() + Math.ceil(milliseconds),
    );
  }
}

export type KiwoomRequestKind = "query" | "order";

export interface KiwoomRateLimiterOptions {
  paper: boolean;
  queryRequestsPerSecond: number;
  orderRequestsPerSecond: number;
}

export class KiwoomRateLimiter {
  private readonly liveQuery: PacedLimiter;
  private readonly liveOrder: PacedLimiter;
  private readonly paperByTr = new Map<string, PacedLimiter>();

  constructor(private readonly options: KiwoomRateLimiterOptions) {
    this.liveQuery = new PacedLimiter(options.queryRequestsPerSecond);
    this.liveOrder = new PacedLimiter(options.orderRequestsPerSecond);
  }

  async run<T>(kind: KiwoomRequestKind, apiId: string, task: () => Promise<T>): Promise<T> {
    if (this.options.paper) {
      let limiter = this.paperByTr.get(apiId);
      if (limiter === undefined) {
        // Official paper limit: one request per second for each TR and token/account.
        limiter = new PacedLimiter(1);
        this.paperByTr.set(apiId, limiter);
      }
      await limiter.acquire();
    } else {
      await (kind === "order" ? this.liveOrder : this.liveQuery).acquire();
    }
    return task();
  }

  defer(kind: KiwoomRequestKind, apiId: string, milliseconds: number): void {
    if (this.options.paper) {
      let limiter = this.paperByTr.get(apiId);
      if (limiter === undefined) {
        limiter = new PacedLimiter(1);
        this.paperByTr.set(apiId, limiter);
      }
      limiter.defer(milliseconds);
      return;
    }
    (kind === "order" ? this.liveOrder : this.liveQuery).defer(milliseconds);
  }
}
