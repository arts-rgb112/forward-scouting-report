import { duelPressCompareHref, type CompareSide } from "../dashboard/duelPressCompareUrl";
import { dashboardQueryKeys, datasetHref, preserveExternalQuery } from "../dashboard/datasetRoute";

const rootRecovery = "/?recovery=invalid-legacy-link";
const compareRecovery = "/compare?recovery=invalid-legacy-link";
const legacyKeys = new Set(["page", "player", "left_player", "left_season", "left_mode", "left_scope", "left_competition", "right_player", "right_season", "right_mode", "right_scope", "right_competition", "playerId", "leftPlayerId", "rightPlayerId", "leftSeason", "rightSeason", "leftMode", "rightMode", "leftScope", "rightScope", "leftCompetition", "rightCompetition", "Recovery"]);
const legacyOwnedKeys = new Set([...dashboardQueryKeys, ...legacyKeys]);
const season = (value: string | null) => value && /^\d{2}\/\d{2}$/.test(value) ? `20${value.slice(0, 2)}/20${value.slice(3)}` : value && /^20\d{2}\/20\d{2}$/.test(value) ? value : null;
const value = (query: URLSearchParams, names: string[], required = false): string | null | undefined => { const values = names.flatMap((name) => query.getAll(name)); return values.length > 1 || required && values.length !== 1 ? undefined : values[0] ?? null; };
const isExternalKey = (key: string) => !dashboardQueryKeys.has(key) && !legacyKeys.has(key) && !/^(left|right)_/.test(key);
const only = (query: URLSearchParams, keys: string[]) => [...query.keys()].every((key) => keys.includes(key) || isExternalKey(key));
const terminalRecoveryQuery = (query: URLSearchParams) => query.getAll("recovery").length === 1 && query.get("recovery") === "invalid-legacy-link" && [...query.keys()].length === 1;
const nativeDashboardQuery = (query: URLSearchParams) => {
  const pages = query.getAll("page");
  return pages.length === 1 && /^[1-9]\d*$/.test(pages[0]) && [...query.keys()].every((key) => dashboardQueryKeys.has(key) || isExternalKey(key));
};

function side(query: URLSearchParams, prefix: "left" | "right"): CompareSide | null {
  const playerRaw = value(query, [`${prefix}_player`], true); const seasonRaw = value(query, [`${prefix}_season`], true); const mode = value(query, [`${prefix}_mode`], true);
  const scopeRaw = value(query, [`${prefix}_scope`]); const competitionRaw = value(query, [`${prefix}_competition`]); const taxonomy = "legacy-v1"; const competition = competitionRaw ?? "all";
  const playerId = Number(playerRaw); const contextSeason = season(seasonRaw ?? null);
  if (playerRaw === undefined || seasonRaw === undefined || mode === undefined || scopeRaw === undefined || competitionRaw === undefined || !contextSeason || !Number.isSafeInteger(playerId) || playerId <= 0) return null;
  if (mode === "europe") return scopeRaw === null && ["all", "ucl", "uel", "uecl"].includes(competition) ? { playerId, taxonomy: taxonomy as CompareSide["taxonomy"], context: { season: contextSeason, mode, scope: null, competition: competition as "all" | "ucl" | "uel" | "uecl" } } : null;
  const scope = Number(scopeRaw); return mode === "league" && [3, 5, 7, 8].includes(scope) && competition === "all" ? { playerId, taxonomy: taxonomy as CompareSide["taxonomy"], context: { season: contextSeason, mode, scope: scope as 3 | 5 | 7 | 8, competition: "all" } } : null;
}

/** Converts only unambiguous recognised Streamlit root deep links to native paths. */
export function legacyRootAdapter(search: string): string | null {
  if (search === "" || search === "?") return null;
  const query = new URLSearchParams(search); const pageValues = query.getAll("page");
  if (terminalRecoveryQuery(query)) return null;
  if (nativeDashboardQuery(query)) return null;
  if (pageValues.length !== 1) return pageValues.length === 0 && !query.has("recovery") && [...query.keys()].every((key) => dashboardQueryKeys.has(key) || isExternalKey(key)) ? null : pageValues.includes("compare") ? compareRecovery : rootRecovery;
  const page = pageValues[0];
  if (page === "about") return only(query, ["page"]) ? preserveExternalQuery("/about/messi", search, legacyOwnedKeys) : rootRecovery;
  if (page === "compare") {
    const allowed = ["page", ...["left", "right"].flatMap((prefix) => [`${prefix}_player`, `${prefix}_season`, `${prefix}_mode`, `${prefix}_scope`, `${prefix}_competition`])];
    if (!only(query, allowed)) return compareRecovery;
    const left = side(query, "left"); const right = side(query, "right"); return left && right ? preserveExternalQuery(duelPressCompareHref(left, right), search, legacyOwnedKeys) : compareRecovery;
  }
  if (page === "detail") {
    if (!only(query, ["page", "player", "season", "mode", "scope", "competition"])) return rootRecovery;
    const playerRaw = value(query, ["player"], true); const seasonRaw = value(query, ["season"], true); const mode = value(query, ["mode"], true); const scopeRaw = value(query, ["scope"]); const competitionRaw = value(query, ["competition"]); const competition = competitionRaw ?? "all";
    const playerId = Number(playerRaw); const contextSeason = season(seasonRaw ?? null);
    if (playerRaw === undefined || seasonRaw === undefined || mode === undefined || scopeRaw === undefined || competitionRaw === undefined || !contextSeason || !Number.isSafeInteger(playerId) || playerId <= 0) return rootRecovery;
    if (mode === "europe") return scopeRaw === null && ["all", "ucl", "uel", "uecl"].includes(competition) ? preserveExternalQuery(datasetHref(`/players/${playerId}`, { season: contextSeason, mode, scope: 8, competition: competition as "all" | "ucl" | "uel" | "uecl" }), search, legacyOwnedKeys) : rootRecovery;
    const scope = Number(scopeRaw); return mode === "league" && [3, 5, 7, 8].includes(scope) && competition === "all" ? preserveExternalQuery(datasetHref(`/players/${playerId}`, { season: contextSeason, mode, scope: scope as 3 | 5 | 7 | 8, competition: "all" }), search, legacyOwnedKeys) : rootRecovery;
  }
  return rootRecovery;
}
