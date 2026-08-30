// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { readFileSync } from "node:fs";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { duelPressV2DetailMetricsSchema } from "../api/duelPressV2Contracts";
import { DuelPressV2DetailReadoutBoard } from "./DuelPressV2DetailReadoutBoard";

const readDetail = (name: string) => JSON.parse(readFileSync(`../docs/fixtures/duel_press_v2/${name}.json`, "utf8")).responses.detail;
const parseDetail = (name: string) => duelPressV2DetailMetricsSchema.parse(readDetail(name));
const rows = (container: HTMLElement) => Array.from(container.querySelectorAll("[data-metric-id]"));
function unifiedDetail() {
  const detail = structuredClone(readDetail("complete_league"));
  detail.ratingVersion = "messi-score-unified-v3";
  detail.ratingSnapshotId = "messi-score-unified-v3:0123456789abcdef";
  detail.categories = detail.categories.map((category: { percentileScore: number }) => ({
    ...category,
    formulaId: "pressing-sector-score-v3",
    formulaVersion: "messi-score-unified-v3",
    scoreBreakdown: {
      compositeScore: category.percentileScore,
      volumeScore: category.percentileScore,
      ratioScore: category.percentileScore,
      volumeSample: { attempts: 12, minutes: 1800 },
      ratioSample: { attempts: 12, minutes: 1800 },
      sampleState: "low_sample",
    },
  }));
  return duelPressV2DetailMetricsSchema.parse(detail);
}

describe("DuelPressV2DetailReadoutBoard", () => {
  afterEach(() => cleanup());

  it("shows six category-only summary cards and preserves every server metric in one collapsed detail section", () => {
    const { container } = render(<DuelPressV2DetailReadoutBoard data={parseDetail("complete_league")} layout="page"/>);
    const summary = container.querySelector('[data-detail-level="summary"]') as HTMLElement;
    const expanded = container.querySelector('[data-detail-level="expanded"]') as HTMLDetailsElement;
    expect(within(summary).getAllByRole("article")).toHaveLength(6);
    expect(rows(summary)).toHaveLength(0);
    expect(rows(expanded)).toHaveLength(53);
    expect(expanded.open).toBe(false);
    expect(within(expanded).getByText("박스 밖 슈팅 시도 /90")).toBeInTheDocument();
    expect(within(expanded).getByText("통합 경합 승률")).toBeInTheDocument();
    expect(screen.getAllByText("박스 밖 슈팅").length).toBeGreaterThan(0);
    expect(screen.queryByText("Outside-box shot attempts")).toBeNull();
    const attemptRows = expanded.querySelectorAll('[data-metric-id="outsideBoxShotAttempts"]');
    expect(attemptRows).toHaveLength(2);
    expect(within(attemptRows[0] as HTMLElement).getByText("4")).toBeInTheDocument();
    expect(within(attemptRows[0] as HTMLElement).getByText("99")).toBeInTheDocument();
  });

  it("orders pair totals first, then every /90 value, then percentages and other quality values", () => {
    const { container } = render(<DuelPressV2DetailReadoutBoard data={parseDetail("complete_league")} layout="page"/>);
    const expanded = container.querySelector('[data-detail-level="expanded"]') as HTMLElement;
    const category = expanded.querySelectorAll('article[data-taxonomy="duel-press-v2"]')[2] as HTMLElement;
    const ids = rows(category).map((row) => `${row.getAttribute("data-metric-id")}:${row.getAttribute("data-metric-slot")}`);
    expect(ids).toEqual([
      "dribbleAttempts:total", "successfulDribbles:total", "failedDribbles:total",
      "dribbleAttempts:per90", "successfulDribbles:per90", "failedDribbles:per90", "netProgressionPer90:value",
    ]);
  });

  it("preserves the server's three combined-duel groups and uses Korean group labels", () => {
    render(<DuelPressV2DetailReadoutBoard data={parseDetail("complete_league")} layout="page"/>);
    expect(screen.getAllByRole("heading", { name: "통합 경합" })).toHaveLength(3);
    expect(screen.getAllByRole("heading", { name: "지상 경합" })).toHaveLength(1);
    expect(screen.getAllByRole("heading", { name: "공중 경합" })).toHaveLength(1);
  });

  it("keeps observed zero distinct from unavailable values", () => {
    const observed = structuredClone(readDetail("observed_zero"));
    observed.categories[0].groups[0].metrics[0].total.percentileScore = 0;
    observed.categories[0].groups[0].metrics[0].per90.percentileScore = 0;
    const { container, unmount } = render(<DuelPressV2DetailReadoutBoard data={duelPressV2DetailMetricsSchema.parse(observed)} layout="page"/>);
    const total = container.querySelector('[data-metric-id="outsideBoxShotAttempts"][data-metric-slot="total"]') as HTMLElement;
    expect(within(total).getAllByText("0")).toHaveLength(2);
    unmount();

    const unavailable = render(<DuelPressV2DetailReadoutBoard data={parseDetail("unavailable")} layout="page"/>);
    const missing = unavailable.container.querySelector('[data-metric-id="failedDribbles"][data-metric-slot="per90"]') as HTMLElement;
    expect(within(missing).getAllByText("—")).toHaveLength(2);
  });

  it("keeps median, rank, population and server-derived formula detail in the row tooltip", async () => {
    const input = structuredClone(readDetail("complete_league"));
    const value = input.categories[3].groups[1].metrics[3].value;
    value.state = "server_derived";
    value.source = "server_derived";
    value.formulaId = "wins-divided-by-attempts";
    value.formulaVersion = "v1";
    render(<DuelPressV2DetailReadoutBoard data={duelPressV2DetailMetricsSchema.parse(input)} layout="page"/>);
    const expanded = document.querySelector('[data-detail-level="expanded"]') as HTMLElement;
    const trigger = within(expanded).getByRole("button", { name: /지상 경합 승률 상세 정보/ });
    fireEvent.focus(trigger);
    expect(await screen.findByRole("tooltip")).toHaveTextContent("중앙값");
    expect(screen.getByRole("tooltip")).toHaveTextContent("순위");
    expect(screen.getByRole("tooltip")).toHaveTextContent("서버 산식");
  });

  it("renders the exact server-owned score decomposition on all six category cards", () => {
    const { container } = render(<DuelPressV2DetailReadoutBoard data={unifiedDetail()} layout="page"/>);
    expect(container.querySelectorAll("[data-score-breakdown]")).toHaveLength(12);
    expect(screen.getAllByText(/종합 99\.00/)).toHaveLength(12);
    expect(screen.getAllByText(/볼륨 99\.00/)).toHaveLength(12);
    expect(screen.getAllByText(/비율 99\.00/)).toHaveLength(12);
    expect(screen.getAllByText(/저표본 · 점수 감쇠 없음/)).toHaveLength(12);
  });
});
