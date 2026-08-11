import type { DatasetRouteState, Player } from "./types";

/** The former ID-only key is deliberately read-only: never overwrite it. */
export const LEGACY_WATCHLIST_KEY = "messi-2-watchlist";
export const WATCHLIST_KEY = "messi-2-watchlist:v2";

export type WatchContext = {
  season: string;
  mode: "league" | "europe";
  scope: 3 | 5 | 7 | null;
  competition: "all" | "ucl" | "uel" | "uecl" | null;
};
export type WatchlistEntry = {
  version: 2;
  key: string;
  namespace: "fotmob";
  playerId: number;
  snapshot: { name: string; position: string; clubName: string; leagueName?: string; face?: string | null; score?: number; tierLabel?: string };
  context: WatchContext;
  savedAt: string;
};
export type WatchlistEnvelope = {
  version: 2;
  entries: WatchlistEntry[];
  unresolvedLegacyIds: number[];
  migration: { legacyKey: typeof LEGACY_WATCHLIST_KEY; migratedAt: string | null };
  selectedEntryKeys: string[];
};

const validScope = (value: unknown): value is 3 | 5 | 7 => value === 3 || value === 5 || value === 7;
const validCompetition = (value: unknown): value is WatchContext["competition"] => value === null || value === "all" || value === "ucl" || value === "uel" || value === "uecl";
const validContext = (value: unknown): value is WatchContext => {
  if (!value || typeof value !== "object") return false;
  const context = value as Record<string, unknown>;
  return typeof context.season === "string" && (context.mode === "league" || context.mode === "europe") && (context.scope === null || validScope(context.scope)) && validCompetition(context.competition);
};
const validEntry = (value: unknown): value is WatchlistEntry => {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  return entry.version === 2 && entry.namespace === "fotmob" && Number.isSafeInteger(entry.playerId) && typeof entry.key === "string" && typeof entry.savedAt === "string" && validContext(entry.context) && Boolean(entry.snapshot && typeof entry.snapshot === "object");
};

export function contextFromDataset(dataset: DatasetRouteState): WatchContext {
  return dataset.mode === "league"
    ? { season: dataset.season, mode: "league", scope: dataset.scope, competition: null }
    : { season: dataset.season, mode: "europe", scope: null, competition: dataset.competition };
}

export function watchlistKey(playerId: number, context: WatchContext): string {
  return `fotmob:${playerId}|season:${context.season}|mode:${context.mode}|scope:${context.scope ?? "null"}|competition:${context.competition ?? "null"}`;
}

export function entryFromPlayer(player: Player, context: WatchContext, savedAt = new Date().toISOString()): WatchlistEntry {
  return { version: 2, key: watchlistKey(player.id, context), namespace: "fotmob", playerId: player.id, snapshot: { name: player.name, position: player.position, clubName: player.club.name, leagueName: player.league.name, face: player.face, score: player.score, tierLabel: player.tier.label }, context, savedAt };
}

export function emptyWatchlist(): WatchlistEnvelope {
  return { version: 2, entries: [], unresolvedLegacyIds: [], migration: { legacyKey: LEGACY_WATCHLIST_KEY, migratedAt: null }, selectedEntryKeys: [] };
}

/** Old IDs become entries only when a player from the current response proves their context. */
export function migrateLegacyWatchlist(raw: string | null, currentPlayers: readonly Player[], context: WatchContext, now = new Date().toISOString()): WatchlistEnvelope {
  const envelope = emptyWatchlist();
  let ids: unknown = [];
  try { ids = raw ? JSON.parse(raw) : []; } catch { return envelope; }
  if (!Array.isArray(ids)) return envelope;
  const byId = new Map(currentPlayers.map((player) => [player.id, player]));
  for (const id of [...new Set(ids)]) {
    if (!Number.isSafeInteger(id) || id <= 0) continue;
    const player = byId.get(id);
    if (player) envelope.entries.push(entryFromPlayer(player, context, now));
    else envelope.unresolvedLegacyIds.push(id);
  }
  envelope.migration.migratedAt = now;
  return envelope;
}

export function parseWatchlist(raw: string | null): WatchlistEnvelope | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object") return null;
    const candidate = value as Partial<WatchlistEnvelope>;
    if (candidate.version !== 2 || !Array.isArray(candidate.entries) || !Array.isArray(candidate.unresolvedLegacyIds)) return null;
    const entries = [...new Map(candidate.entries.filter(validEntry).map((entry) => [entry.key, entry])).values()];
    const entryKeys = new Set(entries.map((entry) => entry.key));
    return { version: 2, entries, unresolvedLegacyIds: [...new Set(candidate.unresolvedLegacyIds.filter((id): id is number => Number.isSafeInteger(id) && id > 0))], migration: candidate.migration?.legacyKey === LEGACY_WATCHLIST_KEY ? { legacyKey: LEGACY_WATCHLIST_KEY, migratedAt: typeof candidate.migration.migratedAt === "string" ? candidate.migration.migratedAt : null } : { legacyKey: LEGACY_WATCHLIST_KEY, migratedAt: null }, selectedEntryKeys: Array.isArray(candidate.selectedEntryKeys) ? [...new Set(candidate.selectedEntryKeys.filter((key): key is string => typeof key === "string" && entryKeys.has(key)))].slice(0, 2) : [] };
  } catch { return null; }
}

export function readWatchlist(currentPlayers: readonly Player[], context: WatchContext): WatchlistEnvelope {
  if (typeof window === "undefined") return emptyWatchlist();
  try {
    const existing = parseWatchlist(window.localStorage.getItem(WATCHLIST_KEY));
    return existing ?? migrateLegacyWatchlist(window.localStorage.getItem(LEGACY_WATCHLIST_KEY), currentPlayers, context);
  } catch { return emptyWatchlist(); }
}

export function writeWatchlist(envelope: WatchlistEnvelope): boolean {
  if (typeof window === "undefined") return false;
  try { window.localStorage.setItem(WATCHLIST_KEY, JSON.stringify(envelope)); return true; } catch { return false; }
}

export function removeWatchlistEntry(envelope: WatchlistEnvelope, key: string): WatchlistEnvelope {
  return { ...envelope, entries: envelope.entries.filter((entry) => entry.key !== key), selectedEntryKeys: envelope.selectedEntryKeys.filter((selected) => selected !== key) };
}

/** Promote legacy IDs only when the latest received page proves their player and context. */
export function resolveUnresolvedLegacyIds(envelope: WatchlistEnvelope, currentPlayers: readonly Player[], context: WatchContext, now = new Date().toISOString()): WatchlistEnvelope {
  if (!envelope.unresolvedLegacyIds.length) return envelope;
  const byId = new Map(currentPlayers.map((player) => [player.id, player]));
  const existingKeys = new Set(envelope.entries.map((entry) => entry.key));
  const entries = [...envelope.entries];
  const unresolvedLegacyIds: number[] = [];
  for (const id of envelope.unresolvedLegacyIds) {
    const player = byId.get(id);
    if (!player) { unresolvedLegacyIds.push(id); continue; }
    const key = watchlistKey(player.id, context);
    if (!existingKeys.has(key)) { entries.push(entryFromPlayer(player, context, now)); existingKeys.add(key); }
  }
  if (unresolvedLegacyIds.length === envelope.unresolvedLegacyIds.length) return envelope;
  const selectedEntryKeys = envelope.selectedEntryKeys.filter((key) => existingKeys.has(key)).slice(0, 2);
  return { ...envelope, entries, unresolvedLegacyIds, selectedEntryKeys };
}

/** Selection belongs to entry keys (not ephemeral row IDs) and is capped at two. */
export function toggleWatchlistSelection(envelope: WatchlistEnvelope, key: string): WatchlistEnvelope {
  if (envelope.selectedEntryKeys.includes(key)) return { ...envelope, selectedEntryKeys: envelope.selectedEntryKeys.filter((selected) => selected !== key) };
  if (envelope.selectedEntryKeys.length >= 2) return envelope;
  return { ...envelope, selectedEntryKeys: [...envelope.selectedEntryKeys, key] };
}
