import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/client-api", () => ({
  formatDateTime: () => "",
  getJson: vi.fn(),
}));

import {
  buildDerivativesCredentialPayload,
  derivativesConnectionLabel,
} from "../components/derivatives-client";

describe("선물 계좌 입력 화면", () => {
  it("현물 API 키를 재사용해도 체결 알림용 로그인 ID는 함께 보낸다", () => {
    expect(buildDerivativesCredentialPayload({
      reuseCashCredentials: true,
      accountId: " 12345678 ",
      appKey: "must-not-leak",
      appSecret: "must-not-leak",
      htsId: " hts-id ",
    })).toEqual({
      reuseCashCredentials: true,
      accountId: "12345678",
      accountProductCode: "03",
      htsId: "hts-id",
    });
  });

  it("선물용 API 정보를 따로 쓸 때 입력값과 고정 상품번호 03을 보낸다", () => {
    expect(buildDerivativesCredentialPayload({
      reuseCashCredentials: false,
      accountId: "87654321",
      appKey: " app-key ",
      appSecret: " app-secret ",
      htsId: " hts-id ",
    })).toEqual({
      reuseCashCredentials: false,
      accountId: "87654321",
      accountProductCode: "03",
      appKey: "app-key",
      appSecret: "app-secret",
      htsId: "hts-id",
    });
  });

  it("저장과 실제 계좌 확인 상태를 쉬운 한국어로 구분한다", () => {
    expect(derivativesConnectionLabel("NOT_CHECKED", false, false)).toBe("저장됨 · 연결 확인 전");
    expect(derivativesConnectionLabel("VERIFYING", false, false)).toBe("로그인·선물 계좌 확인 중");
    expect(derivativesConnectionLabel("VERIFIED", true, false)).toBe("로그인 완료 · 계좌 확인 대기");
    expect(derivativesConnectionLabel("VERIFIED", true, true)).toBe("실제 선물 계좌 조회 확인 완료");
    expect(derivativesConnectionLabel("FAILED", false, false)).toBe("API 로그인 확인 필요");
    expect(derivativesConnectionLabel("FAILED", true, false)).toBe("API 로그인 완료 · 선물계좌 연결 필요");
  });
});
