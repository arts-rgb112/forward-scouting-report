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
import type { LeaderboardOptions } from "../types";

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
  it("does not debounce an unchanged query when the parent callback is recreated", () => {
    vi.useFakeTimers();
    const first = vi.fn();
    const props = { query: "", role: "ALL", sort: "score" as const, watchOnly: false, watchCount: 0, resultLabel: "", hasFilters: false, players: samplePlayers, dataset: { season: "2025/2026", mode: "league" as const, scope: 7 as const, competition: "all" as const }, onRoleChange: vi.fn(), onSortChange: vi.fn(), onWatchOnlyChange: vi.fn(), onReset: vi.fn() };
    const view = render(<DashboardToolbar {...props} onQueryChange={first} />);
    view.rerender(<DashboardToolbar {...props} onQueryChange={vi.fn()} />);
    act(() => { vi.advanceTimersByTime(181); });
    expect(first).not.toHaveBeenCalled();
    const changed = vi.fn();
    view.rerender(<DashboardToolbar {...props} onQueryChange={changed} />);
    fireEvent.change(screen.getByRole("combobox", { name: "Search players" }), { target: { value: "Erling" } });
    act(() => { vi.advanceTimersByTime(181); });
    expect(changed).toHaveBeenCalledTimes(1);
    expect(changed).toHaveBeenCalledWith("Erling");
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
    expect(screen.getAllByTitle("Diamond II, level 2").length).toBeGreaterThan(0);
  });

  it("mobile cards expose six metrics without disclosure", () => {
    const { container } = render(<PlayerCardList players={samplePlayers.slice(0, 1)} comparedIds={new Set()} watchedIds={new Set()} onToggleCompare={vi.fn()} onToggleWatch={vi.fn()} />);
    expect(container.querySelectorAll("article [role='tooltip']")).toHaveLength(0);
    expect(screen.getByText("오프 더 볼")).toBeInTheDocument();
  });

  it("keeps one visible, accessible set of table sort controls", () => {
    const { container } = render(<PlayerTable players={samplePlayers} comparedIds={new Set()} watchedIds={new Set()} sort={{ key: "score", direction: "desc" }} onMetricSort={vi.fn()} onToggleCompare={vi.fn()} onToggleWatch={vi.fn()} />);
    expect(container.querySelectorAll("thead button")).toHaveLength(6);
    expect(container.querySelectorAll("[aria-hidden] button")).toHaveLength(0);
    expect(container.querySelectorAll("button[aria-sort]")).toHaveLength(0);
    expect(container.querySelectorAll("th[aria-sort]")).toHaveLength(6);
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

  it("shows the complete position chip layout without filtering a server page locally", () => {
    render(<DashboardToolbar query="" role="ALL" position="ALL" positionCapability="unsupported" sort="score" watchOnly={false} watchCount={0} resultLabel="2 shown · 2 results" hasFilters={false} players={samplePlayers} dataset={{ season: "2025/2026", mode: "league", scope: 7, competition: "all" }} onQueryChange={vi.fn()} onRoleChange={vi.fn()} onPositionChange={vi.fn()} onSortChange={vi.fn()} onWatchOnlyChange={vi.fn()} onReset={vi.fn()} />);
    expect(screen.getByRole("button", { name: "All positions" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Center Back" })).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("Detailed position filters are unavailable from this server.");
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
