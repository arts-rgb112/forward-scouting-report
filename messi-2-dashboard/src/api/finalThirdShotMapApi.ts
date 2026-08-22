import type { DatasetRouteState } from "../dashboard/types";
import type { MessiApiConfig } from "./env";
import { finalThirdShotMapEnvelopeSchema, type FinalThirdShotMapEnvelope } from "./finalThirdShotMapContracts";

export type FinalThirdShotMapErrorKind = "invalid-request" | "not-found" | "network" | "schema";
export class FinalThirdShotMapApiError extends Error { constructor(public readonly kind: FinalThirdShotMapErrorKind, message: string = kind) { super(message); this.name = "FinalThirdShotMapApiError"; } }
export const finalThirdShotMapResourceKey = (playerId: number, context: DatasetRouteState) => JSON.stringify(["final-third-shot-map-v1", playerId, context.season, context.mode, context.mode === "league" ? context.scope : null, context.mode === "league" ? null : context.competition, "front2"]);
export function buildFinalThirdShotMapUrl(baseUrl: string, playerId: number, context: DatasetRouteState) {
  if (!Number.isSafeInteger(playerId) || playerId <= 0) throw new FinalThirdShotMapApiError("invalid-request", "playerId must be a positive safe integer");
  const url = new URL(`/api/v2/players/${playerId}/final-third-shot-map`, baseUrl); url.searchParams.set("season", context.season); url.searchParams.set("mode", context.mode); url.searchParams.set("depthBand", "front2");
  if (context.mode === "league") { url.searchParams.set("scope", String(context.scope)); url.searchParams.set("competition", "all"); } else url.searchParams.set("competition", context.competition);
  return url.toString();
}
export async function fetchFinalThirdShotMap(config: MessiApiConfig, playerId: number, request: DatasetRouteState, signal: AbortSignal): Promise<FinalThirdShotMapEnvelope> {
  let response: Response; try { response = await fetch(buildFinalThirdShotMapUrl(config.baseUrl, playerId, request), { method: "GET", credentials: "omit", headers: { Accept: "application/json" }, signal }); } catch (cause) { if (signal.aborted) throw cause; throw new FinalThirdShotMapApiError("network", "Unable to load final-third shot map"); }
  if (!response.ok) throw new FinalThirdShotMapApiError(response.status === 404 ? "not-found" : response.status === 422 ? "invalid-request" : "network");
  let body: unknown; try { body = await response.json(); } catch { throw new FinalThirdShotMapApiError("schema", "Final-third shot map response was not valid JSON"); }
  const parsed = finalThirdShotMapEnvelopeSchema.safeParse(body); if (!parsed.success) throw new FinalThirdShotMapApiError("schema", "Final-third shot map response violated the v1 contract");
  const expectedScope = request.mode === "league" ? request.scope : null, expectedCompetition = request.mode === "league" ? null : request.competition, actual = parsed.data.context;
  if (actual.playerId !== playerId || actual.idNamespace !== "fotmob" || actual.season !== request.season || actual.mode !== request.mode || actual.scope !== expectedScope || actual.competition !== expectedCompetition || actual.depthBand !== "front2") throw new FinalThirdShotMapApiError("schema", "Final-third shot map response identity did not match request");
  return parsed.data;
}
