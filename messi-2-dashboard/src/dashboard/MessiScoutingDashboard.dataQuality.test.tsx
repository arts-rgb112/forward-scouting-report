// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const transport = vi.hoisted(() => ({ resolve: vi.fn(), quality: vi.fn() }));
vi.mock("../api/watchlistResolveApi", () => ({ resolveWatchlistEntries: transport.resolve }));
vi.mock("../api/dataQualityApi", () => ({ fetchWatchlistDataQuality: transport.quality }));

import MessiScoutingDashboard from "./MessiScoutingDashboard";
import { sampleMeta, samplePlayers } from "../test/fixtures/players";
import { entryFromPlayer, WATCHLIST_KEY } from "./watchlistStorage";
import type { WatchlistEntry } from "./watchlistStorage";

const context = { season: "2025/2026", mode: "league" as const, scope: 7 as const, competition: null };
const config = { baseUrl: "https://api.example.test", season: "2025/2026", scope: 7 as const, limit: 1000 };

afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks(); });
beforeEach(() => {
  transport.resolve.mockReset(); transport.quality.mockReset();
  transport.quality.mockImplementation(() => new Promise(() => undefined));
});

function save(entries: readonly unknown[]) {
  localStorage.setItem(WATCHLIST_KEY, JSON.stringify({ version: 2, entries, unresolvedLegacyIds: [], migration: { legacyKey: "messi-2-watchlist", migratedAt: null }, selectedEntryKeys: [] }));
}
function renderDashboard(players = samplePlayers) {
  return render(<MessiScoutingDashboard players={players} meta={sampleMeta} refreshing={false} onRefresh={vi.fn()} apiConfig={config} />);
}

describe("watchlist data-quality batches", () => {
  it("never posts a snapshot or legacy-partial row before it has an exact current profile", async () => {
    const snapshot = entryFromPlayer(samplePlayers[0], context);
    const legacy = { ...entryFromPlayer(samplePlayers[1], context), key: "legacy-partial", snapshot: { profile: "legacy-partial" as const, name: "Old save", position: "CF", clubName: "Old club", score: 50 } };
    save([snapshot, legacy]);
    transport.resolve.mockResolvedValue([{ key: snapshot.key, status: "unavailable" }, { key: legacy.key, status: "unavailable" }]);
    renderDashboard();
    fireEvent.click(screen.getByRole("button", { name: /Watchlist 2/ }));
    await waitFor(() => expect(transport.resolve).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("snapshots"));
    expect(transport.quality).not.toHaveBeenCalled();
  });

  it("posts one exact resolved visible page and replaces an in-flight batch on page change", async () => {
    const players = Array.from({ length: 51 }, (_, index) => ({ ...samplePlayers[index % samplePlayers.length], id: index + 1, rank: index + 1, name: `Saved ${index + 1}` }));
    const entries = players.map((player) => entryFromPlayer(player, context));
    const sortedEntries = [...entries].sort((left, right) => (players.find((player) => player.id === right.playerId)?.score ?? 0) - (players.find((player) => player.id === left.playerId)?.score ?? 0));
    save(entries);
    transport.resolve.mockResolvedValue(entries.map((entry) => ({ key: entry.key, status: "resolved", player: players.find((player) => player.id === entry.playerId) })));
    const calls: Array<{ entries: WatchlistEntry[]; signal: AbortSignal }> = [];
    transport.quality.mockImplementation((_config: unknown, requested: WatchlistEntry[], signal: AbortSignal) => { calls.push({ entries: requested, signal }); return new Promise(() => undefined); });
    const view = renderDashboard(players);

    fireEvent.click(screen.getByRole("button", { name: /Watchlist 51/ }));
    expect(transport.quality).not.toHaveBeenCalled();
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0].entries).toEqual(sortedEntries.slice(0, 50));

    fireEvent.click(screen.getByRole("button", { name: "Page 2" }));
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[0].signal.aborted).toBe(true);
    expect(calls[1].entries).toEqual(sortedEntries.slice(50));

    view.rerender(<MessiScoutingDashboard players={players} meta={sampleMeta} refreshing onRefresh={vi.fn()} apiConfig={config} />);
    expect(calls).toHaveLength(2);
  });
});
