// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import MessiScoutingDashboard from "../MessiScoutingDashboard";
import { sampleMeta, samplePlayers } from "../../test/fixtures/players";
import { AssetImage } from "./AssetImage";
import { DashboardLoading } from "./DashboardLoading";
import { DashboardErrorBoundary } from "./DashboardErrorBoundary";
import { DashboardToolbar } from "./DashboardToolbar";
import { PlayerCardList } from "./PlayerCardList";
import { PlayerTable } from "./PlayerTable";

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
    const { container } = render(<DashboardToolbar query="" role="ALL" sort="score" watchOnly={false} watchCount={0} positions={["ALL"]} resultCount={2} hasFilters={false} players={samplePlayers} dataset={{ season: "2025/2026", mode: "league", scope: 7, competition: "all" }} onQueryChange={vi.fn()} onRoleChange={vi.fn()} onSortChange={vi.fn()} onWatchOnlyChange={vi.fn()} onReset={vi.fn()} />);
    const input = screen.getByRole("combobox", { name: "Search players" });
    fireEvent.change(input, { target: { value: "Erling" } });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    const option = screen.getByRole("option", { name: /Erling Haaland/ });
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    expect(input).toHaveAttribute("aria-activedescendant", option.id);
    expect(option).toHaveAttribute("aria-selected", "true");
    expect(container.querySelectorAll("[role='option'] a, [role='option'] button")).toHaveLength(0);
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
