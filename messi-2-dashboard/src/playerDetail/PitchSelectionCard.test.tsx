import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PitchSelectionCard, type PitchSelectionCardProps } from "./PitchSelectionCard";

const unknown = { shots: null, goals: null };
const base: PitchSelectionCardProps = {
  kind: "zone", title: "박스 중좌", sourceLabel: "SportsAPI · PK 제외", selectedPart: null,
  parts: { head: unknown, rightFoot: unknown, leftFoot: unknown }, onPartSelect: () => {},
  quality: { delta: null, state: "unavailable" }, shots: null, goals: null, xg: null,
};

describe("one selection-driven anatomical card", () => {
  it("does not replace unknown zone data with player totals or zero", () => {
    const html = renderToStaticMarkup(<PitchSelectionCard {...base} />);
    expect(html).toContain('data-pitch-selection-card="zone"');
    expect(html).toContain('data-selection-quality="unavailable"');
    expect(html).toContain("박스 중좌");
    expect(html).not.toContain("0.00");
    expect(html).toContain("활동 비중");
    expect(html.indexOf("활동 비중")).toBeLessThan(html.indexOf("슈팅 비중"));
  });
  it("renders supplied per-zone quality and body data without changing them", () => {
    const html = renderToStaticMarkup(<PitchSelectionCard {...base} shots={32} goals={7} xg={5.6}
      quality={{ delta: 2.13, state: "partial" }} activitySharePct={4.4} shootingSharePct={29.6}
      parts={{ ...base.parts, leftFoot: { shots: 3, goals: 1, quality: { delta: -0.45, state: "complete" } } }} />);
    expect(html).toContain("+2.13");
    expect(html).toContain("일부 표본");
    expect(html).toContain("-0.45");
    expect(html).toContain("29.6%");
  });
  it("keeps shot selection and aggregate share presentation distinct", () => {
    const html = renderToStaticMarkup(<PitchSelectionCard {...base} kind="shot" title="유효 슛 · 헤더"
      selectedPart="head" controls={<button>재생</button>} details={<p>원본 기록</p>} />);
    expect(html).toContain('data-pitch-selection-card="shot"');
    expect(html).not.toContain("활동 비중");
    expect(html).toContain("재생");
    expect(html).toContain("기록·표본 상세");
    expect(html).toContain('aria-pressed="true"');
  });
});
