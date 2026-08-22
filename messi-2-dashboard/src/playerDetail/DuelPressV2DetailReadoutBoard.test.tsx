// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { duelPressV2DetailMetricsSchema } from "../api/duelPressV2Contracts";
import { DuelPressV2DetailReadoutBoard } from "./DuelPressV2DetailReadoutBoard";

const fixture = JSON.parse(readFileSync("../docs/fixtures/duel_press_v2/complete_league.json", "utf8")).responses.detail;

describe("DuelPressV2DetailReadoutBoard", () => {
  it("renders the six server-owned sectors and score-only headline values", () => {
    render(<DuelPressV2DetailReadoutBoard data={duelPressV2DetailMetricsSchema.parse(fixture)} layout="page"/>);
    expect(screen.getByText("박스 밖 슈팅")).toBeTruthy();
    expect(screen.getByText("박스 안 슈팅")).toBeTruthy();
    expect(screen.getByText("온볼 전개 영향력")).toBeTruthy();
    expect(screen.getByText("통합 경합")).toBeTruthy();
    expect(screen.getByText("오프 더 볼")).toBeTruthy();
    expect(screen.getByText("전방 압박 효율")).toBeTruthy();
    expect(screen.getAllByText("99").length).toBeGreaterThanOrEqual(6);
    expect(screen.queryByText("0.2 /90")).toBeNull();
  });
});
