import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createDefaultSettings } from "@kstock/shared";
vi.mock("@/lib/client-api", () => ({ getJson: vi.fn(), koreanErrorMessage: () => "오류" }));
import { SettingsDetails, SimpleBrokerSettingsPanel } from "../components/settings-client";

describe("간단한 설정 화면", () => {
  it("고급 설정을 처음에는 접고, 첫 계좌 등록은 펼칠 수 있다", () => {
    const props = { title: "고급 설정", description: "필요할 때만", children: "세부 항목" };
    expect(renderToStaticMarkup(createElement(SettingsDetails, props))).not.toMatch(/<details[^>]* open/);
    expect(renderToStaticMarkup(createElement(SettingsDetails, { ...props, initiallyOpen: true }))).toMatch(/<details[^>]* open/);
  });
  it("기본 화면에는 금액 입력 세 개만 남기고 펼치기만으로 설정을 변경하지 않는다", () => {
    const settings = createDefaultSettings().brokers.kiwoom;
    const before = JSON.stringify(settings);
    const update = vi.fn();
    const html = renderToStaticMarkup(createElement(SimpleBrokerSettingsPanel, { id: "kiwoom", settings, update }));
    expect(html.match(/type="number"/g)).toHaveLength(3);
    expect(html).not.toContain("<select");
    expect(html).not.toContain("type=\"checkbox\"");
    expect(html).not.toContain("<details");
    expect(html).toContain("종목 찾기");
    expect(html).toContain("다시 종목 찾기");
    expect(html).not.toContain("0.2%");
    expect(update).not.toHaveBeenCalled();
    expect(JSON.stringify(settings)).toBe(before);
  });
});
