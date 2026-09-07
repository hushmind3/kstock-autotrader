import { readFile } from "node:fs/promises";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { findProjectRoot } from "../../../../lib/project-root";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function proxy(request: NextRequest, segments: string[]): Promise<Response> {
  if (segments.some((segment) => segment === ".." || segment.includes("\\"))) {
    return NextResponse.json({ error: "invalid_path" }, { status: 400 });
  }
  const root = await findProjectRoot();
  const dataDirectory = process.env.KSTOCK_DATA_DIR
    ? path.resolve(process.env.KSTOCK_DATA_DIR)
    : path.join(root, "data");
  let adminToken = process.env.KSTOCK_ADMIN_TOKEN?.trim() ?? "";
  if (!adminToken) {
    try {
      adminToken = (await readFile(path.join(dataDirectory, ".admin-token"), "utf8")).trim();
    } catch {
      return NextResponse.json(
        { error: "engine_not_ready", message: "trading-engine을 먼저 실행하세요." },
        { status: 503 },
      );
    }
  }

  const engineOrigin = process.env.ENGINE_URL ?? "http://127.0.0.1:3210";
  const target = new URL(`/api/${segments.map(encodeURIComponent).join("/")}`, engineOrigin);
  target.search = request.nextUrl.search;
  const headers = new Headers({
    accept: request.headers.get("accept") ?? "application/json",
    "x-kstock-admin-token": adminToken,
  });
  const contentType = request.headers.get("content-type");
  if (contentType) headers.set("content-type", contentType);
  const hasBody = !["GET", "HEAD"].includes(request.method);
  const response = await fetch(target, {
    method: request.method,
    headers,
    body: hasBody ? await request.text() : undefined,
    cache: "no-store",
    // A real KIS account check can include token issuance plus paginated balance
    // and open-order queries. Keep the browser proxy alive for that full check.
    signal: AbortSignal.timeout(60_000),
  });
  return new Response(response.body, {
    status: response.status,
    headers: {
      "content-type": response.headers.get("content-type") ?? "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

type RouteContext = { params: Promise<{ path: string[] }> };

export async function GET(request: NextRequest, context: RouteContext): Promise<Response> {
  return proxy(request, (await context.params).path);
}
export async function POST(request: NextRequest, context: RouteContext): Promise<Response> {
  return proxy(request, (await context.params).path);
}
export async function PUT(request: NextRequest, context: RouteContext): Promise<Response> {
  return proxy(request, (await context.params).path);
}
export async function DELETE(request: NextRequest, context: RouteContext): Promise<Response> {
  return proxy(request, (await context.params).path);
}
