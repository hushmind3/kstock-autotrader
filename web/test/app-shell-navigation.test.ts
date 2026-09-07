import { describe, expect, it } from "vitest";

import { activeNavigationHref } from "../components/app-shell";

describe("사이드바 현재 메뉴 판정", () => {
  it("선물·옵션 현황에서는 현황 메뉴만 선택한다", () => {
    expect(activeNavigationHref("/derivatives")).toBe("/derivatives");
  });

  it("선물·옵션 설정에서는 더 구체적인 설정 메뉴만 선택한다", () => {
    expect(activeNavigationHref("/derivatives/settings")).toBe("/derivatives/settings");
    expect(activeNavigationHref("/derivatives/settings/account")).toBe("/derivatives/settings");
  });

  it("홈은 다른 경로의 접두어로 선택되지 않는다", () => {
    expect(activeNavigationHref("/")).toBe("/");
    expect(activeNavigationHref("/positions")).toBe("/positions");
    expect(activeNavigationHref("/unknown")).toBeNull();
  });
});
