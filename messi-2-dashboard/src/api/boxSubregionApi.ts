import type { DatasetRouteState } from "../dashboard/types";
import type { MessiApiConfig } from "./env";
import { boxSubregionEnvelopeSchema, type BoxSubregionEnvelope } from "./boxSubregionContracts";

/**
 * The backend route this calls (`/api/v2/players/{playerId}/box-subregion-stats`)
 * is reviewed but not yet mounted (see BOX_SUBREGION_TRANSPORT_PROPOSAL_20260908.md).
 * Calling this against a live server today will 404 — that is the correct,
 * honest state until Codex's runtime activation lands, not a bug in this client.
 */
export type BoxSubregionApiErrorKind = "invalid-request" | "not-found" | "schema" | "network";
export class BoxSubregionApiError extends Error {
  constructor(public readonly kind: BoxSubregionApiErrorKind, message: string = kind) { super(message); this.name = "BoxSubregionApiError"; }
}

export const boxSubregionResourceKey = (playerId: number, context: DatasetRouteState) =>
  JSON.stringify(["box-subregion-stats-v1", playerId, context.season, context.mode, context.mode === "league" ? context.scope : null, context.mode === "league" ? null : context.competition]);

export function buildBoxSubregionUrl(baseUrl: string, playerId: number, context: DatasetRouteState) {
  if (!Number.isSafeInteger(playerId) || playerId <= 0) throw new BoxSubregionApiError("invalid-request", "playerId must be a positive safe integer");
  const url = new URL(`/api/v2/players/${playerId}/box-subregion-stats`, baseUrl);
  url.searchParams.set("season", context.season);
  url.searchParams.set("mode", context.mode);
  if (context.mode === "league") { url.searchParams.set("scope", String(context.scope)); url.searchParams.set("competition", "all"); }
  else url.searchParams.set("competition", context.competition);
  return url.toString();
}

export async function fetchBoxSubregionStats(config: MessiApiConfig, playerId: number, request: DatasetRouteState, signal: AbortSignal): Promise<BoxSubregionEnvelope> {
  let response: Response;
  try { response = await fetch(buildBoxSubregionUrl(config.baseUrl, playerId, request), { method: "GET", credentials: "omit", headers: { Accept: "application/json" }, signal }); }
  catch (cause) { if (signal.aborted) throw cause; throw new BoxSubregionApiError("network", "Unable to load box-subregion stats"); }
  if (!response.ok) throw new BoxSubregionApiError(response.status === 404 ? "not-found" : response.status === 422 ? "invalid-request" : "network");
  let body: unknown;
  try { body = await response.json(); }
  catch { throw new BoxSubregionApiError("schema", "Box-subregion response was not valid JSON"); }
  const parsed = boxSubregionEnvelopeSchema.safeParse(body);
  if (!parsed.success) throw new BoxSubregionApiError("schema", "Box-subregion response violated the strict contract");
  const expectedScope = request.mode === "league" ? request.scope : null;
  const expectedCompetition = request.mode === "league" ? null : request.competition;
  const actual = parsed.data.context;
  if (actual.playerId !== playerId || actual.season !== request.season || actual.mode !== request.mode || actual.scope !== expectedScope || actual.competition !== expectedCompetition)
    throw new BoxSubregionApiError("schema", "Box-subregion response identity did not match request");
  return parsed.data;
}
