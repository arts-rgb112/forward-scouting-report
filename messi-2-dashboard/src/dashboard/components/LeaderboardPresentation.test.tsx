// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import validLeaderboard from "../../../../docs/fixtures/duel_press_v1/valid_leaderboard.json";
import { adaptDuelPressPlayerCore } from "../../api/duelPressAdapter";
import { duelPressLeaderboardCoreSchema } from "../../api/duelPressContracts";
import { DUEL_PRESS_METRIC_KEYS } from "../../api/duelPressTypes";
import { duelPressMetricConfig } from "../duelPressRegistry";
import { LeaderboardPlayerCardList, LeaderboardPlayerTable } from "./LeaderboardPresentation";

const dto = duelPressLeaderboardCoreSchema.parse(validLeaderboard); const player = adaptDuelPressPlayerCore(dto.data[0]);
const dataset = { season: "2025/2026", mode: "league" as const, scope: 8 as const, competition: "all" as const };
const sort = { key: "score", direction: "desc" as const }; const watch = { available: true, isWatched: () => false, onToggle: vi.fn() };
afterEach(cleanup);

describe("main shared leaderboard presentation regression", () => {
  it("preserves the established complete-player table DOM when no adapter options are supplied", () => {
    const { container } = render(<LeaderboardPlayerTable players={[player]} dataset={dataset} metricKeys={DUEL_PRESS_METRIC_KEYS} metricRegistry={duelPressMetricConfig} sort={sort} onMetricSort={vi.fn()} detailHref={() => "/main-detail"} watch={watch} />);
    expect(screen.getAllByRole("columnheader")).toHaveLength(12); expect(container.querySelector("colgroup col:first-child")).toHaveClass("w-[330px]"); expect(container.querySelector("tbody tr")).toHaveClass("h-[72px]"); expect(document.getElementById(`player-${player.id}`)).toBeInTheDocument();
    expect(container.querySelectorAll("thead button")).toHaveLength(7); expect(screen.getByRole("link", { name: player.name })).toHaveAttribute("href", "/main-detail"); expect(screen.getByRole("button", { name: `${player.name} watchlist` })).toHaveTextContent("+"); expect(screen.getByText("Scouting dataset players and six sector scores")).toHaveClass("sr-only");
  });

  it("preserves the established mobile sort, identity, metrics, and Watch action", () => {
    const { container } = render(<LeaderboardPlayerCardList players={[player]} dataset={dataset} metricKeys={DUEL_PRESS_METRIC_KEYS} metricRegistry={duelPressMetricConfig} sort={sort} onMetricSort={vi.fn()} detailHref={() => "/main-detail"} watch={watch} />);
    expect(screen.getByRole("button", { name: "Sort by M.E.S.S.I. score descending" })).toBeInTheDocument(); expect(container.querySelectorAll("article .grid-cols-3 > div")).toHaveLength(6); expect(screen.getByRole("button", { name: `${player.name} watchlist` })).toHaveTextContent("Watch"); expect(container.querySelector("article [id]")).not.toBeInTheDocument();
  });
});
