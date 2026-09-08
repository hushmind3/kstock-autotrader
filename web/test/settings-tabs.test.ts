import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/client-api", () => ({
  getJson: vi.fn(),
  koreanErrorMessage: () => "오류",
}));

import { settingsTabFromSearch } from "../components/settings-client";

describe("자동매매 설정 바로가기", () => {
  it("공통 안전 링크는 장세 설정이 있는 탭을 연다", () => {
    expect(settingsTabFromSearch("?tab=common")).toBe("common");
  });

  it("알 수 없는 탭은 키움 현물로 안전하게 돌아간다", () => {
    expect(settingsTabFromSearch("?tab=unknown")).toBe("kiwoom");
  });
});
