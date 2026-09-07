import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "../app/api/engine/[...path]/route.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("Next.js engine proxy", () => {
  it("keeps the engine token server-side and forwards the dashboard response", async () => {
    vi.stubEnv("KSTOCK_ADMIN_TOKEN", "test-admin-token-that-is-at-least-32-characters");
    vi.stubEnv("ENGINE_URL", "http://engine.internal:3210");
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ engine: { state: "HALTED" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await GET(
      new NextRequest("http://127.0.0.1:3100/api/engine/dashboard"),
      { params: Promise.resolve({ path: ["dashboard"] }) },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      engine: { state: "HALTED" },
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    const [target, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(target.toString()).toBe("http://engine.internal:3210/api/dashboard");
    expect(new Headers(init.headers).get("x-kstock-admin-token")).toBe(
      "test-admin-token-that-is-at-least-32-characters",
    );
  });
});
