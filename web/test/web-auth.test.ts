import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { proxy } from "../proxy.js";

afterEach(() => vi.unstubAllEnvs());

describe("cloud web console authentication", () => {
  it("rejects an unauthenticated request when cloud auth is required", () => {
    vi.stubEnv("KSTOCK_REQUIRE_WEB_AUTH", "true");
    vi.stubEnv("KSTOCK_WEB_USERNAME", "operator");
    vi.stubEnv("KSTOCK_WEB_PASSWORD", "a-secure-console-password");
    const response = proxy(new NextRequest("https://stocks.example/settings"));
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain("Basic");
  });

  it("accepts the configured credentials without exposing the engine token", () => {
    vi.stubEnv("KSTOCK_REQUIRE_WEB_AUTH", "true");
    vi.stubEnv("KSTOCK_WEB_USERNAME", "operator");
    vi.stubEnv("KSTOCK_WEB_PASSWORD", "a-secure-console-password");
    const authorization = `Basic ${Buffer.from(
      "operator:a-secure-console-password",
    ).toString("base64")}`;
    const response = proxy(
      new NextRequest("https://stocks.example/settings", {
        headers: { authorization },
      }),
    );
    expect(response.status).toBe(200);
  });
});
