import { DuelPressApiError, duelPressResourceKey, fetchDuelPressDetailByContext } from "../api/duelPressApi";
import { DuelPressV2ApiError, fetchDuelPressV2Player } from "../api/duelPressV2Api";
import { adaptDuelPressV2PlayerCore } from "../api/duelPressAdapter";
import type { MessiApiConfig } from "../api/env";
import type { DuelPressPlayerCore } from "../api/duelPressTypes";
import type { DuelPressV3Entry } from "./watchlistV3Contracts";

export type DuelWatchlistResolution = { status: "pending" | "current" | "unavailable" | "offline" | "contract-error"; player?: DuelPressPlayerCore };
export type DuelWatchlistResolver = (config: MessiApiConfig, entry: DuelPressV3Entry, signal: AbortSignal) => Promise<DuelPressPlayerCore>;
export const resolveDuelWatchlistEntry: DuelWatchlistResolver = (config, entry, signal) => fetchDuelPressDetailByContext(config, entry.playerId, entry.context, signal);
/** Resolve the current row through the same official v2 player contract used by
 * the main leaderboard. The saved entry remains a v1 snapshot by design. */
export const resolveDuelWatchlistEntryV2: DuelWatchlistResolver = async (config, entry, signal) => {
  const response = await fetchDuelPressV2Player(config, entry.playerId, {
    season: entry.context.season,
    mode: entry.context.mode,
    scope: entry.context.mode === "league" ? entry.context.scope : 8,
    competition: entry.context.mode === "league" ? "all" : entry.context.competition,
  }, signal);
  return adaptDuelPressV2PlayerCore(response.data);
};
export const duelWatchlistResourceKey = (entry: DuelPressV3Entry) => duelPressResourceKey(`player:${entry.playerId}`, entry.context);

export function duelResolutionFromError(error: unknown): DuelWatchlistResolution {
  if (error instanceof DuelPressApiError || error instanceof DuelPressV2ApiError) {
    if (error.kind === "not-found" || error.kind === "invalid-request") return { status: "unavailable" };
    if (error.kind === "schema") return { status: "contract-error" };
  }
  return { status: "offline" };
}

/** Future batch resolvers can implement the same callback surface without changing view state. */
export async function resolveVisibleDuelWatchlistEntries(config: MessiApiConfig, entries: readonly DuelPressV3Entry[], signal: AbortSignal, commit: (key: string, result: DuelWatchlistResolution) => void, resolver: DuelWatchlistResolver = resolveDuelWatchlistEntry): Promise<void> {
  const resources = new Map<string, { entry: DuelPressV3Entry; keys: string[] }>();
  for (const entry of entries) {
    const resourceKey = duelWatchlistResourceKey(entry); const existing = resources.get(resourceKey);
    if (existing) existing.keys.push(entry.key); else resources.set(resourceKey, { entry, keys: [entry.key] });
  }
  const queue = [...resources.values()]; let next = 0;
  const worker = async () => {
    while (!signal.aborted) {
      const index = next++; const resource = queue[index]; if (!resource) return;
      try { const player = await resolver(config, resource.entry, signal); if (!signal.aborted) resource.keys.forEach((key) => commit(key, { status: "current", player })); }
      catch (error) { if (!signal.aborted) { const result = duelResolutionFromError(error); resource.keys.forEach((key) => commit(key, result)); } }
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, queue.length) }, worker));
}
