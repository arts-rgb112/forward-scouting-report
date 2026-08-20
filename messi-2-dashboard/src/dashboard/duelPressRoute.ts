import { DUEL_PRESS_METRIC_KEYS, type DuelPressSearch, type DuelPressSortKey } from "../api/duelPressTypes";
import type { DatasetRouteState } from "./types";
import { datasetQuery, isPositionFilterValue } from "./datasetRoute";
export const DUEL_PRESS_PAGE_SIZE = 50;
const sorts: readonly DuelPressSortKey[] = ["rank", "score", "name", "minutes", "age", ...DUEL_PRESS_METRIC_KEYS];
const ages = ["all", "u23", "u25", "26-30", "31-plus"] as const; const minutes = ["all", "200-499", "500-999", "1000-1499", "1500-1999", "2000-2999", "3000-plus"] as const;
export function duelPressSearchFromUrl(search: string): DuelPressSearch {
  const query = new URLSearchParams(search); const rawSort = query.get("sort");
  const base = { pageSize: 50 as const, q: (query.get("q") ?? "").trim().slice(0, 100), role: query.get("role") === "Type A" || query.get("role") === "Type B" ? query.get("role") as "Type A" | "Type B" : "all" as const, position: isPositionFilterValue(query.get("position") ?? "") ? query.get("position")! : "ALL", ageBand: ages.includes(query.get("ageBand") as typeof ages[number]) ? query.get("ageBand") as typeof ages[number] : "all" as const, minutesBand: minutes.includes(query.get("minutesBand") as typeof minutes[number]) ? query.get("minutesBand") as typeof minutes[number] : "all" as const };
  if (rawSort !== null && !sorts.includes(rawSort as DuelPressSortKey)) return { ...base, page: 1, sort: "score", direction: "desc" };
  const page = Number(query.get("page"));
  return { ...base, page: Number.isSafeInteger(page) && page > 0 ? page : 1, sort: (rawSort ?? "score") as DuelPressSortKey, direction: query.get("direction") === "asc" ? "asc" : "desc" };
}
export function duelPressLeaderboardHref(dataset: DatasetRouteState, search: DuelPressSearch): string { const query = new URLSearchParams(datasetQuery(dataset)); query.set("page", String(search.page)); query.set("pageSize", "50"); query.set("sort", search.sort); query.set("direction", search.direction); if (search.q) query.set("q", search.q); if (search.role !== "all") query.set("role", search.role); if (search.position !== "ALL") query.set("position", search.position); if (search.ageBand !== "all") query.set("ageBand", search.ageBand); if (search.minutesBand !== "all") query.set("minutesBand", search.minutesBand); return `/?${query}`; }
export function duelPressDetailHref(playerId: number, dataset: DatasetRouteState): string {
  const query = new URLSearchParams(datasetQuery(dataset));
  query.set("taxonomy", "duel-press-v1");
  return `/players/${playerId}?${query}`;
}
