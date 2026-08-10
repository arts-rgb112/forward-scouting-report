import type { Player, SortKey } from "./types";
export const normalizeText = (value: string) => value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase().trim();
export function derivePositions(players: readonly Player[]): string[] { return ["ALL", ...Array.from(new Set(players.map((player) => player.position))).sort()]; }
type FilterOptions = { query: string; role: string; sort: SortKey; watchOnly: boolean; watchlistIds: readonly number[] };
export function filterAndSortPlayers(players: readonly Player[], options: FilterOptions): Player[] {
  const needle = normalizeText(options.query); const watched = new Set(options.watchlistIds);
  return players.filter((player) => {
    const haystack = normalizeText([player.name, player.club.name, player.league.name, player.nation?.name ?? "", player.position, player.archetype].join(" "));
    return (options.role === "ALL" || player.position === options.role) && (!needle || haystack.includes(needle)) && (!options.watchOnly || watched.has(player.id));
  }).sort((a, b) => options.sort === "score" ? b.score - a.score : options.sort === "age" ? (a.age === null ? 1 : b.age === null ? -1 : a.age - b.age) : a.name.localeCompare(b.name));
}
