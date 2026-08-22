import type { Player, SortKey, SortState } from "./types";
import { textComparisonKey } from "./textComparisonKey";

/** @deprecated Prefer textComparisonKey for explicit local-only comparisons. */
export const normalizeText = textComparisonKey;
export function derivePositions(players: readonly Player[]): string[] { return ["ALL", ...Array.from(new Set(players.map((player) => player.position))).sort()]; }
type FilterOptions = { query: string; role: string; sort: SortState | SortKey; watchOnly: boolean; watchlistIds: readonly number[] };
export function filterAndSortPlayers(players: readonly Player[], options: FilterOptions): Player[] {
  const sort = typeof options.sort === "string" ? { key: options.sort, direction: options.sort === "name" || options.sort === "age" ? "asc" as const : "desc" as const } : options.sort;
  const needle = normalizeText(options.query); const watched = new Set(options.watchlistIds);
  return players.filter((player) => {
    const haystack = normalizeText([player.name, player.club.name, player.league.name, player.nation?.name ?? "", player.position, player.archetype].join(" "));
    return (options.role === "ALL" || player.position === options.role) && (!needle || haystack.includes(needle)) && (!options.watchOnly || watched.has(player.id));
  }).sort((a, b) => {
    const value = (player: Player) => sort.key === "score" ? player.score : sort.key === "age" ? player.age ?? Number.POSITIVE_INFINITY : sort.key === "name" ? player.name : player.stats[sort.key];
    const av = value(a); const bv = value(b);
    const compared = typeof av === "string" && typeof bv === "string" ? av.localeCompare(bv) : Number(av) - Number(bv);
    if (compared) return sort.direction === "asc" ? compared : -compared;
    return a.rank - b.rank || a.name.localeCompare(b.name);
  });
}
