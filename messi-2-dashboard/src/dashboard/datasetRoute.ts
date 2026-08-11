import type { DatasetRouteState, LeaderboardSearch, SortKey } from "./types";

export const PAGE_SIZE = 50;
const sortKeys: readonly SortKey[] = ["score", "name", "age", "outsideShot", "boxThreat", "dangerZone", "aerial", "groundDuel", "spaceControl"];
export const defaultLeaderboardSearch: LeaderboardSearch = { page: 1, pageSize: PAGE_SIZE, q: "", role: "all", sort: "score", direction: "desc" };

const isScope = (value: number): value is 3 | 5 | 7 => [3, 5, 7].includes(value);
const isCompetition = (value: string | null): value is DatasetRouteState["competition"] =>
  value === "all" || value === "ucl" || value === "uel" || value === "uecl";

export function datasetFromSearch(search: string, fallback: DatasetRouteState): DatasetRouteState {
  const query = new URLSearchParams(search);
  const mode = query.get("mode") === "europe" ? "europe" : "league";
  const competition = query.get("competition");
  return {
    season: query.get("season") || fallback.season,
    mode,
    scope: isScope(Number(query.get("scope"))) ? Number(query.get("scope")) as 3 | 5 | 7 : fallback.scope,
    competition: isCompetition(competition) ? competition : "all",
  };
}

export function pageFromSearch(search: string): number {
  const value = Number(new URLSearchParams(search).get("page"));
  return Number.isSafeInteger(value) && value > 0 ? value : 1;
}

export function leaderboardSearchFromSearch(search: string): LeaderboardSearch {
  const query = new URLSearchParams(search);
  const pageSize = Number(query.get("pageSize"));
  const sort = query.get("sort");
  const role = query.get("role");
  return {
    page: pageFromSearch(search), pageSize: Number.isSafeInteger(pageSize) && pageSize >= 1 && pageSize <= 250 ? pageSize : PAGE_SIZE,
    q: (query.get("q") ?? "").trim().slice(0, 100), role: role === "Type A" || role === "Type B" ? role : "all",
    sort: sortKeys.includes(sort as SortKey) ? sort as SortKey : defaultLeaderboardSearch.sort,
    direction: query.get("direction") === "asc" ? "asc" : "desc",
  };
}

/** Serializes only the context supported by the selected dataset mode. */
export function datasetQuery(state: DatasetRouteState): string {
  const query = new URLSearchParams({ season: state.season, mode: state.mode });
  if (state.mode === "league") query.set("scope", String(state.scope));
  else query.set("competition", state.competition);
  return query.toString();
}

export function datasetHref(path: string, state: DatasetRouteState): string {
  return `${path}?${datasetQuery(state)}`;
}

export function leaderboardHref(state: DatasetRouteState, search: LeaderboardSearch = defaultLeaderboardSearch): string {
  const query = new URLSearchParams(datasetQuery(state));
  query.set("page", String(search.page)); query.set("pageSize", String(search.pageSize));
  query.set("q", search.q); query.set("sort", search.sort); query.set("direction", search.direction);
  if (search.role !== "all") query.set("role", search.role);
  return `/?${query.toString()}`;
}
