import type { MessiApiConfig } from "./env";
import { DuelPressApiError, duelPressFetchInit } from "./duelPressApi";
import { duelPressDetailReadoutEnvelopeSchema, type DuelPressDetailReadoutEnvelope } from "./duelPressDetailReadoutContracts";
import type { DuelPressModeContext } from "./duelPressTypes";

export function detailReadoutResourceKey(playerId: number, context: DuelPressModeContext) { return JSON.stringify(["duel-press-v1", "detail-readout-v1", playerId, context.season, context.mode, context.scope, context.competition]); }
export function buildDuelPressDetailReadoutUrl(baseUrl: string, playerId: number, context: DuelPressModeContext) {
  if (!Number.isSafeInteger(playerId) || playerId <= 0) throw new DuelPressApiError("invalid-request", "playerId must be a positive safe integer");
  const url = new URL(`/api/v2/players/${playerId}/duel-press/detail-metrics`, baseUrl); url.searchParams.set("season", context.season); url.searchParams.set("mode", context.mode);
  if (context.mode === "league") { url.searchParams.set("scope", String(context.scope)); url.searchParams.set("competition", "all"); } else url.searchParams.set("competition", context.competition);
  return url.toString();
}
export async function fetchDuelPressDetailReadouts(config: MessiApiConfig, playerId: number, context: DuelPressModeContext, signal: AbortSignal): Promise<DuelPressDetailReadoutEnvelope> {
  let response: Response; try { response = await fetch(buildDuelPressDetailReadoutUrl(config.baseUrl, playerId, context), duelPressFetchInit(signal)); } catch (cause) { if (signal.aborted) throw cause; throw new DuelPressApiError("network", "Unable to reach the M.E.S.S.I. API"); }
  if (!response.ok) throw new DuelPressApiError(response.status === 404 ? "not-found" : response.status === 422 ? "invalid-request" : "network");
  let body: unknown; try { body = await response.json(); } catch { throw new DuelPressApiError("schema", "Detail readout response was not valid JSON"); }
  const parsed = duelPressDetailReadoutEnvelopeSchema.safeParse(body); if (!parsed.success) throw new DuelPressApiError("schema", "Detail readout response violated the detail-readout-v1 contract");
  const expectedCompetition = context.mode === "league" ? null : context.competition; const actual = parsed.data.context;
  if (actual.playerId !== playerId || actual.idNamespace !== "fotmob" || actual.season !== context.season || actual.mode !== context.mode || actual.scope !== context.scope || actual.competition !== expectedCompetition) throw new DuelPressApiError("schema", "Detail readout response identity did not match request");
  return parsed.data;
}
