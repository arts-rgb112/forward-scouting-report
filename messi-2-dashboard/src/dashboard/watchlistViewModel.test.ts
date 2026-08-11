import { describe, expect, it } from "vitest";

import { samplePlayers } from "../test/fixtures/players";
import { entryFromPlayer } from "./watchlistStorage";
import { filterAndSortWatchlistRows, watchlistPage, watchlistRows } from "./watchlistViewModel";

const league = { season: "2025/2026", mode: "league" as const, scope: 7 as const, competition: null };

describe("watchlist view model", () => {
  it("retains duplicate player IDs as independently keyed saved contexts and merges only the exact resolved key", () => {
    const current = entryFromPlayer(samplePlayers[0], league);
    const previous = entryFromPlayer(samplePlayers[0], { ...league, season: "2024/2025" });
    const rows = watchlistRows([current, previous], { [current.key]: { key: current.key, status: "resolved", player: samplePlayers[0] } });
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.key)).toEqual([current.key, previous.key]);
    expect(rows[0].player).toEqual(samplePlayers[0]);
    expect(rows[1].player).toBeUndefined();
  });

  it("filters roles by resolved archetype, preserves snapshots, and uses a local 50-row paginator", () => {
    const base = entryFromPlayer(samplePlayers[0], league);
    const entries = Array.from({ length: 51 }, (_, index) => ({ ...base, key: `${base.key}|saved:${index}` }));
    const rows = watchlistRows(entries, {});
    expect(filterAndSortWatchlistRows(rows, { query: "", role: "Type A", position: "ALL", sort: { key: "score", direction: "desc" } })).toEqual([]);
    expect(rows[0].entry.snapshot.name).toBe(samplePlayers[0].name);
    expect(watchlistPage(rows, 2)).toMatchObject({ page: 2, totalPages: 2 });
    expect(watchlistPage(rows, 2).rows).toHaveLength(1);
  });
});
