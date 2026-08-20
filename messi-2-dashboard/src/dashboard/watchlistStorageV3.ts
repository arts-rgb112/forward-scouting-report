import type { DuelPressPlayerCore, DuelPressModeContext } from "../api/duelPressTypes";
import { parseWatchlist, type WatchlistSnapshot } from "./watchlistStorage";
export const WATCHLIST_V3_KEY = "messi-2-watchlist:v3";
export type LegacyV3Entry = { version: 3; taxonomy: "legacy-v1"; key: string; playerId: number; context: DuelPressModeContext; snapshot: WatchlistSnapshot; savedAt: string };
export type DuelPressV3Entry = { version: 3; taxonomy: "duel-press-v1"; key: string; playerId: number; context: DuelPressModeContext; snapshot: DuelPressPlayerCore; savedAt: string };
export type WatchlistV3Entry = LegacyV3Entry | DuelPressV3Entry;
export const watchlistV3Key = (taxonomy: WatchlistV3Entry["taxonomy"], playerId: number, context: DuelPressModeContext) => { if (!Number.isSafeInteger(playerId) || playerId <= 0) throw new Error("playerId must be a positive safe integer"); return JSON.stringify([taxonomy, "fotmob", playerId, context.season, context.mode, context.scope, context.competition]); };
/** Pure migration: callers may persist V3, but this function never reads or rewrites the V2 key. */
export function migrateWatchlistV2Source(rawV2: string | null): LegacyV3Entry[] {
  const v2 = parseWatchlist(rawV2); if (!v2) return [];
  return v2.entries.filter((entry) => Number.isSafeInteger(entry.playerId) && entry.playerId > 0 && /^20\d{2}\/20\d{2}$/.test(entry.context.season) && (entry.context.mode === "league" ? entry.context.scope !== null && entry.context.competition === null : entry.context.scope === null && entry.context.competition !== null)).map((entry) => {
    const context: DuelPressModeContext = entry.context.mode === "league"
      ? { season: entry.context.season, mode: "league", scope: entry.context.scope!, competition: "all" }
      : { season: entry.context.season, mode: "europe", scope: null, competition: entry.context.competition! };
    return { version: 3, taxonomy: "legacy-v1", key: watchlistV3Key("legacy-v1", entry.playerId, context), playerId: entry.playerId, context, snapshot: structuredClone(entry.snapshot), savedAt: entry.savedAt };
  });
}
export function duelPressEntry(player: DuelPressPlayerCore, context: DuelPressModeContext, savedAt: string): DuelPressV3Entry {
  return { version: 3, taxonomy: "duel-press-v1", key: watchlistV3Key("duel-press-v1", player.id, context), playerId: player.id, context: structuredClone(context), snapshot: structuredClone(player), savedAt };
}
