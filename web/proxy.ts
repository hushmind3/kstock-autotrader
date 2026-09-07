import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";

function equal(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return (
    leftBytes.length === rightBytes.length &&
    timingSafeEqual(leftBytes, rightBytes)
  );
}

export function proxy(request: NextRequest): NextResponse {
  const required = process.env.KSTOCK_REQUIRE_WEB_AUTH === "true";
  if (!required) return NextResponse.next();

  const username = process.env.KSTOCK_WEB_USERNAME?.trim();
  const password = process.env.KSTOCK_WEB_PASSWORD;
  if (!username || !password || password.length < 16) {
    return new NextResponse("Web console authentication is not configured.", {
      status: 503,
    });
  }

  const expected = `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`;
  const provided = request.headers.get("authorization") ?? "";
  if (!equal(expected, provided)) {
    return new NextResponse("Authentication required.", {
      status: 401,
      headers: { "www-authenticate": 'Basic realm="K-Stock Console"' },
    });
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|health).*)"],
};
