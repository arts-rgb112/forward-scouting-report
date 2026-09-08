import type { DatasetRouteState } from "../dashboard/types";
import type { MessiApiConfig } from "./env";
import { nativePitchEventsEnvelopeSchema, type NativePitchEventsEnvelope } from "./nativePitchEventsContracts";

/**
 * `native-pitch-events-v1` is the ONLY source ever used to connect an
 * individual pitch marker to a recorded body part, quality, or box region.
 * This client must never be used to infer that connection from a FotMob
 * `ShotmapPoint` by count, array index, or coordinate proximity.
 *
 * Same activation state as native-body-part-stats-v2: reviewed and live on
 * the local QA factory, not yet mounted on production — a 404 there is the
 * honest, expected state.
 */
export type NativePitchEventsApiErrorKind = "invalid-request" | "not-found" | "schema" | "network";
export class NativePitchEventsApiError extends Error {
  constructor(public readonly kind: NativePitchEventsApiErrorKind, message: string = kind) { super(message); this.name = "NativePitchEventsApiError"; }
}

export const nativePitchEventsResourceKey = (playerId: number, context: DatasetRouteState, includePenalties: boolean) =>
  JSON.stringify(["native-pitch-events-v1", playerId, context.season, context.mode, context.mode === "league" ? context.scope : null, context.mode === "league" ? null : context.competition, includePenalties]);

export function buildNativePitchEventsUrl(baseUrl: string, playerId: number, context: DatasetRouteState, includePenalties: boolean) {
  if (!Number.isSafeInteger(playerId) || playerId <= 0) throw new NativePitchEventsApiError("invalid-request", "playerId must be a positive safe integer");
  const url = new URL(`/api/v2/players/${playerId}/native-pitch-events`, baseUrl);
  url.searchParams.set("season", context.season);
  url.searchParams.set("mode", context.mode);
  if (context.mode === "league") { url.searchParams.set("scope", String(context.scope)); url.searchParams.set("competition", "all"); }
  else url.searchParams.set("competition", context.competition);
  url.searchParams.set("includePenalties", String(includePenalties));
  return url.toString();
}

export async function fetchNativePitchEvents(config: MessiApiConfig, playerId: number, request: DatasetRouteState, includePenalties: boolean, signal: AbortSignal): Promise<NativePitchEventsEnvelope> {
  let response: Response;
  try { response = await fetch(buildNativePitchEventsUrl(config.baseUrl, playerId, request, includePenalties), { method: "GET", credentials: "omit", headers: { Accept: "application/json" }, signal }); }
  catch (cause) { if (signal.aborted) throw cause; throw new NativePitchEventsApiError("network", "Unable to load native pitch events"); }
  if (!response.ok) throw new NativePitchEventsApiError(response.status === 404 ? "not-found" : response.status === 422 ? "invalid-request" : "network");
  let body: unknown;
  try { body = await response.json(); }
  catch { throw new NativePitchEventsApiError("schema", "Native pitch events response was not valid JSON"); }
  const parsed = nativePitchEventsEnvelopeSchema.safeParse(body);
  if (!parsed.success) throw new NativePitchEventsApiError("schema", "Native pitch events response violated the strict contract");
  const expectedScope = request.mode === "league" ? request.scope : null;
  const expectedCompetition = request.mode === "league" ? null : request.competition;
  const actual = parsed.data.context;
  if (actual.playerId !== playerId || actual.season !== request.season || actual.mode !== request.mode || actual.scope !== expectedScope || actual.competition !== expectedCompetition || parsed.data.includePenalties !== includePenalties)
    throw new NativePitchEventsApiError("schema", "Native pitch events response identity did not match request");
  return parsed.data;
}
