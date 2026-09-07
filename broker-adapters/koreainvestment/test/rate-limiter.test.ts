import { afterEach, describe, expect, it, vi } from "vitest";

import { KisRequestLimiter } from "../src/rate-limiter.js";

describe("KisRequestLimiter", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("extends an already queued account wait when the broker reports a throttle", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const limiter = new KisRequestLimiter(1_000, 1_000, 1_000, 1);

    await limiter.acquire("account");
    let admitted = false;
    const queued = limiter.acquire("account").then(() => {
      admitted = true;
    });
    await vi.advanceTimersByTimeAsync(100);
    limiter.defer("account", 3_000);

    await vi.advanceTimersByTimeAsync(2_999);
    expect(admitted).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    await queued;
    expect(admitted).toBe(true);
  });
});
