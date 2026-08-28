// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { duelPressDetailReadoutEnvelopeSchema } from "../api/duelPressDetailReadoutContracts";
import { detailReadoutFixture } from "../test/fixtures/duelPressDetailReadouts";
import { DuelPressDetailReadoutBoard, formatAuthoritativePercentile } from "./DuelPressDetailReadoutBoard";

afterEach(cleanup);

function presentationFixture() {
  const fixture = structuredClone(detailReadoutFixture);
  for (const category of fixture.categories) {
    category.comparison = { ...category.comparison };
    for (const readout of category.readouts) readout.comparison = { ...readout.comparison };
  }
  for (const indicator of fixture.contextIndicators) indicator.comparison = { ...indicator.comparison };
  fixture.categories[0].score = 42.75;
  fixture.categories[0].comparison.percentile = 99.61;
  fixture.categories[0].readouts[0].comparison.percentile = 99.61;
  fixture.categories[0].readouts[1].comparison.percentile = 100;
  fixture.categories[0].readouts[2].comparison.percentile = 0;
  fixture.categories[0].readouts[3].value = null;
  fixture.categories[0].readouts[3].source = "unavailable";
  fixture.categories[0].readouts[3].state = "unavailable";
  fixture.categories[0].readouts[3].comparison = { state: "unavailable", median: 0, rank: null, percentile: null, population: 20 };
  fixture.categories[0].readouts[3].formulaId = null;
  fixture.categories[0].readouts[3].formulaVersion = null;
  fixture.categories[1].scoreState = "imputed";
  fixture.categories[1].imputedComponents = ["inBoxShots"];
  return duelPressDetailReadoutEnvelopeSchema.parse(fixture);
}

describe("duel-press detailed stats board", () => {
  it("keeps exactly six ordered category cards, their combined-duel readouts, and separate context cards", () => {
    const { container } = render(<DuelPressDetailReadoutBoard data={presentationFixture()}/>);
    const section = screen.getByRole("region", { name: "Duel press detailed stats board" });
    expect(within(section).getAllByRole("heading", { level: 3 }).map((node) => node.textContent)).toEqual(["박스 밖 슈팅", "박스 안 슈팅", "온볼 전개", "통합 경합", "공간 점유", "전방 압박", "순수 전진 기여도", "득점 운·상대 선방"]);
    expect(container.querySelectorAll('[data-card="category"]')).toHaveLength(6);
    expect(container.querySelectorAll('[data-card="context"]')).toHaveLength(2);
    expect(within(section).queryByText("AER")).not.toBeInTheDocument();
    expect(within(section).queryByText("GND")).not.toBeInTheDocument();
    expect(within(section).getByRole("region", { name: "지상 경합" })).toHaveTextContent("groundWonPer90");
    expect(within(section).getByRole("region", { name: "공중 경합" })).toHaveTextContent("aerialWonPer90");
  });

  it("defaults to authoritative integer comparison percentiles without raw scores or metadata", () => {
    render(<DuelPressDetailReadoutBoard data={presentationFixture()}/>);
    expect(screen.getByRole("button", { name: "박스 밖 슈팅 카테고리 99 상세 정보" })).toHaveTextContent("99");
    expect(screen.getByRole("button", { name: "outsideBoxShots 99 상세 정보" })).toHaveTextContent("99");
    expect(screen.getByRole("button", { name: "outsideBoxXg 99 상세 정보" })).toHaveTextContent("99");
    expect(screen.getByRole("button", { name: "outsideBoxXgot 0 상세 정보" })).toHaveTextContent("0");
    expect(screen.getByRole("button", { name: "outsideBoxShotQualityGoals 제공 불가 상세 정보" })).toHaveTextContent("제공 불가");
    expect(screen.queryByText("42.75")).not.toBeInTheDocument();
    expect(screen.queryByText("99.61")).not.toBeInTheDocument();
    expect(screen.queryByText("100")).not.toBeInTheDocument();
    expect(screen.queryByText("2/20")).not.toBeInTheDocument();
    expect(screen.queryByText("중앙값: 1")).not.toBeInTheDocument();
    expect(screen.queryByText("서버 산출")).not.toBeInTheDocument();
    expect(screen.queryByText("높을수록 좋음")).not.toBeInTheDocument();
    expect(screen.queryByText("detail-readout-v1")).not.toBeInTheDocument();
  });

  it("formats only supplied percentiles by flooring and clamping, while preserving zero and unavailable", () => {
    expect(formatAuthoritativePercentile(99.61)).toBe(99);
    expect(formatAuthoritativePercentile(100)).toBe(99);
    expect(formatAuthoritativePercentile(0)).toBe(0);
    expect(formatAuthoritativePercentile(-4)).toBe(0);
    expect(formatAuthoritativePercentile(null)).toBeNull();
    expect(formatAuthoritativePercentile(Number.NaN)).toBeNull();
  });

  it("reveals supplied raw, comparison, provenance, and imputation details on hover and keyboard focus", () => {
    render(<DuelPressDetailReadoutBoard data={presentationFixture()}/>);
    const rowTrigger = screen.getByRole("button", { name: "outsideBoxShots 99 상세 정보" });
    expect(rowTrigger).toHaveAccessibleName("outsideBoxShots 99 상세 정보");
    fireEvent.pointerEnter(rowTrigger);
    const hoverTooltip = screen.getByRole("tooltip");
    expect(rowTrigger).toHaveAttribute("aria-describedby", hoverTooltip.id);
    expect(hoverTooltip).toHaveTextContent("원본 값: 0 회");
    expect(hoverTooltip).toHaveTextContent("원본 백분위: 99.61");
    expect(hoverTooltip).toHaveTextContent("중앙값: 1");
    expect(hoverTooltip).toHaveTextContent("순위/모집단: 2/20");
    expect(hoverTooltip).toHaveTextContent("상태: 관측");
    expect(hoverTooltip).toHaveTextContent("출처: 선수 시즌 원자료");
    fireEvent.pointerLeave(rowTrigger);
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();

    const categoryTrigger = screen.getByRole("button", { name: "박스 안 슈팅 카테고리 88 상세 정보" });
    fireEvent.focus(categoryTrigger);
    const focusTooltip = screen.getByRole("tooltip");
    expect(categoryTrigger).toHaveAttribute("aria-describedby", focusTooltip.id);
    expect(focusTooltip).toHaveTextContent("서버 점수: 80");
    expect(focusTooltip).toHaveTextContent("점수 상태: 대체");
    expect(focusTooltip).toHaveTextContent("대체 구성요소: inBoxShots");
    fireEvent.keyDown(categoryTrigger, { key: "Escape" });
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("uses existing legend score tokens for percentile text and bars, with no bespoke gradient", () => {
    const { container } = render(<DuelPressDetailReadoutBoard data={presentationFixture()}/>);
    expect(screen.getByRole("button", { name: "박스 밖 슈팅 카테고리 99 상세 정보" }).firstElementChild).toHaveClass("text-violet-100");
    const bar = screen.getByRole("progressbar", { name: "박스 밖 슈팅 비교 백분위" });
    expect(bar).toHaveAttribute("aria-valuenow", "99");
    expect(bar.firstElementChild).toHaveClass("bg-violet-300");
    expect(container.querySelector('[data-layout="detail-readout-grid"]')?.className).not.toContain("bg-gradient");
    expect(container.querySelector('[data-layout="auxiliary-measurements"]')?.className).not.toContain("rose");
    expect(container.querySelector('[data-layout="auxiliary-measurements"]')?.className).not.toContain("sky");
  });

  it("keeps context values as server core values and comparison bars independent of the six categories", () => {
    render(<DuelPressDetailReadoutBoard data={presentationFixture()}/>);
    expect(screen.getByRole("button", { name: "순수 전진 기여도 2.1 /90 상세 정보" })).toHaveTextContent("2.1 /90");
    expect(screen.getByRole("progressbar", { name: "순수 전진 기여도 비교 백분위" })).toHaveAttribute("aria-valuenow", "88");
    expect(screen.getByRole("button", { name: "득점 운·상대 선방 제공 불가 상세 정보" })).toHaveTextContent("제공 불가");
    expect(screen.queryByRole("progressbar", { name: "득점 운·상대 선방 비교 백분위" })).not.toBeInTheDocument();
    expect(screen.getByText("비교 제공 불가")).toBeInTheDocument();
  });

  it("uses responsive 3/2/1 min-width-safe grid patterns without horizontal clipping", () => {
    const { container } = render(<DuelPressDetailReadoutBoard data={presentationFixture()}/>);
    const categories = container.querySelector('[data-layout="detail-readout-grid"]');
    const contexts = container.querySelector('[data-layout="auxiliary-measurements"]');
    expect(categories).toHaveClass("grid-cols-1", "md:grid-cols-2", "xl:grid-cols-3", "min-w-0");
    expect(contexts).toHaveClass("grid-cols-1", "md:grid-cols-2", "min-w-0");
    expect(categories?.className).not.toContain("overflow-x");
    expect(contexts?.className).not.toContain("overflow-x");
  });

  it("uses a container-safe one/two-column rail layout without viewport xl columns", () => {
    const { container } = render(<DuelPressDetailReadoutBoard data={presentationFixture()} layout="rail"/>);
    const categories = container.querySelector('[data-layout="detail-readout-grid"]');
    const contexts = container.querySelector('[data-layout="auxiliary-measurements"]');
    expect(categories).toHaveClass("grid-cols-1", "sm:grid-cols-2", "min-w-0");
    expect(categories?.className).not.toContain("xl:grid-cols-3");
    expect(contexts).toHaveClass("grid-cols-1", "sm:grid-cols-2", "min-w-0");
    expect(container.querySelectorAll('[data-card="category"]')).toHaveLength(6);
    expect(container.querySelectorAll('[data-card="context"]')).toHaveLength(2);
  });

  it("uses MetricScore badge geometry and shared bands for comparison percentile buttons", () => {
    const { container } = render(<DuelPressDetailReadoutBoard data={presentationFixture()} layout="rail"/>);
    const category = within(container.querySelector('[data-card="category"]')!).getAllByRole("button")[0];
    const row = screen.getByRole("button", { name: /^outsideBoxXgot / });
    expect(category.firstElementChild).toHaveClass("inline-flex", "min-w-10", "rounded-md", "border", "px-2", "font-mono", "text-[13px]", "font-bold", "h-8", "border-violet-300/45");
    expect(row.firstElementChild).toHaveClass("inline-flex", "h-8", "border-orange-300/45", "text-orange-100");
  });

  it("keeps unavailable context core values neutral and opens tooltip by touch click", () => {
    const { container } = render(<DuelPressDetailReadoutBoard data={presentationFixture()} layout="rail"/>);
    const unavailable = within(container.querySelectorAll('[data-card="context"]')[1]).getByRole("button");
    expect(unavailable.firstElementChild).toHaveClass("border-zinc-400/30", "bg-zinc-400/10", "text-zinc-300");
    expect(unavailable.firstElementChild?.className).not.toContain("border-violet");
    const touchTarget = screen.getByRole("button", { name: /^outsideBoxShots / });
    fireEvent.click(touchTarget);
    expect(screen.getByRole("tooltip")).toBeInTheDocument();
    fireEvent.keyDown(touchTarget, { key: "Escape" });
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });
});
