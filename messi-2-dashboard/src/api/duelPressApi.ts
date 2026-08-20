import { duelPressDetailCoreSchema, duelPressLeaderboardCoreSchema } from "./duelPressContracts";
import { adaptDuelPressPlayerCore } from "./duelPressAdapter";
import type { MessiApiConfig } from "./env";
import type { DuelPressLeaderboardPayload, DuelPressModeContext, DuelPressSearch, DuelPressSortKey } from "./duelPressTypes";

export type DuelPressLeaderboardRequest = { context: DuelPressModeContext; page: number; sort: DuelPressSortKey; order: "asc" | "desc" };
const positiveSafe = (value: number, label: string) => { if (!Number.isSafeInteger(value) || value <= 0) throw new DuelPressApiError("invalid-request", `${label} must be a positive safe integer`); };
const addContext = (url: URL, context: DuelPressModeContext) => {
  url.searchParams.set("season", context.season); url.searchParams.set("mode", context.mode);
  if (context.mode === "league") { url.searchParams.set("scope", String(context.scope)); url.searchParams.set("competition", "all"); }
  else url.searchParams.set("competition", context.competition);
};
export function buildDuelPressLeaderboardUrl(baseUrl: string, request: DuelPressLeaderboardRequest): string {
  positiveSafe(request.page, "page");
  const url = new URL("/api/v2/leaderboards/duel-press", baseUrl); addContext(url, request.context);
  url.searchParams.set("page", String(request.page)); url.searchParams.set("pageSize", "50"); url.searchParams.set("sort", request.sort); url.searchParams.set("order", request.order);
  return url.toString();
}
export function buildDuelPressDetailUrl(baseUrl: string, playerId: number, context: DuelPressModeContext): string {
  positiveSafe(playerId, "playerId");
  const url = new URL(`/api/v2/players/${playerId}/duel-press`, baseUrl); addContext(url, context); return url.toString();
}
export const duelPressFetchInit = (signal?: AbortSignal): RequestInit => ({ method: "GET", credentials: "omit", headers: { Accept: "application/json" }, signal });
export const duelPressResourceKey = (endpoint: "leaderboard" | `player:${number}`, context: DuelPressModeContext, query = "") => JSON.stringify(["duel-press-v1", endpoint, context, query]);
export type DuelPressErrorKind = "not-found" | "invalid-request" | "schema" | "network";
export class DuelPressApiError extends Error { constructor(public readonly kind: DuelPressErrorKind, message: string = kind) { super(message); this.name = "DuelPressApiError"; } }
export const duelPressStatusError = (status: number) => new DuelPressApiError(status === 404 ? "not-found" : status === 422 ? "invalid-request" : "network");
async function getJson(url: string, signal: AbortSignal): Promise<unknown> {
  let response: Response; try { response = await fetch(url, duelPressFetchInit(signal)); } catch (cause) { if (signal.aborted) throw cause; throw new DuelPressApiError("network", "Unable to reach the M.E.S.S.I. API"); }
  if (!response.ok) throw duelPressStatusError(response.status);
  try { return await response.json(); } catch { throw new DuelPressApiError("schema", "Response was not valid JSON"); }
}
const requestContext = (state: import("../dashboard/types").DatasetRouteState): DuelPressModeContext => state.mode === "league" ? { season: state.season, mode: "league", scope: state.scope, competition: "all" } : { season: state.season, mode: "europe", scope: null, competition: state.competition };
export async function fetchDuelPressLeaderboard(config: MessiApiConfig, state: import("../dashboard/types").DatasetRouteState, search: DuelPressSearch, signal: AbortSignal): Promise<DuelPressLeaderboardPayload> {
  const context = requestContext(state); const url = new URL(buildDuelPressLeaderboardUrl(config.baseUrl, { context, page: search.page, sort: search.sort, order: search.direction }));
  if (search.q) url.searchParams.set("q", search.q); if (search.role !== "all") url.searchParams.set("role", search.role); if (search.position !== "ALL") url.searchParams.set("position", search.position); if (search.ageBand !== "all") url.searchParams.set("ageBand", search.ageBand); if (search.minutesBand !== "all") url.searchParams.set("minutesBand", search.minutesBand);
  const parsed = duelPressLeaderboardCoreSchema.safeParse(await getJson(url.toString(), signal)); if (!parsed.success) throw new DuelPressApiError("schema", "Duel-press leaderboard response violated the 1.1.0 contract");
  const expectedScope = state.mode === "league" ? state.scope : null; const expectedCompetition = state.mode === "league" ? null : state.competition;
  if (parsed.data.meta.season !== state.season || parsed.data.meta.mode !== state.mode || parsed.data.meta.scope !== expectedScope || parsed.data.meta.competition !== expectedCompetition || parsed.data.meta.page !== search.page) throw new DuelPressApiError("schema", "Duel-press leaderboard response identity did not match request");
  const applied = parsed.data.meta.applied;
  if (applied.q !== (search.q || null) || applied.role !== (search.role === "all" ? null : search.role) || applied.position !== (search.position === "ALL" ? null : search.position) || applied.ageBand !== search.ageBand || applied.minutesBand !== search.minutesBand || applied.sort !== search.sort || applied.order !== search.direction) throw new DuelPressApiError("schema", "Duel-press applied filters did not match request");
  return { players: parsed.data.data.map(adaptDuelPressPlayerCore), meta: parsed.data.meta, serverPage: { page: parsed.data.meta.page, pageSize: 50, totalPages: parsed.data.meta.totalPages, hasNextPage: parsed.data.meta.hasNextPage } };
}
export async function fetchDuelPressDetail(config: MessiApiConfig, playerId: number, state: import("../dashboard/types").DatasetRouteState, signal: AbortSignal) {
  const parsed = duelPressDetailCoreSchema.safeParse(await getJson(buildDuelPressDetailUrl(config.baseUrl, playerId, requestContext(state)), signal)); if (!parsed.success) throw new DuelPressApiError("schema", "Duel-press detail response violated the 1.1.0 contract");
  const expectedScope = state.mode === "league" ? state.scope : null; const expectedCompetition = state.mode === "league" ? null : state.competition;
  if (parsed.data.context.playerId !== playerId || parsed.data.context.season !== state.season || parsed.data.context.mode !== state.mode || parsed.data.context.scope !== expectedScope || parsed.data.context.competition !== expectedCompetition) throw new DuelPressApiError("schema", "Duel-press detail identity did not match request");
  return adaptDuelPressPlayerCore(parsed.data.data);
}
