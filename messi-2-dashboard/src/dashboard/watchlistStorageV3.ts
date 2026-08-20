import type { DuelPressPlayerCore, DuelPressModeContext } from "../api/duelPressTypes";
import { parseWatchlist, type WatchlistSnapshot } from "./watchlistStorage";
import { watchlistV3EntrySchema, watchlistV3Key, type DuelPressV3Entry, type LegacyV3Entry } from "./watchlistV3Contracts";

export { WATCHLIST_V3_KEY, watchlistV3Key } from "./watchlistV3Contracts";
export type { DuelPressV3Entry, LegacyV3Entry, WatchlistV3Entry } from "./watchlistV3Contracts";

/** Pure migration. V2 remains read-only and this function never touches storage. */
export function migrateWatchlistV2Source(rawV2: string | null): LegacyV3Entry[] {
  const v2 = parseWatchlist(rawV2); if (!v2) return [];
  const migrated: LegacyV3Entry[] = [];
  for (const entry of v2.entries) {
    if (!Number.isSafeInteger(entry.playerId) || entry.playerId <= 0 || !/^20\d{2}\/20\d{2}$/.test(entry.context.season)) continue;
    const context: DuelPressModeContext | null = entry.context.mode === "league" && entry.context.scope !== null
      ? { season: entry.context.season, mode: "league", scope: entry.context.scope, competition: "all" }
      : entry.context.mode === "europe" && entry.context.competition !== null
        ? { season: entry.context.season, mode: "europe", scope: null, competition: entry.context.competition }
        : null;
    if (!context) continue;
    const candidate = { version: 3 as const, taxonomy: "legacy-v1" as const, namespace: "fotmob" as const, key: watchlistV3Key("legacy-v1", entry.playerId, context), playerId: entry.playerId, context: structuredClone(context), snapshot: structuredClone(entry.snapshot) as WatchlistSnapshot, savedAt: entry.savedAt };
    const parsed = watchlistV3EntrySchema.safeParse(candidate); if (parsed.success && parsed.data.taxonomy === "legacy-v1") migrated.push(parsed.data);
  }
  return migrated;
}

export function duelPressEntry(player: DuelPressPlayerCore, context: DuelPressModeContext, savedAt = new Date().toISOString()): DuelPressV3Entry {
  return { version: 3, taxonomy: "duel-press-v1", namespace: "fotmob", key: watchlistV3Key("duel-press-v1", player.id, context), playerId: player.id, context: structuredClone(context), snapshot: structuredClone(player), savedAt };
}

export function legacyV3Entry(playerId: number, snapshot: WatchlistSnapshot, context: DuelPressModeContext, savedAt = new Date().toISOString()): LegacyV3Entry {
  return { version: 3, taxonomy: "legacy-v1", namespace: "fotmob", key: watchlistV3Key("legacy-v1", playerId, context), playerId, context: structuredClone(context), snapshot: structuredClone(snapshot), savedAt };
}
