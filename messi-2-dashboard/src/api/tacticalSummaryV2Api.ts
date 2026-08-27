import type { DatasetRouteState } from "../dashboard/types";
import type { MessiApiConfig } from "./env";
import { MessiApiError } from "./errors";
import { tacticalSummaryV2EnvelopeSchema, type TacticalSummaryV2 } from "./tacticalSummaryV2Contracts";

export function tacticalSummaryV2Url(config: MessiApiConfig, playerId: number, context: DatasetRouteState): URL {
  const url = new URL(`/api/v2/players/${playerId}/tactical-summary-v2`, config.baseUrl);
  url.searchParams.set("season", context.season);
  url.searchParams.set("mode", context.mode);
  if (context.mode === "league") { url.searchParams.set("scope", String(context.scope)); url.searchParams.set("competition", "all"); }
  else url.searchParams.set("competition", context.competition);
  return url;
}

export async function fetchTacticalSummaryV2(config: MessiApiConfig, playerId: number, context: DatasetRouteState, signal: AbortSignal): Promise<TacticalSummaryV2> {
  let response: Response;
  try { response = await fetch(tacticalSummaryV2Url(config, playerId, context), { headers: { Accept: "application/json" }, credentials: "omit", signal }); }
  catch (cause) { if (signal.aborted || (cause instanceof DOMException && cause.name === "AbortError")) throw cause; throw new MessiApiError("network", "Unable to load tactical summary v2"); }
  if (!response.ok) throw new MessiApiError("http", response.status === 422 ? "Invalid tactical summary v2 request" : `Tactical summary v2 API returned ${response.status}`, response.status);
  let json: unknown; try { json = await response.json(); } catch { throw new MessiApiError("schema", "Tactical summary v2 response was not valid JSON"); }
  const parsed = tacticalSummaryV2EnvelopeSchema.safeParse(json);
  if (!parsed.success) throw new MessiApiError("schema", "Tactical summary v2 response was invalid");
  const data = parsed.data.data;
  const scope = context.mode === "league" ? context.scope : null;
  const competition = context.mode === "league" ? null : context.competition;
  if (data.playerId !== playerId || data.idNamespace !== "fotmob" || data.season !== context.season || data.sourceContext.mode !== context.mode || data.sourceContext.scope !== scope || data.sourceContext.competition !== competition) throw new MessiApiError("schema", "Tactical summary v2 response identity did not match request");
  return data;
}
