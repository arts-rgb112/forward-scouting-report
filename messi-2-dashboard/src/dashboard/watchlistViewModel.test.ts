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
    expect(rows[0].source).toBe("current");
    expect(rows[1]).toMatchObject({ source: "snapshot", profile: { stats: samplePlayers[0].stats, minutes: 1900, age: 25 } });
  });

  it("filters roles from saved profiles, excludes legacy partial rows, and uses a local 50-row paginator", () => {
    const base = entryFromPlayer(samplePlayers[0], league);
    const entries = Array.from({ length: 51 }, (_, index) => ({ ...base, key: `${base.key}|saved:${index}` }));
    const rows = watchlistRows(entries, {});
    expect(filterAndSortWatchlistRows(rows, { query: "", role: "Type A", position: "ALL", sort: { key: "score", direction: "desc" } })).toHaveLength(51);
    const legacy = { ...base, key: "legacy", snapshot: { name: "Old", position: "CF", clubName: "Club", profile: "legacy-partial" as const } };
    expect(filterAndSortWatchlistRows(watchlistRows([legacy], {}), { query: "", role: "Type A", position: "ALL", sort: { key: "score", direction: "desc" } })).toEqual([]);
    expect(rows[0].entry.snapshot.name).toBe(samplePlayers[0].name);
    expect(watchlistPage(rows, 2)).toMatchObject({ page: 2, totalPages: 2 });
    expect(watchlistPage(rows, 2).rows).toHaveLength(1);
  });

  it("uses current server data first, then a complete snapshot, and keeps null values last", () => {
    const saved = entryFromPlayer(samplePlayers[0], league);
    const resolved = { ...samplePlayers[1], id: saved.playerId, name: "Current profile" };
    expect(watchlistRows([saved], { [saved.key]: { key: saved.key, status: "resolved", player: resolved } })[0]).toMatchObject({ source: "current", profile: { name: "Current profile" } });
    expect(watchlistRows([saved], { [saved.key]: { key: saved.key, status: "invalid_context" } })[0]).toMatchObject({ source: "snapshot", profile: { name: saved.snapshot.name } });
    const noAge = entryFromPlayer(samplePlayers[1], league);
    const sorted = filterAndSortWatchlistRows(watchlistRows([noAge, saved], {}), { query: "", role: "ALL", position: "ALL", sort: { key: "age", direction: "desc" } });
    expect(sorted.map((row) => row.key)).toEqual([saved.key, noAge.key]);
  });

  it("keeps the current resolver taxonomy ahead of the immutable snapshot taxonomy", () => {
    const saved = entryFromPlayer({ ...samplePlayers[0], tier: { ...samplePlayers[0].tier, taxonomyVersion: "crystal-v2" } }, league);
    const current = { ...samplePlayers[1], id: saved.playerId, tier: { ...samplePlayers[1].tier } };
    const resolved = watchlistRows([saved], { [saved.key]: { key: saved.key, status: "resolved", player: current } })[0];
    const fallback = watchlistRows([saved], { [saved.key]: { key: saved.key, status: "unavailable" } })[0];
    expect(resolved).toMatchObject({ source: "current", profile: { tier: { code: "platinum" } } });
    expect(resolved.profile.tier?.taxonomyVersion).toBeUndefined();
    expect(fallback).toMatchObject({ source: "snapshot", profile: { tier: { code: "diamond", taxonomyVersion: "crystal-v2" } } });
    expect(saved.snapshot.tier).toMatchObject({ code: "diamond", taxonomyVersion: "crystal-v2" });
  });

  it("filters resolved and complete snapshot age/minutes locally while excluding partial data", () => {
    const younger = entryFromPlayer({ ...samplePlayers[0], age: 22, minutes: 1200 }, league);
    const older = entryFromPlayer({ ...samplePlayers[1], age: 31, minutes: 3000 }, league);
    const partial = { ...younger, key: "legacy", snapshot: { name: "Old", position: "CF", clubName: "Club", profile: "legacy-partial" as const } };
    const rows = watchlistRows([younger, older, partial], {});
    expect(filterAndSortWatchlistRows(rows, { query: "", role: "ALL", position: "ALL", ageBand: "u23", minutesBand: "1000-1499", sort: { key: "score", direction: "desc" } }).map((row) => row.key)).toEqual([younger.key]);
    expect(filterAndSortWatchlistRows(rows, { query: "", role: "ALL", position: "ALL", ageBand: "all", minutesBand: "all", sort: { key: "score", direction: "desc" } })).toHaveLength(3);
  });
});
