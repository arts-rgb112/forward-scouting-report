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
  const scores = [92, 87, 63, 28, 77, 42];
  fixture.categories.forEach((category, categoryIndex) => {
    category.score = scores[categoryIndex];
    category.comparison = { ...category.comparison, percentile: 12.34 };
    category.readouts.forEach((readout, readoutIndex) => {
      readout.comparison = { ...readout.comparison, percentile: 88.75 };
      readout.value = readoutIndex + 1;
    });
  });
  const outside = fixture.categories[0].readouts;
  outside[0].value = 123;
  outside[0].comparison.percentile = 77.9;
  outside[3].value = null;
  outside[3].source = "unavailable";
  outside[3].state = "unavailable";
  outside[3].comparison = { state: "unavailable", median: 0, rank: null, percentile: null, population: 20 };
  outside[3].formulaId = null;
  outside[3].formulaVersion = null;
  fixture.categories[2].readouts.find((item) => item.id === "dribbleMarginPer90")!.value = 1.18;
  fixture.categories[3].readouts.find((item) => item.id === "duelMarginPer90")!.value = -0.31;
  return duelPressDetailReadoutEnvelopeSchema.parse(fixture);
}

describe("approved Figma 7154 detailed stats board", () => {
  it("uses the exact three-column category arrangement and exposes every one of the 32 server readouts once", () => {
    const { container } = render(<DuelPressDetailReadoutBoard data={presentationFixture()}/>);
    const columns = Array.from(container.querySelectorAll("[data-column]"));
    expect(columns).toHaveLength(3);
    expect(columns.map((column) => Array.from(column.querySelectorAll("[data-category-id]")).map((node) => node.getAttribute("data-category-id")))).toEqual([
      ["outsideShot", "dangerZone"],
      ["boxThreat", "spaceControl"],
      ["combinedDuel", "forwardPress"],
    ]);
    expect(container.querySelectorAll("[data-readout-id]")).toHaveLength(32);
    expect(container.querySelectorAll('[data-card="context"]')).toHaveLength(0);
  });

  it("renders the approved header, group language, and disclosure without mockup placeholder numbers", () => {
    render(<DuelPressDetailReadoutBoard data={presentationFixture()}/>);
    expect(screen.getByRole("heading", { level: 2, name: "상세 스탯 보드" })).toBeInTheDocument();
    expect(screen.getByText("원시값 · 코호트 백분위 · 각 축 = 볼륨 50% + 비율 50%")).toBeInTheDocument();
    expect(screen.getAllByRole("heading", { level: 3 }).map((node) => node.textContent)).toEqual(["박스 밖 슈팅", "온볼 전개", "박스 안 슈팅", "공간 점유", "통합 경합", "전방 압박"]);
    expect(screen.getByText(/왼쪽은 원시값, 오른쪽 색상 숫자는 동일 시즌/)).toHaveTextContent("「참고」 항목은 점수 산식에 직접 들어가지 않습니다.");
    const serverRow = screen.getByRole("button", { name: "박스 밖 슈팅 123 77 상세 정보" });
    expect(serverRow).toHaveTextContent("123");
    expect(serverRow).toHaveTextContent("77");
    expect(screen.queryByText("31")).not.toBeInTheDocument();
  });

  it("uses server category score for the title and bar rather than a client recomputation or comparison percentile", () => {
    render(<DuelPressDetailReadoutBoard data={presentationFixture()}/>);
    expect(screen.getByRole("button", { name: "박스 밖 슈팅 카테고리 92 상세 정보" })).toHaveTextContent("92");
    const bar = screen.getByRole("progressbar", { name: "박스 밖 슈팅 점수" });
    expect(bar).toHaveAttribute("aria-valuenow", "92");
    expect(bar.firstElementChild).toHaveStyle({ width: "92%", backgroundColor: "var(--messi-violet, #ab8ffa)" });
    expect(screen.queryByText("12.34")).not.toBeInTheDocument();
  });

  it("matches Figma spacing, typography, panel, bar, and palette tokens", () => {
    const { container } = render(<DuelPressDetailReadoutBoard data={presentationFixture()}/>);
    const board = screen.getByRole("region", { name: "Duel press detailed stats board" });
    expect(board).toHaveClass("rounded-[16px]", "px-6", "py-[22px]", "lg:min-h-[900px]");
    expect(board.getAttribute("style")).toContain("background-color: var(--messi-panel, #101516)");
    expect(board.getAttribute("style")).toContain("border-color: var(--messi-border, #252d2e)");
    expect(container.querySelector('[data-layout="detail-readout-grid"]')).toHaveClass("mt-4", "gap-[18px]", "md:grid-cols-3");
    expect(container.querySelector('[data-column="1"]')).toHaveClass("gap-5");
    const category = container.querySelector('[data-category-id="outsideShot"]')!;
    expect(category).toHaveClass("gap-[7px]");
    expect(within(category as HTMLElement).getByRole("progressbar")).toHaveClass("h-1", "max-w-[288px]", "rounded-[2px]");
    expect(within(category as HTMLElement).getByRole("heading", { level: 3 })).toHaveClass("type-title");
    expect(within(category as HTMLElement).getByRole("heading", { level: 4, name: "참고" })).toHaveStyle({ color: "var(--messi-muted, #949f9f)", opacity: "0.6" });
  });

  it("keeps signed presentation, observed zero, and unavailable distinct", () => {
    const fixture = presentationFixture();
    fixture.categories[2].readouts.find((item) => item.id === "dribbleMarginPer90")!.value = 0;
    render(<DuelPressDetailReadoutBoard data={fixture}/>);
    expect(screen.getByRole("button", { name: "드리블 마진 /90 35% 0 88 상세 정보" })).toHaveTextContent("0");
    expect(screen.getByRole("button", { name: "지상 마진 /90 −0.31 88 상세 정보" })).toHaveTextContent("−0.31");
    expect(screen.getByRole("button", { name: "슈팅 질 (xGOT−xG) — — 상세 정보" })).toHaveTextContent("——");
  });

  it("retains the existing provenance tooltip without changing the visual footprint", () => {
    render(<DuelPressDetailReadoutBoard data={presentationFixture()}/>);
    const trigger = screen.getByRole("button", { name: "박스 밖 슈팅 123 77 상세 정보" });
    fireEvent.focus(trigger);
    const tooltip = screen.getByRole("tooltip");
    expect(tooltip).toHaveTextContent("원본 값: 123 회");
    expect(tooltip).toHaveTextContent("원본 백분위: 77.9");
    expect(tooltip).toHaveTextContent("순위/모집단: 2/20");
    expect(tooltip).toHaveTextContent("출처: 선수 시즌 원자료");
    fireEvent.blur(trigger);
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("keeps the approved desktop geometry for both route layout modes and only collapses for narrow screens", () => {
    const { container } = render(<DuelPressDetailReadoutBoard data={presentationFixture()} layout="rail"/>);
    const board = screen.getByRole("region", { name: "Duel press detailed stats board" });
    expect(board).toHaveAttribute("data-layout-density", "rail");
    expect(container.querySelector('[data-layout="detail-readout-grid"]')).toHaveClass("grid-cols-1", "md:grid-cols-3");
  });

  it("formats only supplied server values for display", () => {
    expect(formatAuthoritativePercentile(99.61)).toBe(99);
    expect(formatAuthoritativePercentile(100)).toBe(99);
    expect(formatAuthoritativePercentile(0)).toBe(0);
    expect(formatAuthoritativePercentile(-4)).toBe(0);
    expect(formatAuthoritativePercentile(null)).toBeNull();
    expect(formatAuthoritativePercentile(Number.NaN)).toBeNull();
  });
});
