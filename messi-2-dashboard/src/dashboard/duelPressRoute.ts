import { DUEL_PRESS_METRIC_KEYS, type DuelPressSortKey } from "../api/duelPressTypes";
export const DUEL_PRESS_PAGE_SIZE = 50;
const sorts: readonly DuelPressSortKey[] = ["score", ...DUEL_PRESS_METRIC_KEYS];
export type DuelPressRouteSearch = { page: number; pageSize: 50; sort: DuelPressSortKey; order: "asc" | "desc" };
export function duelPressSearchFromUrl(search: string): DuelPressRouteSearch {
  const query = new URLSearchParams(search); const rawSort = query.get("sort");
  if (rawSort !== null && !sorts.includes(rawSort as DuelPressSortKey)) return { page: 1, pageSize: 50, sort: "score", order: "desc" };
  const page = Number(query.get("page"));
  return { page: Number.isSafeInteger(page) && page > 0 ? page : 1, pageSize: 50, sort: (rawSort ?? "score") as DuelPressSortKey, order: query.get("direction") === "asc" ? "asc" : "desc" };
}
