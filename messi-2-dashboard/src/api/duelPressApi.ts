import type { DuelPressModeContext, DuelPressSortKey } from "./duelPressTypes";

export type DuelPressLeaderboardRequest = { context: DuelPressModeContext; page: number; sort: DuelPressSortKey; order: "asc" | "desc" };
const addContext = (url: URL, context: DuelPressModeContext) => {
  url.searchParams.set("season", context.season); url.searchParams.set("mode", context.mode);
  if (context.mode === "league") { url.searchParams.set("scope", String(context.scope)); url.searchParams.set("competition", "all"); }
  else url.searchParams.set("competition", context.competition);
};
export function buildDuelPressLeaderboardUrl(baseUrl: string, request: DuelPressLeaderboardRequest): string {
  const url = new URL("/api/v2/leaderboards/duel-press", baseUrl); addContext(url, request.context);
  url.searchParams.set("page", String(request.page)); url.searchParams.set("pageSize", "50"); url.searchParams.set("sort", request.sort); url.searchParams.set("order", request.order);
  return url.toString();
}
export function buildDuelPressDetailUrl(baseUrl: string, playerId: number, context: DuelPressModeContext): string {
  const url = new URL(`/api/v2/players/${playerId}/duel-press`, baseUrl); addContext(url, context); return url.toString();
}
export const duelPressFetchInit = (signal?: AbortSignal): RequestInit => ({ method: "GET", credentials: "omit", headers: { Accept: "application/json" }, signal });
export const duelPressResourceKey = (endpoint: "leaderboard" | `player:${number}`, context: DuelPressModeContext, query = "") => JSON.stringify(["duel-press-v1", endpoint, context, query]);
export type DuelPressErrorKind = "not-found" | "invalid-request" | "schema" | "network";
export class DuelPressApiError extends Error { constructor(public readonly kind: DuelPressErrorKind, message = kind) { super(message); this.name = "DuelPressApiError"; } }
export const duelPressStatusError = (status: number) => new DuelPressApiError(status === 404 ? "not-found" : status === 422 ? "invalid-request" : "network");
