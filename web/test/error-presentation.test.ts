import { describe, expect, it } from "vitest";
import type { ErrorRow } from "../lib/api-types.js";
import {
  formatOrderStatus,
  insufficientDailyBars,
  presentError,
} from "../lib/error-presentation.js";

function row(overrides: Partial<ErrorRow>): ErrorRow {
  return {
    id: 1,
    brokerId: "kiwoom",
    severity: "error",
    code: "Error",
    message: "unknown",
    createdAt: "2026-09-03T00:00:00.000Z",
    ...overrides,
  };
}

describe("error presentation", () => {
  it("shows insufficient daily history as a Korean data notice, not an order error", () => {
    const result = presentError(row({
      message: "daily-bars:0234N0: Only 2 completed daily bars are available for 0234N0; 63 required",
    }));

    expect(result).toMatchObject({
      severityClass: "info",
      severityLabel: "자료 부족",
      detailLabel: "주문 실패가 아닙니다",
    });
    expect(result.message).toContain("현재 2일 / 필요 63일");
    expect(result.message).toContain("자동매매 대상에서 잠시 제외");
    expect(result.message).not.toMatch(/Only|completed|required/);
    expect(insufficientDailyBars(row({ message: "unrelated" }))).toBeNull();
  });

  it("explains a malformed Kiwoom bar field in plain Korean", () => {
    const result = presentError(row({
      code: "KiwoomProtocolError",
      message: "daily-bars:082640: Kiwoom response omitted required daily-bar date field.",
    }));

    expect(result).toMatchObject({
      severityClass: "warning",
      severityLabel: "자료 확인",
      detailLabel: "주문 실패가 아닙니다",
    });
    expect(result.message).toContain("과거 시세의 날짜 값");
    expect(result.message).not.toContain("Kiwoom response");
  });

  it("turns a Kiwoom rate-limit backfill row into a retry notice", () => {
    const result = presentError(row({
      code: "BrokerRejectedError",
      message: "daily-bars:474390: 허용된 요청 개수를 초과하였습니다[1700:허용된 API 요청 개수를 초과하였습니다.]",
    }));

    expect(result).toMatchObject({
      severityClass: "warning",
      severityLabel: "잠시 대기",
      detailLabel: "주문 실패가 아닙니다",
    });
    expect(result.message).toContain("다음 자료 갱신 때 다시 확인");
  });

  it("uses plain Korean for persisted order states", () => {
    expect(formatOrderStatus("ACKED")).toBe("주문 접수");
    expect(formatOrderStatus("PARTIALLY_FILLED")).toBe("일부 체결");
    expect(formatOrderStatus("FILLED")).toBe("전량 체결");
    expect(formatOrderStatus("CANCELED")).toBe("취소 완료");
    expect(formatOrderStatus("unexpected-state")).toBe("처리 상태 확인 필요");
  });

  it("keeps an unknown internal error code out of the default label", () => {
    const result = presentError(row({
      code: "UnexpectedVendorError",
      message: "알 수 없는 증권사 응답입니다.",
    }));

    expect(result.detailLabel).toBe("세부 유형 확인");
    expect(result.detailLabel).not.toContain("UnexpectedVendorError");
    expect(result.technicalDetails).toContain("UnexpectedVendorError");
  });
});
