import type { ResolvedWatchlistEntry } from "../api/watchlistResolveApi";
import type { DatasetRouteState, MetricKey, SortState, Player, Tier } from "./types";
import type { WatchlistEntry, WatchlistSnapshot } from "./watchlistStorage";

export const WATCHLIST_PAGE_SIZE = 50;
export type WatchlistProfile = {
  name: string; position: string; clubName: string; leagueName?: string; face?: string | null;
  archetype?: Player["archetype"]; age?: number | null; minutes?: number; score?: number; tier?: Tier;
  stats?: Partial<Record<MetricKey, number>>;
};
export type WatchlistRow = {
  key: string; entry: WatchlistEntry; player?: Player; profile: WatchlistProfile;
  source: "current" | "snapshot" | "legacy-partial"; status?: ResolvedWatchlistEntry["status"];
};
export type WatchlistFilters = { query: string; role: string; position: string; sort: SortState };

export function datasetStateFromWatchlistEntry(entry: WatchlistEntry): DatasetRouteState {
  return entry.context.mode === "league"
    ? { season: entry.context.season, mode: "league", scope: entry.context.scope ?? 7, competition: "all" }
    : { season: entry.context.season, mode: "europe", scope: 7, competition: entry.context.competition ?? "all" };
}

export function watchlistContextLabel(entry: WatchlistEntry): string {
  return entry.context.mode === "league"
    ? `${entry.context.season} · League · ${entry.context.scope} leagues`
    : `${entry.context.season} · Europe · ${(entry.context.competition ?? "all").toUpperCase()}`;
}

function profileFromSnapshot(snapshot: WatchlistSnapshot): WatchlistProfile {
  return {
    name: snapshot.name, position: snapshot.position, clubName: snapshot.clubName, leagueName: snapshot.leagueName,
    face: snapshot.face, archetype: snapshot.archetype, age: snapshot.age, minutes: snapshot.minutes,
    score: snapshot.score, tier: snapshot.tier, stats: snapshot.stats,
  };
}
function profileFromPlayer(player: Player): WatchlistProfile {
  return {
    name: player.name, position: player.position, clubName: player.club.name, leagueName: player.league.name,
    face: player.face, archetype: player.archetype, age: player.age, minutes: player.minutes,
    score: player.score, tier: player.tier, stats: player.stats,
  };
}

export function watchlistRows(entries: readonly WatchlistEntry[], resolved: Readonly<Record<string, ResolvedWatchlistEntry>>): WatchlistRow[] {
  return entries.map((entry) => {
    const current = resolved[entry.key];
    // Only an exact-key, well-formed resolved player is current server data. Every other
    // response state falls back to the immutable browser-owned snapshot.
    if (current?.status === "resolved" && current.player) return { key: entry.key, entry, player: current.player, profile: profileFromPlayer(current.player), source: "current", status: current.status };
    return { key: entry.key, entry, profile: profileFromSnapshot(entry.snapshot), source: entry.snapshot.profile === "complete" ? "snapshot" : "legacy-partial", status: current?.status };
  });
}

const text = (value: string | undefined) => value?.toLocaleLowerCase() ?? "";
const compareNullable = (left: number | null | undefined, right: number | null | undefined, direction: "asc" | "desc") => {
  if (left == null && right == null) return 0;
  if (left == null) return 1;
  if (right == null) return -1;
  return direction === "asc" ? left - right : right - left;
};

/** Local-only filtering: roles are archetypes, while position comes from the saved/current context row. */
export function filterAndSortWatchlistRows(rows: readonly WatchlistRow[], filters: WatchlistFilters): WatchlistRow[] {
  const needle = filters.query.trim().toLocaleLowerCase();
  const filtered = rows.filter((row) => {
    const profile = row.profile;
    const searchable = [profile.name, profile.clubName, profile.leagueName, profile.position].map(text).join(" ");
    if (needle && !searchable.includes(needle)) return false;
    if (filters.role !== "ALL" && profile.archetype !== filters.role) return false;
    return filters.position === "ALL" || profile.position === filters.position;
  });
  // Array.sort is stable in supported browsers; preserve the incoming storage order on ties.
  return filtered.map((row, index) => ({ row, index })).sort((left, right) => {
    const a = left.row.profile; const b = right.row.profile;
    let comparison: number;
    if (filters.sort.key === "name") comparison = a.name.localeCompare(b.name) * (filters.sort.direction === "asc" ? 1 : -1);
    else if (filters.sort.key === "age") comparison = compareNullable(a.age, b.age, filters.sort.direction);
    else comparison = compareNullable(filters.sort.key === "score" ? a.score : a.stats?.[filters.sort.key], filters.sort.key === "score" ? b.score : b.stats?.[filters.sort.key], filters.sort.direction);
    return comparison || left.index - right.index;
  }).map(({ row }) => row);
}

export function watchlistPage(rows: readonly WatchlistRow[], page: number) {
  const totalPages = Math.max(1, Math.ceil(rows.length / WATCHLIST_PAGE_SIZE));
  const safePage = Math.min(Math.max(1, page), totalPages);
  return { page: safePage, totalPages, rows: rows.slice((safePage - 1) * WATCHLIST_PAGE_SIZE, safePage * WATCHLIST_PAGE_SIZE) };
}
