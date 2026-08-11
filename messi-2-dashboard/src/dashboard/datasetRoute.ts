import type { DatasetRouteState } from "./types";

export const PAGE_SIZE = 50;

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

export function leaderboardHref(state: DatasetRouteState, page: number): string {
  const query = new URLSearchParams(datasetQuery(state));
  if (page > 1) query.set("page", String(page));
  return `/?${query.toString()}`;
}
