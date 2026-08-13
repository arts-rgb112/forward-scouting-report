import type { DatasetRouteState, MetricKey, Player, Tier } from "./types";

/** The former ID-only key is deliberately read-only: never overwrite it. */
export const LEGACY_WATCHLIST_KEY = "messi-2-watchlist";
export const WATCHLIST_KEY = "messi-2-watchlist:v2";

export type WatchContext = {
  season: string;
  mode: "league" | "europe";
  scope: 3 | 5 | 7 | null;
  competition: "all" | "ucl" | "uel" | "uecl" | null;
};
export type WatchlistSnapshot = {
  /** Summary-only V2 entries remain usable, but are deliberately not presented as full profiles. */
  profile?: "complete" | "legacy-partial";
  name: string;
  position: string;
  clubName: string;
  leagueName?: string;
  face?: string | null;
  score?: number;
  tierLabel?: string;
  archetype?: Player["archetype"];
  age?: number | null;
  minutes?: number;
  tier?: Tier;
  /** Written only when the source response explicitly declares a taxonomy version. */
  tierTaxonomyVersion?: string;
  stats?: Partial<Record<MetricKey, number>>;
};
export type WatchlistEntry = {
  version: 2;
  key: string;
  namespace: "fotmob";
  playerId: number;
  snapshot: WatchlistSnapshot;
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
const metricNames: readonly MetricKey[] = ["outsideShot", "boxThreat", "dangerZone", "aerial", "groundDuel", "spaceControl"];
const validTier = (value: unknown): value is Tier => {
  if (!value || typeof value !== "object") return false;
  const tier = value as Record<string, unknown>;
  return typeof tier.code === "string" && typeof tier.level === "number" && typeof tier.label === "string";
};
const validCompleteSnapshot = (snapshot: Record<string, unknown>): boolean =>
  (snapshot.profile === "complete" || snapshot.profile === undefined)
  && (snapshot.archetype === "Type A" || snapshot.archetype === "Type B")
  && (typeof snapshot.age === "number" || snapshot.age === null)
  && typeof snapshot.minutes === "number"
  && typeof snapshot.score === "number"
  && validTier(snapshot.tier)
  && Boolean(snapshot.stats && typeof snapshot.stats === "object" && metricNames.every((key) => typeof (snapshot.stats as Record<string, unknown>)[key] === "number"));
const normalizeSnapshot = (value: unknown): WatchlistSnapshot | null => {
  if (!value || typeof value !== "object") return null;
  const snapshot = value as Record<string, unknown>;
  if (typeof snapshot.name !== "string" || typeof snapshot.position !== "string" || typeof snapshot.clubName !== "string") return null;
  const complete = validCompleteSnapshot(snapshot);
  const stats = snapshot.stats && typeof snapshot.stats === "object"
    ? Object.fromEntries(metricNames.filter((key) => typeof (snapshot.stats as Record<string, unknown>)[key] === "number").map((key) => [key, (snapshot.stats as Record<string, number>)[key]]))
    : undefined;
  return {
    profile: complete ? "complete" : "legacy-partial",
    name: snapshot.name, position: snapshot.position, clubName: snapshot.clubName,
    ...(typeof snapshot.leagueName === "string" ? { leagueName: snapshot.leagueName } : {}),
    ...(typeof snapshot.face === "string" || snapshot.face === null ? { face: snapshot.face } : {}),
    ...(typeof snapshot.score === "number" ? { score: snapshot.score } : {}),
    ...(typeof snapshot.tierLabel === "string" ? { tierLabel: snapshot.tierLabel } : {}),
    ...(snapshot.archetype === "Type A" || snapshot.archetype === "Type B" ? { archetype: snapshot.archetype } : {}),
    ...(typeof snapshot.age === "number" || snapshot.age === null ? { age: snapshot.age } : {}),
    ...(typeof snapshot.minutes === "number" ? { minutes: snapshot.minutes } : {}),
    ...(validTier(snapshot.tier) ? { tier: { ...snapshot.tier } } : {}),
    ...(typeof snapshot.tierTaxonomyVersion === "string" ? { tierTaxonomyVersion: snapshot.tierTaxonomyVersion } : {}),
    ...(stats ? { stats } : {}),
  };
};
const validEntry = (value: unknown): value is WatchlistEntry => {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  return entry.version === 2 && entry.namespace === "fotmob" && Number.isSafeInteger(entry.playerId) && typeof entry.key === "string" && typeof entry.savedAt === "string" && validContext(entry.context) && Boolean(normalizeSnapshot(entry.snapshot));
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
  return {
    version: 2, key: watchlistKey(player.id, context), namespace: "fotmob", playerId: player.id,
    // Copy every nested value so later player-state changes cannot mutate the stored context.
    snapshot: {
      profile: "complete", name: player.name, position: player.position, archetype: player.archetype,
      age: player.age, minutes: player.minutes, score: player.score, tier: { ...player.tier }, tierLabel: player.tier.label,
      ...(player.tier.taxonomyVersion ? { tierTaxonomyVersion: player.tier.taxonomyVersion } : {}),
      face: player.face, clubName: player.club.name, leagueName: player.league.name, stats: { ...player.stats },
    },
    context: { ...context }, savedAt,
  };
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
    const entries = [...new Map(candidate.entries.filter(validEntry).map((entry) => {
      const snapshot = normalizeSnapshot(entry.snapshot);
      return [entry.key, { ...entry, context: { ...entry.context }, snapshot: snapshot! } satisfies WatchlistEntry];
    })).values()];
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
