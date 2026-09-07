import { afterEach, describe, expect, it, vi } from "vitest";

import { KiwoomRateLimiter } from "../src/rate-limiter.js";

describe("KiwoomRateLimiter", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("paces a live TR evenly instead of releasing the per-second allowance as a burst", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const limiter = new KiwoomRateLimiter({
      paper: false,
      queryRequestsPerSecond: 5,
      orderRequestsPerSecond: 5,
    });
    const admittedAt: number[] = [];
    const jobs = [0, 1, 2].map(() => limiter.run("query", "ka10095", async () => {
      admittedAt.push(Date.now());
    }));

    await vi.advanceTimersByTimeAsync(0);
    expect(admittedAt).toEqual([10_000]);
    await vi.advanceTimersByTimeAsync(209);
    expect(admittedAt).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(admittedAt).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(210);
    await Promise.all(jobs);
    expect(admittedAt).toEqual([10_000, 10_210, 10_420]);
  });
});
