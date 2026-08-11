import { describe, expect, it } from "vitest";

import { entryFromPlayer, migrateLegacyWatchlist, parseWatchlist, removeWatchlistEntry, resolveUnresolvedLegacyIds, toggleWatchlistSelection, watchlistKey } from "./watchlistStorage";
import { samplePlayers } from "../test/fixtures/players";

const league = { season: "2025/2026", mode: "league" as const, scope: 7 as const, competition: null };

describe("Watchlist V2 storage", () => {
  it("keys exact player context and removes only that entry", () => {
    const current = entryFromPlayer(samplePlayers[0], league, "2026-01-01T00:00:00.000Z");
    const otherSeason = entryFromPlayer(samplePlayers[0], { ...league, season: "2024/2025" });
    const europe = entryFromPlayer(samplePlayers[0], { season: "2025/2026", mode: "europe", scope: null, competition: "ucl" });
    expect(current.key).not.toBe(otherSeason.key);
    expect(current.key).not.toBe(europe.key);
    expect(watchlistKey(1, league)).toContain("scope:7");
    expect(removeWatchlistEntry({ version: 2, entries: [current, otherSeason], unresolvedLegacyIds: [], migration: { legacyKey: "messi-2-watchlist", migratedAt: null }, selectedEntryKeys: [current.key] }, current.key)).toMatchObject({ entries: [otherSeason], selectedEntryKeys: [] });
  });

  it("migrates only currently provable old IDs and leaves the old value untouched", () => {
    const migrated = migrateLegacyWatchlist("[1,2,99,2]", [samplePlayers[0]], league, "2026-01-01T00:00:00.000Z");
    expect(migrated.entries.map((entry) => entry.playerId)).toEqual([1]);
    expect(migrated.unresolvedLegacyIds).toEqual([2, 99]);
    expect(migrated.entries[0].context).toEqual(league);
  });

  it("promotes a later page match without modifying the old numeric legacy value", () => {
    const legacyRaw = "[2]";
    const firstPage = migrateLegacyWatchlist(legacyRaw, [samplePlayers[0]], league, "2026-01-01T00:00:00.000Z");
    expect(firstPage.unresolvedLegacyIds).toEqual([2]);
    const laterPage = resolveUnresolvedLegacyIds(firstPage, [samplePlayers[1]], league, "2026-01-02T00:00:00.000Z");
    expect(laterPage.entries.map((entry) => entry.playerId)).toEqual([2]);
    expect(laterPage.entries[0].context).toEqual(league);
    expect(laterPage.unresolvedLegacyIds).toEqual([]);
    expect(legacyRaw).toBe("[2]");
  });

  it("does not prune saved snapshots when the current page changes", () => {
    const saved = entryFromPlayer(samplePlayers[0], league);
    const nextPageIsEmpty: number[] = [];
    expect(nextPageIsEmpty).toEqual([]);
    expect({ entries: [saved] }.entries).toHaveLength(1);
  });

  it("persists no more than two selections by entry key", () => {
    const entries = samplePlayers.map((player) => entryFromPlayer(player, league));
    const third = entryFromPlayer({ ...samplePlayers[0], id: 3 }, league);
    const initial = { version: 2 as const, entries: [...entries, third], unresolvedLegacyIds: [], migration: { legacyKey: "messi-2-watchlist" as const, migratedAt: null }, selectedEntryKeys: [] };
    const two = toggleWatchlistSelection(toggleWatchlistSelection(initial, entries[0].key), entries[1].key);
    expect(toggleWatchlistSelection(two, third.key).selectedEntryKeys).toEqual([entries[0].key, entries[1].key]);
  });

  it("drops corrupt selection keys that do not name an entry", () => {
    const entry = entryFromPlayer(samplePlayers[0], league);
    const parsed = parseWatchlist(JSON.stringify({ version: 2, entries: [entry], unresolvedLegacyIds: [], migration: { legacyKey: "messi-2-watchlist", migratedAt: null }, selectedEntryKeys: ["unknown", entry.key, entry.key] }));
    expect(parsed?.selectedEntryKeys).toEqual([entry.key]);
  });
});
