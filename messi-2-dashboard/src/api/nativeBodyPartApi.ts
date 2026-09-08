import type { DatasetRouteState } from "../dashboard/types";
import type { MessiApiConfig } from "./env";
import { nativeBodyPartEnvelopeSchema, type NativeBodyPartEnvelope } from "./nativeBodyPartContracts";

/**
 * The backend route this calls (`/api/v2/players/{playerId}/body-part-shooting-stats`)
 * is live on the local QA factory as of 2026-09-08 (native-body-part-stats-v2,
 * BODY_PART_QUALITY_PROPOSAL_20260908.md revision2, independent GO). It is
 * still not mounted on production — a 404 there remains the honest,
 * expected state, not a bug in this client.
 *
 * This client only surfaces server-owned AGGREGATE body-part counts. It must
 * never be used to infer or highlight the body part of an individual shot
 * marker — that join does not exist and must not be fabricated.
 */
export type NativeBodyPartApiErrorKind = "invalid-request" | "not-found" | "schema" | "network";
export class NativeBodyPartApiError extends Error {
  constructor(public readonly kind: NativeBodyPartApiErrorKind, message: string = kind) { super(message); this.name = "NativeBodyPartApiError"; }
}

export const nativeBodyPartResourceKey = (playerId: number, context: DatasetRouteState, includePenalties: boolean) =>
  JSON.stringify(["native-body-part-stats-v2", playerId, context.season, context.mode, context.mode === "league" ? context.scope : null, context.mode === "league" ? null : context.competition, includePenalties]);

export function buildNativeBodyPartUrl(baseUrl: string, playerId: number, context: DatasetRouteState, includePenalties: boolean) {
  if (!Number.isSafeInteger(playerId) || playerId <= 0) throw new NativeBodyPartApiError("invalid-request", "playerId must be a positive safe integer");
  const url = new URL(`/api/v2/players/${playerId}/body-part-shooting-stats`, baseUrl);
  url.searchParams.set("season", context.season);
  url.searchParams.set("mode", context.mode);
  if (context.mode === "league") { url.searchParams.set("scope", String(context.scope)); url.searchParams.set("competition", "all"); }
  else url.searchParams.set("competition", context.competition);
  url.searchParams.set("includePenalties", String(includePenalties));
  return url.toString();
}

export async function fetchNativeBodyPartStats(config: MessiApiConfig, playerId: number, request: DatasetRouteState, includePenalties: boolean, signal: AbortSignal): Promise<NativeBodyPartEnvelope> {
  let response: Response;
  try { response = await fetch(buildNativeBodyPartUrl(config.baseUrl, playerId, request, includePenalties), { method: "GET", credentials: "omit", headers: { Accept: "application/json" }, signal }); }
  catch (cause) { if (signal.aborted) throw cause; throw new NativeBodyPartApiError("network", "Unable to load native body-part stats"); }
  if (!response.ok) throw new NativeBodyPartApiError(response.status === 404 ? "not-found" : response.status === 422 ? "invalid-request" : "network");
  let body: unknown;
  try { body = await response.json(); }
  catch { throw new NativeBodyPartApiError("schema", "Native body-part response was not valid JSON"); }
  const parsed = nativeBodyPartEnvelopeSchema.safeParse(body);
  if (!parsed.success) throw new NativeBodyPartApiError("schema", "Native body-part response violated the strict contract");
  const expectedScope = request.mode === "league" ? request.scope : null;
  const expectedCompetition = request.mode === "league" ? null : request.competition;
  const actual = parsed.data.context;
  if (actual.playerId !== playerId || actual.season !== request.season || actual.mode !== request.mode || actual.scope !== expectedScope || actual.competition !== expectedCompetition || parsed.data.includePenalties !== includePenalties)
    throw new NativeBodyPartApiError("schema", "Native body-part response identity did not match request");
  return parsed.data;
}
