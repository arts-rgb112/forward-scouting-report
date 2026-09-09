import type { DatasetRouteState } from "../dashboard/types";
import type { MessiApiConfig } from "./env";
import { NativePitchEventsApiError, buildNativePitchEventsUrl } from "./nativePitchEventsApi";
import { nativePitchEventsV2EnvelopeSchema, type NativePitchEventsV2Envelope } from "./nativePitchEventsV2Contracts";

export const nativePitchEventsV2ResourceKey = (playerId: number, context: DatasetRouteState, includePenalties: boolean) =>
  JSON.stringify(["native-pitch-events-v2", playerId, context.season, context.mode, context.mode === "league" ? context.scope : null, context.mode === "league" ? null : context.competition, includePenalties]);

export function buildNativePitchEventsV2Url(baseUrl: string, playerId: number, context: DatasetRouteState, includePenalties: boolean) {
  const url = new URL(buildNativePitchEventsUrl(baseUrl, playerId, context, includePenalties));
  url.pathname = `/api/v2/players/${playerId}/native-pitch-events-v2`;
  return url.toString();
}

export async function fetchNativePitchEventsV2(config: MessiApiConfig, playerId: number, request: DatasetRouteState, includePenalties: boolean, signal: AbortSignal): Promise<NativePitchEventsV2Envelope> {
  let response: Response;
  try { response = await fetch(buildNativePitchEventsV2Url(config.baseUrl, playerId, request, includePenalties), { method: "GET", credentials: "omit", headers: { Accept: "application/json" }, signal }); }
  catch (cause) { if (signal.aborted) throw cause; throw new NativePitchEventsApiError("network"); }
  if (!response.ok) throw new NativePitchEventsApiError(response.status === 404 ? "not-found" : response.status === 422 ? "invalid-request" : "network");
  let body: unknown;
  try { body = await response.json(); } catch { throw new NativePitchEventsApiError("schema"); }
  const parsed = nativePitchEventsV2EnvelopeSchema.safeParse(body);
  if (!parsed.success) throw new NativePitchEventsApiError("schema");
  const actual = parsed.data.context;
  if (actual.playerId !== playerId || actual.season !== request.season || actual.mode !== request.mode ||
      actual.scope !== (request.mode === "league" ? request.scope : null) ||
      actual.competition !== (request.mode === "league" ? null : request.competition) || parsed.data.includePenalties !== includePenalties)
    throw new NativePitchEventsApiError("schema", "Response context does not match selection");
  return parsed.data;
}
