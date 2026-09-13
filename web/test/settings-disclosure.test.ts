import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createDefaultSettings } from "@kstock/shared";
vi.mock("@/lib/client-api", () => ({ getJson: vi.fn(), koreanErrorMessage: () => "오류" }));
import { BrokerSettingsPanel, SettingsDetails } from "../components/settings-client";

describe("간단한 설정 화면", () => {
  it("고급 설정을 처음에는 접고, 첫 계좌 등록은 펼칠 수 있다", () => {
    const props = { title: "고급 설정", description: "필요할 때만", children: "세부 항목" };
    expect(renderToStaticMarkup(createElement(SettingsDetails, props))).not.toMatch(/<details[^>]* open/);
    expect(renderToStaticMarkup(createElement(SettingsDetails, { ...props, initiallyOpen: true }))).toMatch(/<details[^>]* open/);
  });
  it("계좌별 매매 설정을 접지 않고 모두 보여주며 렌더링만으로 값을 바꾸지 않는다", () => {
    const settings = createDefaultSettings().brokers.kiwoom;
    const before = JSON.stringify(settings);
    const update = vi.fn();
    const html = renderToStaticMarkup(createElement(BrokerSettingsPanel, {
      id: "kiwoom",
      settings,
      strategies: [],
      scanIntervalMs: 5_000,
      update,
      onPresetFilled: vi.fn(),
    }));
    expect(html.match(/type="number"/g)?.length ?? 0).toBeGreaterThan(10);
    expect(html.match(/<select/g)?.length ?? 0).toBe(4);
    expect(html.match(/type="checkbox"/g)?.length ?? 0).toBeGreaterThan(5);
    expect(html).not.toContain("<details");
    expect(html).toContain("계좌·시장·매매 방식");
    expect(html).toContain("매수 한도와 미체결 주문");
    expect(html).toContain("언제 팔지");
    expect(html).toContain("살 종목을 고르는 기준");
    expect(update).not.toHaveBeenCalled();
    expect(JSON.stringify(settings)).toBe(before);
  });
});
