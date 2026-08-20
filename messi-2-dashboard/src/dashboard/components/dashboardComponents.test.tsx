// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import MessiScoutingDashboard from "../MessiScoutingDashboard";
import { sampleMeta, samplePlayers } from "../../test/fixtures/players";
import { AssetImage } from "./AssetImage";
import { DashboardLoading } from "./DashboardLoading";
import { DashboardErrorBoundary } from "./DashboardErrorBoundary";
import { DashboardToolbar } from "./DashboardToolbar";
import { DatasetHeader } from "./DatasetHeader";
import { PlayerCardList } from "./PlayerCardList";
import { PlayerTable } from "./PlayerTable";
import { ScoreLegend } from "./ScoreLegend";
import { WatchlistTable } from "./WatchlistTable";
import { WatchlistCardList } from "./WatchlistCardList";
import { metricConfig } from "../scoutingConfig";
import { duelPressDetailHref } from "../duelPressRoute";
import type { LeaderboardOptions } from "../types";
import { entryFromPlayer } from "../watchlistStorage";
import { watchlistRows } from "../watchlistViewModel";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("asset nullability", () => {
  it("uses initials without making a network image", () => {
    render(<AssetImage src={null} alt="Erling portrait" kind="face" fallbackLabel="Erling Haaland" width={48} height={48} />);
    expect(screen.getByRole("img", { name: "Erling portrait" })).toHaveTextContent("EH");
  });
});

describe("dashboard contract UI", () => {
  it("shows only six ability score ranges in the legend", () => {
    render(<ScoreLegend />);
    const legend = screen.getByLabelText("Ability score legend");
    expect(legend).toHaveTextContent("90–100");
    expect(screen.getAllByLabelText(/Ability score range/)).toHaveLength(6);
    expect(screen.queryByText("Diamond")).not.toBeInTheDocument();
    expect(screen.queryByText("Iron")).not.toBeInTheDocument();
    expect(legend).not.toHaveTextContent("Legacy tier taxonomy");
  });

  it("shows legacy taxonomy state once for a mixed leaderboard response, but never in the score legend", () => {
    const crystalPlayer = { ...samplePlayers[1], tier: { code: "diamond", label: "Diamond", level: 2, taxonomyVersion: "crystal-v2" } };
    const view = render(<MessiScoutingDashboard players={[samplePlayers[0], crystalPlayer]} meta={sampleMeta} refreshing={false} onRefresh={vi.fn()} />);
    expect(screen.getByLabelText("Leaderboard tier taxonomy status")).toHaveAttribute("title", expect.stringContaining("previous overall M.E.S.S.I. tier taxonomy"));
    expect(screen.getByLabelText("Ability score legend")).not.toHaveTextContent("Legacy tier taxonomy");

    view.rerender(<MessiScoutingDashboard players={[crystalPlayer]} meta={sampleMeta} refreshing={false} onRefresh={vi.fn()} />);
    expect(screen.queryByLabelText("Leaderboard tier taxonomy status")).not.toBeInTheDocument();
  });

  it("gives the Watchlist tier column enough desktop width for full legacy labels", () => {
    const legacyPlatinum = { ...samplePlayers[1], tier: { code: "platinum", label: "Platinum I", level: 1 } };
    const rows = watchlistRows([entryFromPlayer(legacyPlatinum, { season: sampleMeta.season, mode: "league", scope: 7, competition: null })], {});
    const { container } = render(<WatchlistTable rows={rows} sort={{ key: "score", direction: "desc" }} onMetricSort={vi.fn()} onRemove={vi.fn()} onRetry={vi.fn()} />);
    expect(container.querySelector("colgroup col:nth-child(2)")).toHaveClass("w-40");
    expect(screen.getByLabelText("Overall M.E.S.S.I. tier: Legacy Platinum, level 1")).toHaveTextContent("Legacy Platinum");
  });
  it("preserves Watchlist sort affordances and baseline content without quality state", () => {
    const saved = entryFromPlayer(samplePlayers[0], { season: sampleMeta.season, mode: "league", scope: 7, competition: null });
    const current = watchlistRows([saved], { [saved.key]: { key: saved.key, status: "resolved", player: samplePlayers[0] } });
    const snapshot = watchlistRows([saved], {});
    const completeQuality = { kind: "complete" as const, dataQuality: { qualityVersion: "messi-quality-v1" as const, spatialAvailable: true, messiScoreComplete: true, reason: "complete" as const, imputedMetrics: [], imputedComponents: [], observedWeightPct: 100, fallbackComponentScore: 20 as const } };
    const qualityByKey = { [saved.key]: completeQuality };
    const { container, rerender, unmount } = render(<WatchlistTable rows={current} qualityByKey={qualityByKey} sort={{ key: "outsideShot", direction: "asc" }} onMetricSort={vi.fn()} onRemove={vi.fn()} onRetry={vi.fn()} />);
    expect(screen.getByText(samplePlayers[0].archetype)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sort by M.E.S.S.I. score descending" })).toHaveTextContent("M.E.S.S.I.");
    expect(screen.getByRole("button", { name: `Sort by ${metricConfig.outsideShot.label} ascending` })).toHaveTextContent("↑");
    expect(container.querySelectorAll('[aria-describedby^="quality-tooltip"]').length).toBe(0);
    rerender(<WatchlistTable rows={current} qualityByKey={qualityByKey} sort={{ key: "score", direction: "desc" }} onMetricSort={vi.fn()} onRemove={vi.fn()} onRetry={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Sort by M.E.S.S.I. score descending" })).toHaveTextContent("M.E.S.S.I. ↓");
    unmount();

    const card = render(<WatchlistCardList rows={snapshot} sort={{ key: "score", direction: "asc" }} onScoreSort={vi.fn()} onRemove={vi.fn()} onRetry={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Sort by M.E.S.S.I. score ascending" })).toHaveTextContent("M.E.S.S.I. score ↑");
    expect(card.container.querySelectorAll('[aria-describedby^="quality-tooltip"]').length).toBe(0);
  });
  it("does not debounce an unchanged query when the parent callback is recreated", () => {
    vi.useFakeTimers();
    const first = vi.fn();
    const props = { query: "", role: "ALL", sort: "score" as const, watchOnly: false, watchCount: 0, resultLabel: "", hasFilters: false, players: samplePlayers, dataset: { season: "2025/2026", mode: "league" as const, scope: 7 as const, competition: "all" as const }, onRoleChange: vi.fn(), onSortChange: vi.fn(), onWatchOnlyChange: vi.fn(), onReset: vi.fn() };
    const view = render(<DashboardToolbar {...props} onQueryChange={first} />);
    view.rerender(<DashboardToolbar {...props} onQueryChange={vi.fn()} />);
    act(() => { vi.advanceTimersByTime(350); });
    expect(first).not.toHaveBeenCalled();
    const changed = vi.fn();
    view.rerender(<DashboardToolbar {...props} onQueryChange={changed} />);
    fireEvent.change(screen.getByRole("combobox", { name: "Search players" }), { target: { value: "Erling" } });
    act(() => { vi.advanceTimersByTime(349); });
    expect(changed).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(1); });
    expect(changed).toHaveBeenCalledTimes(1);
    expect(changed).toHaveBeenCalledWith("Erling");
  });

  it("protects IME composition and supports immediate Enter and deletion commits", () => {
    vi.useFakeTimers();
    const commit = vi.fn();
    render(<DashboardToolbar query="" role="ALL" watchOnly={false} watchCount={0} hasFilters={false} players={samplePlayers} dataset={{ season: "2025/2026", mode: "league", scope: 7, competition: "all" }} onQueryChange={commit} onRoleChange={vi.fn()} onWatchOnlyChange={vi.fn()} onReset={vi.fn()} />);
    const input = screen.getByRole("combobox", { name: "Search players" });
    fireEvent.compositionStart(input);
    fireEvent.change(input, { target: { value: "김" } });
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    act(() => { vi.advanceTimersByTime(500); });
    expect(commit).not.toHaveBeenCalled();
    fireEvent.compositionEnd(input, { data: "김" });
    act(() => { vi.advanceTimersByTime(349); });
    expect(commit).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(1); });
    expect(commit).toHaveBeenLastCalledWith("김");
    fireEvent.change(input, { target: { value: "Haaland" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(commit).toHaveBeenLastCalledWith("Haaland");
    fireEvent.change(input, { target: { value: "" } });
    expect(commit).toHaveBeenLastCalledWith("");
  });

  it("cancels a pending leaderboard draft when the query namespace changes", () => {
    vi.useFakeTimers();
    const commit = vi.fn();
    const props = { query: "", role: "ALL", watchOnly: false, watchCount: 0, hasFilters: false, players: samplePlayers, dataset: { season: "2025/2026", mode: "league" as const, scope: 7 as const, competition: "all" as const }, onQueryChange: commit, onRoleChange: vi.fn(), onWatchOnlyChange: vi.fn(), onReset: vi.fn() };
    const view = render(<DashboardToolbar {...props} viewMode="leaderboard" />);
    fireEvent.change(screen.getByRole("combobox", { name: "Search players" }), { target: { value: "pending leaderboard draft" } });
    view.rerender(<DashboardToolbar {...props} viewMode="watchlist" />);
    expect(screen.getByRole("combobox", { name: "Search saved contexts" })).toHaveValue("");
    act(() => { vi.advanceTimersByTime(350); });
    expect(commit).not.toHaveBeenCalled();
  });

  it("preserves a pending search draft when the first non-query filter becomes active", () => {
    vi.useFakeTimers();
    const commit = vi.fn();
    const props = { query: "", role: "ALL", watchOnly: false, watchCount: 0, players: samplePlayers, dataset: { season: "2025/2026", mode: "league" as const, scope: 7 as const, competition: "all" as const }, onQueryChange: commit, onRoleChange: vi.fn(), onWatchOnlyChange: vi.fn(), onReset: vi.fn() };
    const view = render(<DashboardToolbar {...props} hasFilters={false} />);
    const input = screen.getByRole("combobox", { name: "Search players" });
    fireEvent.change(input, { target: { value: "Haaland" } });
    view.rerender(<DashboardToolbar {...props} role="Type A" hasFilters />);
    expect(input).toHaveValue("Haaland");
    act(() => { vi.advanceTimersByTime(349); });
    expect(commit).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(1); });
    expect(commit).toHaveBeenCalledOnce();
    expect(commit).toHaveBeenCalledWith("Haaland");
  });

  it("clears pending draft and autocomplete state immediately on Reset", () => {
    vi.useFakeTimers();
    const commit = vi.fn(); const reset = vi.fn();
    render(<DashboardToolbar query="" role="Type A" watchOnly={false} watchCount={0} hasFilters players={samplePlayers} dataset={{ season: "2025/2026", mode: "league", scope: 7, competition: "all" }} onQueryChange={commit} onRoleChange={vi.fn()} onWatchOnlyChange={vi.fn()} onReset={reset} />);
    const input = screen.getByRole("combobox", { name: "Search players" });
    fireEvent.change(input, { target: { value: "Erling" } });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Reset filters" }));
    expect(input).toHaveValue("");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(reset).toHaveBeenCalledOnce();
    act(() => { vi.advanceTimersByTime(350); });
    expect(commit).not.toHaveBeenCalled();
  });

  it("reports busy state for the visible watchlist rather than a background leaderboard refresh", () => {
    render(<MessiScoutingDashboard players={samplePlayers} meta={sampleMeta} refreshing onRefresh={vi.fn()} />);
    expect(document.getElementById("main-content")).toHaveAttribute("aria-busy", "true");
    fireEvent.click(screen.getByRole("button", { name: "Watchlist 0" }));
    expect(document.getElementById("main-content")).toHaveAttribute("aria-busy", "false");
    expect(screen.queryByText("Refreshing results…")).not.toBeInTheDocument();
  });

  it("keeps dataset filters interactive while a refresh is in progress", () => {
    const onStateChange = vi.fn();
    const options: LeaderboardOptions = {
      seasons: ["2024/2025"],
      scopes: [{ value: 3, label: "3 major leagues", leagueIds: [1, 2, 3] }],
      competitions: {
        all: { code: "all", label: "All competitions", available: true, reason: null },
        ucl: { code: "ucl", label: "Champions League", available: true, reason: null },
        uel: { code: "uel", label: "Europa League", available: true, reason: null },
        uecl: { code: "uecl", label: "Conference League", available: true, reason: null },
      },
    };
    render(<DatasetHeader meta={sampleMeta} visibleCount={50} refreshing onRefresh={vi.fn()} state={{ season: "2025/2026", mode: "league", scope: 7, competition: "all" }} options={options} onStateChange={onStateChange} />);
    expect(screen.getByLabelText("Ranking type")).toBeEnabled();
    expect(screen.getByLabelText("Season")).toBeEnabled();
    expect(screen.getByLabelText("League scope")).toBeEnabled();
    expect(screen.getByRole("button", { name: "Refreshing…" })).toBeDisabled();
    expect(screen.getByRole("option", { name: "2025/2026" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "7 major leagues" })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("League scope"), { target: { value: "3" } });
    expect(onStateChange).toHaveBeenCalledWith({ season: "2025/2026", mode: "league", scope: 3, competition: "all" });
  });

  it("uses server ranks and all six user-facing metrics", () => {
    render(<MessiScoutingDashboard players={samplePlayers} meta={sampleMeta} refreshing={false} onRefresh={vi.fn()} />);
    expect(screen.getAllByText("02").length).toBeGreaterThan(0);
    expect(screen.getAllByText("오프 더 볼").length).toBeGreaterThan(0);
    expect(screen.getAllByLabelText("Overall M.E.S.S.I. tier: Legacy Diamond, level 2").length).toBeGreaterThan(0);
  });

  it("mobile cards expose six metrics without disclosure", () => {
    const { container } = render(<PlayerCardList players={samplePlayers.slice(0, 1)} comparedIds={new Set()} watchedIds={new Set()} onToggleCompare={vi.fn()} onToggleWatch={vi.fn()} />);
    expect(container.querySelectorAll("article [role='tooltip']")).toHaveLength(0);
    expect(screen.getByText("오프 더 볼")).toBeInTheDocument();
  });

  it("keeps one visible, accessible set of table sort controls", () => {
    const { container } = render(<PlayerTable players={samplePlayers} comparedIds={new Set()} watchedIds={new Set()} sort={{ key: "score", direction: "desc" }} onMetricSort={vi.fn()} onToggleCompare={vi.fn()} onToggleWatch={vi.fn()} />);
    expect(container.querySelectorAll("thead button")).toHaveLength(7);
    expect(container.querySelectorAll("[aria-hidden] button")).toHaveLength(0);
    expect(container.querySelectorAll("button[aria-sort]")).toHaveLength(0);
    expect(container.querySelectorAll("th[aria-sort]")).toHaveLength(7);
    expect(screen.getByRole("button", { name: "Sort by M.E.S.S.I. score descending" })).toBeInTheDocument();
  });

  it("keeps loading skeletons free of focusable controls", () => {
    const { container } = render(<DashboardLoading />);
    expect(container.querySelectorAll("[aria-hidden] button, [aria-hidden] a, [aria-hidden] input, [aria-hidden] select")).toHaveLength(0);
  });

  it("communicates the active autocomplete option through combobox ARIA", () => {
    const { container } = render(<DashboardToolbar query="" role="ALL" sort="score" watchOnly={false} watchCount={0} resultLabel="2 shown · 2 results" hasFilters={false} players={samplePlayers} dataset={{ season: "2025/2026", mode: "league", scope: 7, competition: "all" }} onQueryChange={vi.fn()} onRoleChange={vi.fn()} onSortChange={vi.fn()} onWatchOnlyChange={vi.fn()} onReset={vi.fn()} />);
    const input = screen.getByRole("combobox", { name: "Search players" });
    fireEvent.change(input, { target: { value: "Erling" } });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    const option = screen.getByRole("option", { name: /Erling Haaland/ });
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    expect(input).toHaveAttribute("aria-activedescendant", option.id);
    expect(option).toHaveAttribute("aria-selected", "true");
    expect(container.querySelectorAll("[role='option'] a, [role='option'] button")).toHaveLength(0);
  });

  it("delegates companion autocomplete selection for mouse and keyboard navigation", () => {
    const select = vi.fn();
    const props = { query: "", role: "ALL", watchOnly: false, watchCount: 0, hasFilters: false, players: samplePlayers, dataset: { season: "2025/2026", mode: "league" as const, scope: 8 as const, competition: "all" as const }, onPlayerSuggestionSelect: select, onQueryChange: vi.fn(), onRoleChange: vi.fn(), onWatchOnlyChange: vi.fn(), onReset: vi.fn() };
    const mouse = render(<DashboardToolbar {...props} />);
    fireEvent.change(screen.getByRole("combobox", { name: "Search players" }), { target: { value: "Erling" } });
    fireEvent.click(screen.getByRole("option", { name: /Erling Haaland/ }));
    expect(select).toHaveBeenLastCalledWith(samplePlayers[0]);
    mouse.unmount();

    render(<DashboardToolbar {...props} />);
    const input = screen.getByRole("combobox", { name: "Search players" });
    fireEvent.change(input, { target: { value: "Erling" } });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(select).toHaveBeenCalledTimes(2);
    expect(duelPressDetailHref(samplePlayers[0].id, props.dataset)).toBe(`/players/${samplePlayers[0].id}?season=2025%2F2026&mode=league&scope=8&taxonomy=duel-press-v1`);
  });

  it("disables unavailable companion watch actions with an accessible explanation", () => {
    const open = vi.fn(); const switchMode = vi.fn();
    render(<DashboardToolbar query="" role="ALL" watchOnly={false} watchCount={0} watchAvailable={false} hasFilters={false} players={samplePlayers} dataset={{ season: "2025/2026", mode: "league", scope: 8, competition: "all" }} onQueryChange={vi.fn()} onRoleChange={vi.fn()} onWatchOnlyChange={vi.fn()} onOpenWatchlist={open} onViewModeChange={switchMode} onReset={vi.fn()} />);
    const watch = screen.getByRole("button", { name: "Watchlist 0" });
    const compare = screen.getByRole("button", { name: "Manage / Compare" });
    expect(watch).toBeDisabled(); expect(compare).toBeDisabled();
    expect(watch).toHaveAccessibleDescription("Watchlist 및 비교는 준비 중입니다.");
    expect(compare).toHaveAccessibleDescription("Watchlist 및 비교는 준비 중입니다.");
    fireEvent.click(watch); fireEvent.click(compare);
    expect(switchMode).not.toHaveBeenCalled(); expect(open).not.toHaveBeenCalled();
  });

  it("exposes M.E.S.S.I. score sorting through the header with exact aria-sort", () => {
    const sort = vi.fn();
    const view = render(<PlayerTable players={samplePlayers} sort={{ key: "score", direction: "desc" }} onMetricSort={sort} onToggleWatch={vi.fn()} />);
    const scoreHeader = screen.getByRole("columnheader", { name: /M.E.S.S.I./ });
    expect(scoreHeader).toHaveAttribute("aria-sort", "descending");
    fireEvent.click(screen.getByRole("button", { name: "Sort by M.E.S.S.I. score descending" }));
    expect(sort).toHaveBeenCalledWith("score");
    view.rerender(<PlayerTable players={samplePlayers} sort={{ key: "score", direction: "asc" }} onMetricSort={sort} onToggleWatch={vi.fn()} />);
    expect(screen.getByRole("columnheader", { name: /M.E.S.S.I./ })).toHaveAttribute("aria-sort", "ascending");
  });

  it("uses gated compact selects without toolbar sorting controls", () => {
    render(<DashboardToolbar query="" role="ALL" position="ALL" positionCapability="unsupported" sort="score" watchOnly={false} watchCount={0} resultLabel="2 shown · 2 results" hasFilters={false} players={samplePlayers} dataset={{ season: "2025/2026", mode: "league", scope: 7, competition: "all" }} onQueryChange={vi.fn()} onRoleChange={vi.fn()} onPositionChange={vi.fn()} onSortChange={vi.fn()} onWatchOnlyChange={vi.fn()} onReset={vi.fn()} />);
    expect(screen.getByLabelText("Position")).toBeInTheDocument();
    expect(screen.getByLabelText("Age")).toBeInTheDocument();
    expect(screen.getByLabelText("Minutes played")).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Center Back" })).toBeDisabled();
    expect(screen.queryByLabelText("Sort")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Sort direction")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Position filters are unavailable from this server.");
  });
});

describe("render failure containment", () => {
  it("shows a safe recovery action for a rendering failure", () => {
    const retry = vi.fn();
    const Thrower = () => {
      throw new Error("test render failure");
    };
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    render(<DashboardErrorBoundary resetKey={0} onReset={retry}><Thrower /></DashboardErrorBoundary>);
    expect(screen.getByRole("alert")).toHaveTextContent("Dashboard rendering error");
    expect(document.getElementById("main-content")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(retry).toHaveBeenCalledOnce();
    consoleError.mockRestore();
  });
});
