import type { AgeBand, DatasetRouteState, LeaderboardSearch, LeagueScope, MinutesBand, SortKey } from "./types";

export const PAGE_SIZE = 50;
/** Query keys owned by the native leaderboard route. Everything else belongs to the caller. */
export const dashboardQueryKeys = new Set(["season", "mode", "scope", "competition", "page", "pageSize", "q", "role", "position", "ageBand", "minutesBand", "sort", "direction", "taxonomy", "recovery"]);
export const positionFilterValues = ["Attacking Midfielder", "Center Back", "Central Midfielder", "Defensive Midfielder", "Left Back", "Left Midfielder", "Left Wing-Back", "Left Winger", "Right Back", "Right Midfielder", "Right Wing-Back", "Right Winger", "Striker", "forward"] as const;
const sortKeys: readonly SortKey[] = ["score", "name", "age", "outsideShot", "boxThreat", "dangerZone", "aerial", "groundDuel", "spaceControl"];
export const defaultLeaderboardSearch: LeaderboardSearch = { page: 1, pageSize: PAGE_SIZE, q: "", role: "all", position: "ALL", ageBand: "all", minutesBand: "all", sort: "score", direction: "desc" };
const ageBands: readonly AgeBand[] = ["all", "u23", "23-25", "26-30", "31-plus"];
const minutesBands: readonly MinutesBand[] = ["all", "200-499", "500-999", "1000-1499", "1500-1999", "2000-2999", "3000-plus"];

const isScope = (value: number): value is LeagueScope => [3, 5, 7, 8].includes(value);
const isCompetition = (value: string | null): value is DatasetRouteState["competition"] =>
  value === "all" || value === "ucl" || value === "uel" || value === "uecl";
export const isPositionFilterValue = (value: string): value is (typeof positionFilterValues)[number] =>
  positionFilterValues.includes(value as (typeof positionFilterValues)[number]);

/** Identifies the server dataset independently from its current leaderboard view. */
export function datasetKeyOf(state: DatasetRouteState): string {
  const competition = typeof state.competition === "string" && state.competition.trim() ? state.competition.trim() : "all";
  return JSON.stringify([state.season, state.mode, state.scope, competition]);
}

export function datasetFromSearch(search: string, fallback: DatasetRouteState): DatasetRouteState {
  const query = new URLSearchParams(search);
  const mode = query.get("mode") === "europe" ? "europe" : "league";
  const competition = query.get("competition");
  return {
    season: query.get("season") || fallback.season,
    mode,
    // Route defaults are product policy, not an environment cohort setting.
    scope: isScope(Number(query.get("scope"))) ? Number(query.get("scope")) as LeagueScope : 8,
    competition: isCompetition(competition) ? competition : "all",
  };
}

export function pageFromSearch(search: string): number {
  const value = Number(new URLSearchParams(search).get("page"));
  return Number.isSafeInteger(value) && value > 0 ? value : 1;
}

export function leaderboardSearchFromSearch(search: string): LeaderboardSearch {
  const query = new URLSearchParams(search);
  const sort = query.get("sort");
  const role = query.get("role");
  const ageBand = query.get("ageBand");
  const minutesBand = query.get("minutesBand");
  return {
    page: pageFromSearch(search), pageSize: PAGE_SIZE,
    q: (query.get("q") ?? "").trim().slice(0, 100), role: role === "Type A" || role === "Type B" ? role : "all", position: isPositionFilterValue((query.get("position") ?? "").trim()) ? (query.get("position") ?? "").trim() : "ALL",
    ageBand: ageBands.includes(ageBand as AgeBand) ? ageBand as AgeBand : "all", minutesBand: minutesBands.includes(minutesBand as MinutesBand) ? minutesBand as MinutesBand : "all",
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
  query.set("page", String(search.page)); query.set("pageSize", String(PAGE_SIZE));
  if (search.q) query.set("q", search.q);
  query.set("sort", search.sort); query.set("direction", search.direction);
  if (search.role !== "all") query.set("role", search.role);
  if (search.position !== "ALL") query.set("position", search.position);
  if (search.ageBand !== "all") query.set("ageBand", search.ageBand);
  if (search.minutesBand !== "all") query.set("minutesBand", search.minutesBand);
  return `/?${query.toString()}`;
}

/** Rewrites native state without dropping attribution, click-id, or debugger query parameters. */
export function preserveExternalQuery(route: string, currentSearch: string, ownedKeys: ReadonlySet<string> = dashboardQueryKeys): string {
  const target = new URL(route, "https://messi.invalid");
  for (const [key, value] of new URLSearchParams(currentSearch)) {
    if (!ownedKeys.has(key)) target.searchParams.append(key, value);
  }
  return `${target.pathname}${target.search}`;
}
