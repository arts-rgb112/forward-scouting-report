// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, it, expect } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { nativeBodyPartEnvelopeSchema } from "../api/nativeBodyPartContracts";
import { BodyPartShootingPanel } from "./BodyPartShootingPanel";
import type { NativeBodyPartStatsState } from "./useNativeBodyPartStats";

// import.meta.url does not resolve to a real filesystem path under jsdom.
const included = nativeBodyPartEnvelopeSchema.parse(JSON.parse(readFileSync(
  resolve(import.meta.dirname, "../../../../messi-specs/fixtures/native-body-parts-kane-2025-2026-quality-v2-included-envelope.json"),
  "utf-8",
)));
const excluded = nativeBodyPartEnvelopeSchema.parse(JSON.parse(readFileSync(
  resolve(import.meta.dirname, "../../../../messi-specs/fixtures/native-body-parts-kane-2025-2026-quality-v2-excluded-envelope.json"),
  "utf-8",
)));
const unavailableQuality = { xg: null, xgot: null, delta: null, eligible: null, state: "unavailable" as const };
const nullParts = () => Object.fromEntries(["head", "leftFoot", "rightFoot", "other", "unknown"].map((part) => [part, { shots: null, goals: null, quality: unavailableQuality }]));
const nullTotals = { admittedShots: null, excludedPenaltyShots: null, excludedPenaltyGoals: null, shots: null, goals: null, quality: unavailableQuality };

const readyState = (data = included): NativeBodyPartStatsState => ({ kind: "ready", key: "k", data });

describe("body-part shooting panel — anatomical figure is the primary interface", () => {
  it("renders a real anatomical figure (not a decorative icon) with head/rightFoot/leftFoot all explicitly unavailable when no data has arrived", () => {
    const { container } = render(<BodyPartShootingPanel hasSelectedShot={false} />);
    const section = screen.getByRole("region", { name: "신체 부위 슈팅 분석" });
    expect(section).toHaveAttribute("data-bodypart-state", "unavailable");
    const figure = container.querySelector('[data-anatomical-shot-figure]')!;
    expect(figure).toBeInTheDocument();
    expect(figure.tagName.toLowerCase()).toBe("svg");
    for (const part of ["head", "rightFoot", "leftFoot"]) {
      const target = figure.querySelector(`[data-shot-part="${part}"]`)!;
      expect(target).toHaveAttribute("aria-label", expect.stringContaining("—"));
      expect(target.getAttribute("aria-label")).not.toMatch(/\b0\b/);
    }
  });

  it("keeps the anatomical right foot on the screen-left side, front view — the exact past mislabelling risk", () => {
    const { container } = render(<BodyPartShootingPanel hasSelectedShot={false} />);
    const rightFootTarget = container.querySelector('[data-shot-part="rightFoot"] rect')!;
    const leftFootTarget = container.querySelector('[data-shot-part="leftFoot"] rect')!;
    expect(Number(rightFootTarget.getAttribute("x"))).toBeLessThan(Number(leftFootTarget.getAttribute("x")));
  });

  it("states plainly that a selected shot's own body part is unknown, right next to the figure — not only in a footer", () => {
    const { container } = render(<BodyPartShootingPanel hasSelectedShot={true} state={readyState()} />);
    const note = container.querySelector("[data-bodypart-attribution-note]")!;
    expect(note).toHaveTextContent("선택한 슛의 신체 부위: 확인 불가");
    expect(note).toHaveTextContent("선수 전체 집계");
  });

  it("does not mention a body-part field that does not exist on the shot data", () => {
    const { container } = render(<BodyPartShootingPanel hasSelectedShot={true} />);
    expect(container.textContent).toContain("불러오지 못했습니다");
  });

  it("anchors real counts directly onto head/rightFoot/leftFoot once the hook is ready", () => {
    const { container } = render(<BodyPartShootingPanel hasSelectedShot={false} state={readyState()} />);
    expect(container.querySelector('[data-bodypart-panel]')).toHaveAttribute("data-bodypart-state", "ready");
    const label = (part: string) => container.querySelector(`[data-shot-part="${part}"]`)!.getAttribute("aria-label");
    expect(label("head")).toContain("15 슛 · 3 득점");
    expect(label("rightFoot")).toContain("84 슛 · 27 득점");
    expect(label("leftFoot")).toContain("20 슛 · 6 득점");
  });

  it("shows each body part's own xGOT−xG quality line with an explicit sign, distinct from its shots/goals line", () => {
    const { container } = render(<BodyPartShootingPanel hasSelectedShot={false} state={readyState()} />);
    const label = (part: string) => container.querySelector(`[data-shot-part="${part}"]`)!.getAttribute("aria-label")!;
    // head: quality +1.4538, eligible 15/15 — fully paired, no "partial" tag
    expect(label("head")).toContain("퀄리티 +1.45");
    expect(label("head")).not.toContain("일부 표본");
    // rightFoot: quality +1.528, eligible 84/84 — fully paired
    expect(label("rightFoot")).toContain("퀄리티 +1.53");
    // leftFoot: quality +1.5335, but only 19/20 shots are paired — must say so
    expect(label("leftFoot")).toContain("퀄리티 +1.53");
    expect(label("leftFoot")).toContain("일부 표본");
  });

  it("puts the '일부 표본' flag on its own independent line instead of glyph-compressing it onto the quality line — a real mobile overflow this replaced", () => {
    const { container } = render(<BodyPartShootingPanel hasSelectedShot={false} state={readyState()} />);
    const leftFootQualityValue = container.querySelector('[data-shot-part="leftFoot"] [data-shot-part-quality]')!;
    // the quality number itself stays full-size and never carries the partial flag inline
    expect(leftFootQualityValue).toHaveTextContent("퀄리티 +1.53");
    expect(leftFootQualityValue).not.toHaveTextContent("일부 표본");
    expect(leftFootQualityValue).not.toHaveAttribute("textLength");
    const leftFootPartialFlag = container.querySelector('[data-shot-part="leftFoot"] [data-shot-part-quality-partial]')!;
    expect(leftFootPartialFlag).toHaveTextContent("일부 표본");
    // a fully-paired part carries no partial-flag line at all
    expect(container.querySelector('[data-shot-part="rightFoot"] [data-shot-part-quality-partial]')).not.toBeInTheDocument();
  });

  it("shows a negative quality delta with an explicit minus sign, and a null/unavailable delta as an honest dash — never a fabricated zero", () => {
    const negative = { ...included, parts: { ...included.parts, head: { ...included.parts.head, quality: { xg: 5, xgot: 3, delta: -2, eligible: 15, state: "complete" as const } } } };
    const { container: withNegative } = render(<BodyPartShootingPanel hasSelectedShot={false} state={readyState(negative)} />);
    expect(withNegative.querySelector('[data-shot-part="head"]')!.getAttribute("aria-label")).toContain("퀄리티 -2.00");

    const unpaired = { ...included, parts: { ...included.parts, head: { ...included.parts.head, quality: { xg: null, xgot: null, delta: null, eligible: 0, state: "unavailable" as const } } } };
    const { container: withUnpaired } = render(<BodyPartShootingPanel hasSelectedShot={false} state={readyState(unpaired)} />);
    expect(withUnpaired.querySelector('[data-shot-part="head"]')!.getAttribute("aria-label")).toContain("퀄리티 —");
  });

  it("selecting a body region marks it as an AGGREGATE selection, never a claim about the selected shot's body part", () => {
    const { container } = render(<BodyPartShootingPanel hasSelectedShot={true} state={readyState()} />);
    fireEvent.click(container.querySelector('[data-shot-part="head"]')!);
    const selected = container.querySelector('[data-bodypart-selected-part]')!;
    expect(selected).toHaveAttribute("data-bodypart-selected-part", "head");
    expect(selected).toHaveTextContent("헤더 집계 선택됨");
    expect(selected).toHaveTextContent("가리키지 않음");
    // toggling the same part again deselects it
    fireEvent.click(container.querySelector('[data-shot-part="head"]')!);
    expect(container.querySelector('[data-bodypart-selected-part]')).not.toBeInTheDocument();
  });

  it("selects a body region via keyboard (Enter), matching pointer selection", () => {
    const { container } = render(<BodyPartShootingPanel hasSelectedShot={false} state={readyState()} />);
    fireEvent.keyDown(container.querySelector('[data-shot-part="rightFoot"]')!, { key: "Enter" });
    expect(container.querySelector('[data-bodypart-selected-part]')).toHaveAttribute("data-bodypart-selected-part", "rightFoot");
  });

  it("keeps other/unknown compact, explicit, and visibly OFF the body — never guessed onto an anatomical location", () => {
    const { container } = render(<BodyPartShootingPanel hasSelectedShot={false} state={readyState()} />);
    expect(container.querySelectorAll("[data-bodypart-region]")).toHaveLength(2);
    expect(container.querySelector('[data-bodypart-region="other"] [data-bodypart-value]')).toHaveTextContent("0슛 · 0골");
    expect(container.querySelector('[data-bodypart-region="unknown"] [data-bodypart-value]')).toHaveTextContent("0슛 · 0골");
    // neither off-body region lives inside the anatomical figure itself
    const figure = container.querySelector('[data-anatomical-shot-figure]')!;
    expect(figure.querySelector('[data-bodypart-region]')).toBeNull();
  });

  it("keeps other and unknown separately quantified when unknown is actually nonzero — never merged into one opaque sum", () => {
    const withUnknown = { ...included, parts: { ...included.parts, other: { shots: 3, goals: 1, quality: { xg: 1, xgot: 1.5, delta: 0.5, eligible: 3, state: "complete" as const } }, unknown: { shots: 5, goals: 2, quality: { xg: 2, xgot: 2.5, delta: 0.5, eligible: 5, state: "complete" as const } } } };
    const { container } = render(<BodyPartShootingPanel hasSelectedShot={false} state={readyState(withUnknown)} />);
    expect(container.querySelector('[data-bodypart-region="other"] [data-bodypart-value]')).toHaveTextContent("3슛 · 1골");
    expect(container.querySelector('[data-bodypart-region="unknown"] [data-bodypart-value]')).toHaveTextContent("5슛 · 2골");
  });

  it("exposes each body part's paired xG/xGOT sums, eligible/shots coverage, and the xGOT−xG definition inside the expanded detail", () => {
    const { container } = render(<BodyPartShootingPanel hasSelectedShot={false} state={readyState()} />);
    const detail = container.querySelector("[data-bodypart-quality-detail]")!;
    expect(detail).toHaveTextContent("xGOT−xG");
    expect(detail.querySelector('[data-bodypart-quality-detail-row="head"]')).toHaveTextContent("xG 2.71 · xGOT 4.16 · eligible 15/15");
    expect(detail.querySelector('[data-bodypart-quality-detail-row="rightFoot"]')).toHaveTextContent("xG 20.10 · xGOT 21.63 · eligible 84/84");
    const leftFootRow = detail.querySelector('[data-bodypart-quality-detail-row="leftFoot"]')!;
    expect(leftFootRow).toHaveTextContent("xG 3.69 · xGOT 5.22 · eligible 19/20");
    expect(leftFootRow).toHaveTextContent("일부 표본");
  });

  it("shows total shots/goals and a compact PK-scope badge up front; other/unknown numbers and source/coverage detail sit behind disclosure", () => {
    const { container } = render(<BodyPartShootingPanel hasSelectedShot={false} state={readyState()} />);
    expect(container.querySelector("[data-bodypart-totals]")).toHaveTextContent("합계 119슛 · 36골");
    expect(container).toHaveTextContent("PK 포함");
    const disclosure = container.querySelector("details")!;
    expect(disclosure).toBeInTheDocument();
    expect(disclosure.querySelector("summary")).toHaveTextContent("출처");
    expect(disclosure).toHaveTextContent("SportsAPI");
    expect(disclosure).toHaveTextContent("2025/2026");
    expect(disclosure).toHaveTextContent("리그 8개");
    // other+unknown are both 0 in this fixture, so the always-visible badge must not appear
    expect(container.querySelector("[data-bodypart-offbody-badge]")).not.toBeInTheDocument();
    // but the numeric breakdown still exists, just inside the disclosure, not an always-open card
    expect(disclosure.querySelector('[data-bodypart-region="other"]')).toBeInTheDocument();
    expect(disclosure.querySelector('[data-bodypart-region="unknown"]')).toBeInTheDocument();
  });

  it("surfaces a compact always-visible badge when other/unknown is genuinely nonzero — uncertainty is never silently hidden behind the disclosure", () => {
    const withUnknown = { ...included, parts: { ...included.parts, other: { shots: 3, goals: 1, quality: { xg: 1, xgot: 1.5, delta: 0.5, eligible: 3, state: "complete" as const } }, unknown: { shots: 5, goals: 2, quality: { xg: 2, xgot: 2.5, delta: 0.5, eligible: 5, state: "complete" as const } } } };
    const { container } = render(<BodyPartShootingPanel hasSelectedShot={false} state={readyState(withUnknown)} />);
    const badge = container.querySelector("[data-bodypart-offbody-badge]");
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveTextContent("기타·미상 8건"); // 3+5, always visible without opening the disclosure
  });

  it("shows PK excluded scope and the excluded-fixture totals when the shared penalty toggle is off", () => {
    const { container } = render(<BodyPartShootingPanel hasSelectedShot={false} state={readyState(excluded)} />);
    expect(container).toHaveTextContent("PK 제외");
    expect(container.querySelector("[data-bodypart-totals]")).toHaveTextContent("합계 108슛 · 26골");
    const label = container.querySelector('[data-shot-part="rightFoot"]')!.getAttribute("aria-label");
    expect(label).toContain("73 슛 · 17 득점");
  });

  it("never lets a partial-coverage subtotal read as complete, and exposes each source's real competition label + coverage counts", () => {
    const baseSource = included.sources[0];
    const partialSource = {
      ...baseSource,
      coverage: {
        ...baseSource.coverage,
        state: "partial" as const,
        validMatchIds: baseSource.coverage.validMatchIds.slice(0, -5),
        missingMatchIds: [...baseSource.coverage.missingMatchIds, ...baseSource.coverage.validMatchIds.slice(-5)].sort((a, b) => a - b),
      },
    };
    const partial = { ...included, completeness: "partial" as const, sources: [partialSource] };
    const { container } = render(<BodyPartShootingPanel hasSelectedShot={false} state={readyState(partial)} />);
    expect(container.querySelector("[data-bodypart-totals]")).toHaveTextContent("일부 소스만 관측");
    // the source-completeness partial flag is a short always-visible badge, distinct from a part's own "일부 표본" quality tag
    expect(container.querySelector("[data-bodypart-source-partial-badge]")).toHaveTextContent("부분 자료");
    const coverage = container.querySelector("[data-bodypart-source-coverage]")!;
    expect(coverage).toHaveTextContent(baseSource.competition); // "Bundesliga" — not a generic label
    expect(coverage).toHaveTextContent(`유효 ${partialSource.coverage.validMatchIds.length}/${partialSource.coverage.expectedMatchIds.length}`);
    expect(coverage).toHaveTextContent(`누락 ${partialSource.coverage.missingMatchIds.length}`);
  });

  it("treats a genuinely-unavailable 200 envelope with NO mapped source as its own distinct reason — never a network error and never a ready panel printing literal nulls", () => {
    const unavailable = {
      ...included,
      completeness: "unavailable" as const,
      sources: [],
      totals: nullTotals,
      parts: nullParts(),
    };
    const { container } = render(<BodyPartShootingPanel hasSelectedShot={false} state={readyState(unavailable)} />);
    expect(container.querySelector("[data-bodypart-panel]")).toHaveAttribute("data-bodypart-state", "unavailable");
    expect(container.textContent).not.toContain("null");
    expect(container.querySelector("[data-bodypart-totals]")).not.toBeInTheDocument();
    expect(container.querySelector("[data-bodypart-unavailable-reason]")).toHaveAttribute("data-bodypart-unavailable-reason", "source-unavailable");
    expect(container.textContent).toContain("매핑된 신체 부위 소스가 없습니다");
    expect(container.textContent).not.toContain("불러오지 못했습니다"); // this is not the same thing as a real fetch failure
  });

  it("distinguishes a genuinely-unavailable 200 envelope that DOES have sources (each individually unavailable) from the no-mapped-source case, listing them", () => {
    const unavailableWithSource = {
      ...included,
      completeness: "unavailable" as const,
      sources: [{
        ...included.sources[0],
        coverage: { state: "unavailable" as const, expectedMatchIds: [], validMatchIds: [], missingMatchIds: [], invalidMatchIds: [], invalidReasons: {} },
        totals: nullTotals,
        parts: nullParts(),
      }],
      totals: nullTotals,
      parts: nullParts(),
    };
    const { container } = render(<BodyPartShootingPanel hasSelectedShot={false} state={readyState(unavailableWithSource)} />);
    expect(container.querySelector("[data-bodypart-unavailable-reason]")).toHaveAttribute("data-bodypart-unavailable-reason", "source-unavailable");
    expect(container.textContent).toContain(included.sources[0].competition);
    expect(container.textContent).toContain("관측 불가");
    expect(container.textContent).not.toContain("매핑된 신체 부위 소스가 없습니다"); // a real (if currently unavailable) source exists — this is not "no mapped source"
  });

  it("shows a distinct loading message, never the same text as a network-error or source-unavailable state", () => {
    const { container } = render(<BodyPartShootingPanel hasSelectedShot={false} state={{ kind: "loading", key: "k" }} />);
    expect(container.querySelector("[data-bodypart-unavailable-reason]")).toHaveAttribute("data-bodypart-unavailable-reason", "loading");
    expect(container.textContent).toContain("불러오는 중");
    expect(container.textContent).not.toContain("불러오지 못했습니다");
  });

  it("shows the network/route-not-activated message for a real fetch error, distinct from loading and source-unavailable", () => {
    const { container } = render(<BodyPartShootingPanel hasSelectedShot={false} state={{ kind: "error", key: "k" }} />);
    expect(container.querySelector("[data-bodypart-unavailable-reason]")).toHaveAttribute("data-bodypart-unavailable-reason", "error");
    expect(container.textContent).toContain("불러오지 못했습니다");
    expect(container.textContent).not.toContain("불러오는 중");
    expect(container.textContent).not.toContain("매핑된 신체 부위 소스가 없습니다");
  });

  it("stays unavailable while the native-body-part hook is still loading or errored, never a fabricated zero on the figure itself", () => {
    const loading: NativeBodyPartStatsState = { kind: "loading", key: "k" };
    const { container } = render(<BodyPartShootingPanel hasSelectedShot={false} state={loading} />);
    const label = container.querySelector('[data-shot-part="head"]')!.getAttribute("aria-label");
    expect(label).toContain("—");
    expect(label).not.toMatch(/\b0\b/);
  });
});
