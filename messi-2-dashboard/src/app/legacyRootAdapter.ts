import { duelPressCompareHref, type CompareSide } from "../dashboard/duelPressCompareUrl";
import { datasetHref } from "../dashboard/datasetRoute";

const season = (value: string | null) => value && /^\d{2}\/\d{2}$/.test(value) ? `20${value.slice(0, 2)}/20${value.slice(3)}` : value && /^20\d{2}\/20\d{2}$/.test(value) ? value : null;
function side(query: URLSearchParams, prefix: "left" | "right"): CompareSide | null {
  const playerId = Number(query.get(`${prefix}_player`) ?? query.get(`${prefix}PlayerId`)); const value = season(query.get(`${prefix}_season`) ?? query.get(`${prefix}Season`)); const mode = query.get(`${prefix}_mode`) ?? query.get(`${prefix}Mode`); const taxonomy = query.get(`${prefix}_taxonomy`) ?? query.get(`${prefix}Taxonomy`) ?? "legacy-v1";
  const scopeRaw = query.get(`${prefix}_scope`) ?? query.get(`${prefix}Scope`); const competition = query.get(`${prefix}_competition`) ?? query.get(`${prefix}Competition`) ?? "all";
  if (!value || !Number.isSafeInteger(playerId) || playerId <= 0 || (taxonomy !== "legacy-v1" && taxonomy !== "duel-press-v1")) return null;
  if (mode === "europe") return ["all", "ucl", "uel", "uecl"].includes(competition) ? { playerId, taxonomy, context: { season: value, mode, scope: null, competition: competition as "all" | "ucl" | "uel" | "uecl" } } : null;
  const scope = Number(scopeRaw); return [3, 5, 7, 8].includes(scope) ? { playerId, taxonomy, context: { season: value, mode: "league", scope: scope as 3 | 5 | 7 | 8, competition: "all" } } : null;
}
/** Converts recognised Streamlit root deep links to native paths; invalid links recover at native compare. */
export function legacyRootAdapter(search: string): string | null {
  const query = new URLSearchParams(search); const page = query.get("page"); if (!page) return null;
  if (page === "about") return "/about/messi";
  if (page === "compare") { const left = side(query, "left"); const right = side(query, "right"); return left && right ? duelPressCompareHref(left, right) : "/compare?recovery=invalid-legacy-link"; }
  if (page === "detail") {
    const playerId = Number(query.get("player")); const value = season(query.get("season")); const mode = query.get("mode") === "europe" ? "europe" : "league";
    if (!Number.isSafeInteger(playerId) || playerId <= 0 || !value) return "/?recovery=invalid-legacy-link";
    if (mode === "europe") { const competition = query.get("competition") ?? "all"; return ["all", "ucl", "uel", "uecl"].includes(competition) ? datasetHref(`/players/${playerId}`, { season: value, mode, scope: 8, competition: competition as "all" | "ucl" | "uel" | "uecl" }) : `/?recovery=invalid-legacy-link`; }
    const scope = Number(query.get("scope")); return [3, 5, 7, 8].includes(scope) ? datasetHref(`/players/${playerId}`, { season: value, mode, scope: scope as 3 | 5 | 7 | 8, competition: "all" }) : `/?recovery=invalid-legacy-link`;
  }
  return "/?recovery=invalid-legacy-link";
}
