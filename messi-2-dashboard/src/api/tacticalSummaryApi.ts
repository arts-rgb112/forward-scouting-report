import type { DatasetRouteState } from "../dashboard/types";
import type { MessiApiConfig } from "./env";
import { MessiApiError } from "./errors";
import { tacticalSummaryEnvelopeSchema, type TacticalSummary } from "./tacticalSummaryContracts";

export function tacticalSummaryUrl(config: MessiApiConfig, playerId: number, context: DatasetRouteState): URL {
  const url = new URL(`/api/v2/players/${playerId}/tactical-summary`, config.baseUrl);
  url.searchParams.set("season", context.season); url.searchParams.set("mode", context.mode);
  if (context.mode === "league") { url.searchParams.set("scope", String(context.scope)); url.searchParams.set("competition", "all"); }
  else url.searchParams.set("competition", context.competition);
  return url;
}

export async function fetchTacticalSummary(config: MessiApiConfig, playerId: number, context: DatasetRouteState, signal: AbortSignal): Promise<TacticalSummary> {
  let response: Response;
  try { response = await fetch(tacticalSummaryUrl(config, playerId, context), { headers: { Accept: "application/json" }, credentials: "omit", signal }); }
  catch (cause) { if (signal.aborted || (cause instanceof DOMException && cause.name === "AbortError")) throw cause; throw new MessiApiError("network", "Unable to load tactical summary"); }
  if (!response.ok) throw new MessiApiError("http", response.status === 422 ? "Invalid tactical summary request" : `Tactical summary API returned ${response.status}`, response.status);
  let json: unknown; try { json = await response.json(); } catch { throw new MessiApiError("schema", "Tactical summary response was not valid JSON"); }
  const parsed = tacticalSummaryEnvelopeSchema.safeParse(json); if (!parsed.success) throw new MessiApiError("schema", "Tactical summary response was invalid");
  const data = parsed.data.data; const expectedScope = context.mode === "league" ? context.scope : null; const expectedCompetition = context.mode === "league" ? null : context.competition;
  if (data.playerId !== playerId || data.idNamespace !== "fotmob" || data.season !== context.season || data.sourceContext.mode !== context.mode || data.sourceContext.scope !== expectedScope || data.sourceContext.competition !== expectedCompetition) throw new MessiApiError("schema", "Tactical summary response identity did not match request");
  return data;
}
