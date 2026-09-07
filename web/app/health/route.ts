import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export function GET(): NextResponse {
  return NextResponse.json({
    ok: true,
    service: "kstock-web",
    instanceId: process.env.KSTOCK_INSTANCE_ID ?? null,
    buildFingerprint: process.env.KSTOCK_BUILD_FINGERPRINT ?? null,
  });
}
