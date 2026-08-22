// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { readFileSync } from "node:fs";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { duelPressV2DetailMetricsSchema } from "../api/duelPressV2Contracts";
import { DuelPressV2DetailReadoutBoard } from "./DuelPressV2DetailReadoutBoard";

const readDetail = (name: string) => JSON.parse(readFileSync(`../docs/fixtures/duel_press_v2/${name}.json`, "utf8")).responses.detail;
const parseDetail = (name: string) => duelPressV2DetailMetricsSchema.parse(readDetail(name));

describe("DuelPressV2DetailReadoutBoard", () => {
  afterEach(() => cleanup());

  it("renders the six server-owned sectors and ordered total/per-90 score rows", () => {
    const input = structuredClone(readDetail("complete_league"));
    const pair = input.categories[0].groups[0].metrics[0];
    pair.total.percentileScore = 87;
    pair.per90.percentileScore = 79;
    render(<DuelPressV2DetailReadoutBoard data={duelPressV2DetailMetricsSchema.parse(input)} layout="page"/>);
    expect(screen.getByText("박스 밖 슈팅")).toBeTruthy();
    expect(screen.getByText("박스 안 슈팅")).toBeTruthy();
    expect(screen.getByText("온볼 전개 영향력")).toBeTruthy();
    expect(screen.getByText("통합 경합")).toBeTruthy();
    expect(screen.getByText("오프 더 볼")).toBeTruthy();
    expect(screen.getByText("전방 압박 효율")).toBeTruthy();
    const total = screen.getAllByText("Outside-box shot attempts — Total")[0].parentElement!;
    const per90 = screen.getAllByText("Outside-box shot attempts — /90")[0].parentElement!;
    expect(within(total).getByText("87")).toBeTruthy();
    expect(within(per90).getByText("79")).toBeTruthy();
    expect(screen.getAllByText("99").length).toBeGreaterThanOrEqual(6);
    expect(screen.queryByText("0.2 /90")).toBeNull();
  });

  it("keeps scalar metrics as one row and exposes an unavailable per-90 row for partial pairs", () => {
    render(<DuelPressV2DetailReadoutBoard data={parseDetail("partial_pair")} layout="page"/>);
    expect(screen.getAllByText("Outside-box shot attempts — Total").length).toBeGreaterThan(0);
    const unavailable = screen.getAllByText("Outside-box shot attempts — /90")[0].parentElement!;
    expect(within(unavailable).getByText("—")).toBeTruthy();
    expect(screen.getByText("Ground duel success rate")).toBeTruthy();
    expect(screen.queryByText("Ground duel success rate — Total")).toBeNull();
  });

  it("renders unavailable pairs explicitly instead of synthesizing zero", () => {
    render(<DuelPressV2DetailReadoutBoard data={parseDetail("unavailable")} layout="page"/>);
    const unavailable = screen.getAllByText("Failed dribbles — /90")[0].parentElement!;
    expect(within(unavailable).getByText("—")).toBeTruthy();
  });

  it("preserves an observed zero server score as 0", () => {
    const input = structuredClone(readDetail("observed_zero"));
    const pair = input.categories[0].groups[0].metrics[0];
    pair.total.percentileScore = 0;
    pair.per90.percentileScore = 0;
    const { unmount } = render(<DuelPressV2DetailReadoutBoard data={duelPressV2DetailMetricsSchema.parse(input)} layout="page"/>);
    expect(within(screen.getAllByText("Outside-box shot attempts — Total")[0].parentElement!).getByText("0")).toBeTruthy();
    expect(within(screen.getAllByText("Outside-box shot attempts — /90")[0].parentElement!).getByText("0")).toBeTruthy();
    unmount();
  });

  it("renders xGOT minus xG total then /90 rows directly after xGOT", () => {
    const input = structuredClone(readDetail("complete_league"));
    const delta = structuredClone(input.categories[0].groups[0].metrics[2]);
    delta.id = "outsideBoxXgotMinusXg";
    delta.label = "Outside-box xGOT minus xG";
    delta.total.value = 1.3866;
    delta.total.percentileScore = 98;
    delta.per90.value = 0.0524;
    delta.per90.percentileScore = 98;
    input.categories[0].groups[0].metrics.splice(3, 0, delta);
    render(<DuelPressV2DetailReadoutBoard data={duelPressV2DetailMetricsSchema.parse(input)} layout="page"/>);
    const xgot = screen.getByText("Outside-box xGOT — Total").parentElement!;
    const total = screen.getByText("Outside-box xGOT minus xG — Total").parentElement!;
    const per90 = screen.getByText("Outside-box xGOT minus xG — /90").parentElement!;
    expect(xgot.compareDocumentPosition(total) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(total.compareDocumentPosition(per90) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(total).getByText("98")).toBeTruthy();
    expect(within(per90).getByText("98")).toBeTruthy();
  });

  it("uses scalar comparison rank and median in ground/aerial rate tooltips", async () => {
    render(<DuelPressV2DetailReadoutBoard data={parseDetail("complete_league")} layout="page"/>);
    const trigger = screen.getByRole("button", { name: /Ground duel success rate 상세 정보/ });
    fireEvent.focus(trigger);
    expect(await screen.findByRole("tooltip")).toHaveTextContent("중앙값 66");
    expect(screen.getByRole("tooltip")).toHaveTextContent(/순위:/);
  });
});
