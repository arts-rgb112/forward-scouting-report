import type { DatasetRouteState } from "../dashboard/types";
import type { MessiApiConfig } from "./env";
import { FinalThirdShotMapApiError } from "./finalThirdShotMapApi";
import { finalThirdShotMapV2EnvelopeSchema, type FinalThirdShotMapV2Envelope } from "./finalThirdShotMapV2Contracts";

export const finalThirdShotMapV2ResourceKey = (playerId: number, context: DatasetRouteState) => JSON.stringify(["final-third-shot-map-effective-v2", playerId, context.season, context.mode, context.mode === "league" ? context.scope : null, context.mode === "league" ? null : context.competition, "front2"]);

export function buildFinalThirdShotMapV2Url(baseUrl: string, playerId: number, context: DatasetRouteState) {
  if (!Number.isSafeInteger(playerId) || playerId <= 0) throw new FinalThirdShotMapApiError("invalid-request", "playerId must be a positive safe integer");
  const url = new URL(`/api/v2/players/${playerId}/final-third-shot-map`, baseUrl);
  url.searchParams.set("season", context.season);
  url.searchParams.set("mode", context.mode);
  url.searchParams.set("depthBand", "front2");
  url.searchParams.set("conversionVersion", "effective-shot-v2");
  if (context.mode === "league") { url.searchParams.set("scope", String(context.scope)); url.searchParams.set("competition", "all"); }
  else url.searchParams.set("competition", context.competition);
  return url.toString();
}

export async function fetchFinalThirdShotMapV2(config: MessiApiConfig, playerId: number, request: DatasetRouteState, signal: AbortSignal): Promise<FinalThirdShotMapV2Envelope> {
  let response: Response;
  try { response = await fetch(buildFinalThirdShotMapV2Url(config.baseUrl, playerId, request), { method: "GET", credentials: "omit", headers: { Accept: "application/json" }, signal }); }
  catch (cause) { if (signal.aborted) throw cause; throw new FinalThirdShotMapApiError("network", "Unable to load effective-shot final-third map"); }
  if (!response.ok) throw new FinalThirdShotMapApiError(response.status === 404 ? "not-found" : response.status === 422 ? "invalid-request" : "network");
  let body: unknown; try { body = await response.json(); } catch { throw new FinalThirdShotMapApiError("schema", "Effective-shot final-third response was not valid JSON"); }
  const parsed = finalThirdShotMapV2EnvelopeSchema.safeParse(body);
  if (!parsed.success) throw new FinalThirdShotMapApiError("schema", "Effective-shot final-third response violated the v2 contract");
  const expectedScope = request.mode === "league" ? request.scope : null, expectedCompetition = request.mode === "league" ? null : request.competition, actual = parsed.data.context;
  if (actual.playerId !== playerId || actual.idNamespace !== "fotmob" || actual.season !== request.season || actual.mode !== request.mode || actual.scope !== expectedScope || actual.competition !== expectedCompetition || actual.depthBand !== "front2") throw new FinalThirdShotMapApiError("schema", "Effective-shot final-third response identity did not match request");
  return parsed.data;
}
