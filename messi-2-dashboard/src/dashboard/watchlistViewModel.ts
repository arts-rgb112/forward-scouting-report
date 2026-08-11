import type { ResolvedWatchlistEntry } from "../api/watchlistResolveApi";
import type { DatasetRouteState, SortState, Player } from "./types";
import type { WatchlistEntry } from "./watchlistStorage";

export const WATCHLIST_PAGE_SIZE = 50;
export type WatchlistRow = { key: string; entry: WatchlistEntry; player?: Player; status?: ResolvedWatchlistEntry["status"] };
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

export function watchlistRows(entries: readonly WatchlistEntry[], resolved: Readonly<Record<string, ResolvedWatchlistEntry>>): WatchlistRow[] {
  return entries.map((entry) => {
    const current = resolved[entry.key];
    return { key: entry.key, entry, player: current?.player, status: current?.status };
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
    const player = row.player;
    const searchable = [player?.name ?? row.entry.snapshot.name, player?.club.name ?? row.entry.snapshot.clubName, player?.league.name ?? row.entry.snapshot.leagueName, player?.position ?? row.entry.snapshot.position].map(text).join(" ");
    if (needle && !searchable.includes(needle)) return false;
    if (filters.role !== "ALL" && player?.archetype !== filters.role) return false;
    return filters.position === "ALL" || (player?.position ?? row.entry.snapshot.position) === filters.position;
  });
  return [...filtered].sort((left, right) => {
    const a = left.player; const b = right.player;
    if (filters.sort.key === "name") return (a?.name ?? left.entry.snapshot.name).localeCompare(b?.name ?? right.entry.snapshot.name) * (filters.sort.direction === "asc" ? 1 : -1);
    if (filters.sort.key === "age") return compareNullable(a?.age, b?.age, filters.sort.direction);
    const aValue = filters.sort.key === "score" ? (a?.score ?? left.entry.snapshot.score) : a?.stats[filters.sort.key];
    const bValue = filters.sort.key === "score" ? (b?.score ?? right.entry.snapshot.score) : b?.stats[filters.sort.key];
    return compareNullable(aValue, bValue, filters.sort.direction);
  });
}

export function watchlistPage(rows: readonly WatchlistRow[], page: number) {
  const totalPages = Math.max(1, Math.ceil(rows.length / WATCHLIST_PAGE_SIZE));
  const safePage = Math.min(Math.max(1, page), totalPages);
  return { page: safePage, totalPages, rows: rows.slice((safePage - 1) * WATCHLIST_PAGE_SIZE, safePage * WATCHLIST_PAGE_SIZE) };
}
