import { describe, expect, it } from "vitest";
import { duelPressCompareHref, parseDuelPressCompare } from "./duelPressCompareUrl";
import { beginDuelPressRequest, settleDuelPressRequest, type DuelPressResource } from "./duelPressResourceState";
import { duelPressEntry, migrateWatchlistV2Source, WATCHLIST_V3_KEY, watchlistV3Key } from "./watchlistStorageV3";
import { entryFromPlayer } from "./watchlistStorage";
import { samplePlayers } from "../test/fixtures/players";
import validLeaderboard from "../../../docs/fixtures/duel_press_v1/valid_leaderboard.json";
import { duelPressPlayerSchema } from "../api/duelPressContracts";
const league = { season: "2025/2026", mode: "league" as const, scope: 8 as const, competition: "all" as const };
const europe = { season: "2024/2025", mode: "europe" as const, scope: null, competition: "uel" as const };
describe("duel-press saved and compare models", () => {
  it("round-trips two independent compare contexts", () => {
    const href = duelPressCompareHref({ playerId: 1, taxonomy: "legacy-v1", context: league }, { playerId: 2, taxonomy: "duel-press-v1", context: europe });
    expect(parseDuelPressCompare(new URL(href, "https://app.test").search)).toEqual({ left: { playerId: 1, taxonomy: "legacy-v1", context: league }, right: { playerId: 2, taxonomy: "duel-press-v1", context: europe } });
    expect(parseDuelPressCompare("?leftPlayerId=1")).toBeNull();
  });
  it("keeps one side ready when the other fails and ignores stale settlements", () => {
    const base: DuelPressResource<string> = { key: "", requestId: 0, status: "idle", value: null, error: null };
    const left = settleDuelPressRequest(beginDuelPressRequest(base, "left", 1), 1, { value: "left player" });
    const right = settleDuelPressRequest(beginDuelPressRequest(base, "right", 2), 2, { error: new Error("failed") });
    expect(left).toMatchObject({ status: "ready", value: "left player" }); expect(right).toMatchObject({ status: "error", value: null });
    expect(settleDuelPressRequest(left, 0, { error: "stale" })).toBe(left);
  });
  it("migrates V2 snapshots as legacy only without mutating the source", () => {
    const v2Entry = entryFromPlayer(samplePlayers[0], { season: league.season, mode: "league", scope: 8, competition: null }, "2026-01-01T00:00:00.000Z");
    const source = JSON.stringify({ version: 2, entries: [v2Entry], unresolvedLegacyIds: [], migration: { legacyKey: "messi-2-watchlist", migratedAt: null }, selectedEntryKeys: [] });
    const migrated = migrateWatchlistV2Source(source); expect(migrated[0]).toMatchObject({ version: 3, taxonomy: "legacy-v1", playerId: 1, context: league }); expect(source).toBe(JSON.stringify(JSON.parse(source))); expect(WATCHLIST_V3_KEY).toBe("messi-2-watchlist:v3");
  });
  it("rejects unsafe V2 identities and malformed contexts during V3 migration", () => { const good = entryFromPlayer(samplePlayers[0], { season: league.season, mode: "league", scope: 8, competition: null }); const raw = JSON.stringify({ version: 2, entries: [{ ...good, playerId: -1 }, { ...good, key: "bad-season", context: { ...good.context, season: "yesterday" } }], unresolvedLegacyIds: [], migration: { legacyKey: "messi-2-watchlist", migratedAt: null }, selectedEntryKeys: [] }); expect(migrateWatchlistV2Source(raw)).toEqual([]); expect(() => watchlistV3Key("duel-press-v1", Number.MAX_SAFE_INTEGER + 1, europe)).toThrow(); });
  it("keys duel snapshots by taxonomy and full context", () => {
    const player = duelPressPlayerSchema.parse(validLeaderboard.data[0]);
    const entry = duelPressEntry(player, europe, "2026-01-01T00:00:00Z"); expect(entry.snapshot).toEqual(player); expect(entry.snapshot).not.toBe(player); expect(entry.key).toBe(watchlistV3Key("duel-press-v1", player.id, europe)); expect(entry.key).not.toBe(watchlistV3Key("legacy-v1", player.id, europe));
  });
});
