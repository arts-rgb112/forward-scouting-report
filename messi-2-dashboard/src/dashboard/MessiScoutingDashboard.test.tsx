// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ResolvedWatchlistEntry } from "../api/watchlistResolveApi";
import { WATCHLIST_KEY, emptyWatchlist, entryFromPlayer } from "./watchlistStorage";
import { sampleMeta, samplePlayers } from "../test/fixtures/players";

const resolver = vi.hoisted(() => ({ resolveWatchlistEntries: vi.fn() }));
vi.mock("../api/watchlistResolveApi", () => ({ resolveWatchlistEntries: resolver.resolveWatchlistEntries }));

import MessiScoutingDashboard from "./MessiScoutingDashboard";

beforeEach(() => {
  const context = { season: sampleMeta.season, mode: "league" as const, scope: 7 as const, competition: null };
  const watchlist = emptyWatchlist();
  watchlist.entries = [entryFromPlayer(samplePlayers[0], context, "2026-08-11T00:00:00.000Z")];
  window.localStorage.setItem(WATCHLIST_KEY, JSON.stringify(watchlist));
  resolver.resolveWatchlistEntries.mockReturnValue(new Promise<ResolvedWatchlistEntry[]>(() => undefined));
});

afterEach(() => { cleanup(); window.localStorage.clear(); resolver.resolveWatchlistEntries.mockReset(); });

describe("MessiScoutingDashboard watchlist resolver lifecycle", () => {
  it("re-enables Resolve after removing the final entry during an active resolve", async () => {
    render(<MessiScoutingDashboard players={samplePlayers} meta={sampleMeta} refreshing={false} onRefresh={vi.fn()} apiConfig={{ baseUrl: "https://api.example.test", season: sampleMeta.season, scope: 7, limit: 1000 }} />);

    fireEvent.click(screen.getByRole("button", { name: "Watchlist 1" }));
    await waitFor(() => expect(resolver.resolveWatchlistEntries).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("button", { name: /Resolving/ })).toBeDisabled();

    fireEvent.click(screen.getAllByRole("button", { name: "Remove Erling Haaland saved context" })[0]);

    await waitFor(() => expect(screen.getByRole("button", { name: "Resolve saved contexts" })).toBeEnabled());
  });
});
