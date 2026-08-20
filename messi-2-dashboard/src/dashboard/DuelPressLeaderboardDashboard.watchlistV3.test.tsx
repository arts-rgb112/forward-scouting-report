// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import validLeaderboard from "../../../docs/fixtures/duel_press_v1/valid_leaderboard.json";
import { adaptDuelPressPlayerCore } from "../api/duelPressAdapter";
import { duelPressLeaderboardCoreSchema } from "../api/duelPressContracts";

const dto = duelPressLeaderboardCoreSchema.parse(validLeaderboard);
const payload = {
  players: dto.data.map(adaptDuelPressPlayerCore),
  meta: dto.meta,
  serverPage: { page: dto.meta.page, pageSize: 50 as const, totalPages: dto.meta.totalPages, hasNextPage: dto.meta.hasNextPage },
};
const dataset = { season: "2025/2026", mode: "league" as const, scope: 8 as const, competition: "all" as const };
const search = { page: 1, pageSize: 50 as const, q: "", role: "all" as const, position: "ALL", ageBand: "all" as const, minutesBand: "all" as const, sort: "score" as const, direction: "desc" as const };

describe("flag-enabled Watchlist V3 dashboard wiring", () => {
  beforeEach(() => { localStorage.clear(); vi.stubEnv("VITE_WATCHLIST_V3_ENABLED", "true"); });
  afterEach(() => { cleanup(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  it("connects the dense duel leaderboard, exact-context saves, snapshot view, and manager drawer", async () => {
    vi.resetModules();
    const [{ default: Dashboard }, provider, repository] = await Promise.all([
      import("./DuelPressLeaderboardDashboard"),
      import("./WatchlistV3Provider"),
      import("./watchlistV3Repository"),
    ]);
    const { container } = render(
      <provider.WatchlistV3Provider lockCoordinator={repository.createMemoryWatchlistV3LockCoordinator()}>
        <Dashboard payload={payload} dataset={dataset} search={search} refreshing={false} onRefresh={() => undefined} onDatasetChange={() => undefined} onSearchChange={() => undefined} onPageChange={() => undefined} />
      </provider.WatchlistV3Provider>,
    );

    expect(screen.getAllByRole("columnheader")).toHaveLength(12);
    expect(container.querySelector("tbody tr")).toHaveClass("h-[72px]");
    const saveButtons = screen.getAllByRole("button", { name: /Save Harry Kane.*duel and press taxonomy/i });
    fireEvent.click(saveButtons[0]);
    await waitFor(() => expect(screen.getByRole("button", { name: "Watchlist 1" })).toBeInTheDocument());
    expect(saveButtons[0]).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(screen.getByRole("button", { name: "Watchlist 1" }));
    expect(await screen.findByRole("heading", { name: "Duel / Press taxonomy" })).toBeInTheDocument();
    expect(screen.getAllByText("Offline · saved snapshot").length).toBeGreaterThan(0);
    expect(screen.getByText("1–1 of 1 saved contexts")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Manage / Compare" }));
    const dialog = screen.getByRole("dialog", { name: "Manage saved contexts" });
    expect(dialog).toHaveTextContent("1 exact contexts · 0/2 selected");
    fireEvent.click(within(dialog).getByRole("button", { name: "Select for compare" }));
    await waitFor(() => expect(dialog).toHaveTextContent("1 exact contexts · 1/2 selected"));
    expect(dialog.querySelector('[aria-disabled="true"]')).toHaveTextContent("1/2 selected");
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(dialog).toHaveTextContent("0 exact contexts · 0/2 selected"));
    expect(screen.getByRole("button", { name: "Watchlist 0" })).toBeInTheDocument();
  });
});
