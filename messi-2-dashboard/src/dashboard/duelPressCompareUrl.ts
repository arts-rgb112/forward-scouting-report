import type { DuelPressModeContext } from "../api/duelPressTypes";
export type CompareSide = { playerId: number; taxonomy: "legacy-v1" | "duel-press-v1"; context: DuelPressModeContext };
const writeSide = (query: URLSearchParams, prefix: "left" | "right", side: CompareSide) => {
  query.set(`${prefix}PlayerId`, String(side.playerId)); query.set(`${prefix}Taxonomy`, side.taxonomy);
  query.set(`${prefix}Season`, side.context.season); query.set(`${prefix}Mode`, side.context.mode);
  query.set(`${prefix}Scope`, side.context.scope === null ? "null" : String(side.context.scope)); query.set(`${prefix}Competition`, side.context.competition);
};
export function duelPressCompareHref(left: CompareSide, right: CompareSide): string { const query = new URLSearchParams(); writeSide(query, "left", left); writeSide(query, "right", right); return `/compare?${query}`; }
const readSide = (query: URLSearchParams, prefix: "left" | "right"): CompareSide | null => {
  const playerId = Number(query.get(`${prefix}PlayerId`)); const taxonomy = query.get(`${prefix}Taxonomy`); const season = query.get(`${prefix}Season`) ?? ""; const mode = query.get(`${prefix}Mode`); const scopeRaw = query.get(`${prefix}Scope`); const competition = query.get(`${prefix}Competition`);
  if (!Number.isSafeInteger(playerId) || playerId <= 0 || (taxonomy !== "legacy-v1" && taxonomy !== "duel-press-v1") || !/^\d{4}\/\d{4}$/.test(season)) return null;
  if (mode === "league") { const scope = Number(scopeRaw); if (![3, 5, 7, 8].includes(scope) || competition !== "all") return null; return { playerId, taxonomy, context: { season, mode, scope: scope as 3 | 5 | 7 | 8, competition: "all" } }; }
  if (mode === "europe" && scopeRaw === "null" && (competition === "all" || competition === "ucl" || competition === "uel" || competition === "uecl")) return { playerId, taxonomy, context: { season, mode, scope: null, competition } };
  return null;
};
export function parseDuelPressCompare(search: string): { left: CompareSide; right: CompareSide } | null { const query = new URLSearchParams(search); const left = readSide(query, "left"); const right = readSide(query, "right"); return left && right ? { left, right } : null; }
