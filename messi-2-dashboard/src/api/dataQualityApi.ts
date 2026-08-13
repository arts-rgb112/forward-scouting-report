import { playerDataQualityEnvelopeSchema, watchlistDataQualityEnvelopeSchema } from "./contracts";
import type { PlayerDataQualityDto, WatchlistDataQualityResultDto } from "./contracts";
import type { MessiApiConfig } from "./env";
import { MessiApiError } from "./errors";
import type { DatasetRouteState } from "../dashboard/types";
import type { WatchContext, WatchlistEntry } from "../dashboard/watchlistStorage";

export function qualityContextFromDataset(state: DatasetRouteState): WatchContext {
  return state.mode === "league"
    ? { season: state.season, mode: "league", scope: state.scope, competition: null }
    : { season: state.season, mode: "europe", scope: null, competition: state.competition };
}
export class DataQualityIdentityError extends MessiApiError {
  constructor() { super("schema", "Data-quality response identity did not match request"); this.name = "DataQualityIdentityError"; }
}

function appendContext(url: URL, context: WatchContext) {
  url.searchParams.set("season", context.season); url.searchParams.set("mode", context.mode);
  if (context.scope !== null) url.searchParams.set("scope", String(context.scope));
  if (context.competition !== null) url.searchParams.set("competition", context.competition);
}
function isAbort(signal: AbortSignal | undefined, error: unknown) { return signal?.aborted || (error instanceof DOMException && error.name === "AbortError"); }
function normalize(error: unknown, message: string): never {
  if (error instanceof MessiApiError || (error instanceof DOMException && error.name === "AbortError")) throw error;
  throw new MessiApiError("schema", message);
}
async function parseResponse(response: Response, schemaMessage: string): Promise<unknown> {
  if (!response.ok) throw new MessiApiError("http", `Data-quality API returned ${response.status}`, response.status);
  try { return await response.json(); } catch { throw new MessiApiError("schema", schemaMessage); }
}

export async function fetchPlayerDataQuality(config: MessiApiConfig, playerId: number, state: DatasetRouteState, signal?: AbortSignal): Promise<PlayerDataQualityDto> {
  const url = new URL(`/api/v2/players/${playerId}/data-quality`, config.baseUrl); appendContext(url, qualityContextFromDataset(state));
  try {
    let response: Response;
    try { response = await fetch(url.toString(), { headers: { Accept: "application/json" }, signal, credentials: "omit" }); }
    catch (cause) { if (isAbort(signal, cause)) throw cause; throw new MessiApiError("network", "Unable to load player data quality"); }
    const parsed = playerDataQualityEnvelopeSchema.safeParse(await parseResponse(response, "Data-quality response was not valid JSON"));
    if (!parsed.success) throw new MessiApiError("schema", "Data-quality response was invalid");
    const expected = qualityContextFromDataset(state); const data = parsed.data.data;
    if (data.playerId !== playerId || data.season !== expected.season || data.mode !== expected.mode || data.scope !== expected.scope || data.competition !== expected.competition) throw new DataQualityIdentityError();
    return data;
  } catch (error) { return normalize(error, "Data-quality response was invalid"); }
}

function payload(entry: WatchlistEntry) { return { key: entry.key, player: { idNamespace: entry.namespace, playerId: entry.playerId }, context: entry.context }; }
/** The companion endpoint has a hard 100-entry request limit. Callers must select one visible page. */
export async function fetchWatchlistDataQuality(config: MessiApiConfig, entries: readonly WatchlistEntry[], signal?: AbortSignal): Promise<WatchlistDataQualityResultDto[]> {
  if (!entries.length) throw new MessiApiError("schema", "Data-quality request must contain at least one entry");
  if (entries.length > 100) throw new MessiApiError("schema", "Data-quality request may contain at most 100 entries");
  try {
    let response: Response;
    try { response = await fetch(new URL("/api/v2/watchlist/data-quality", config.baseUrl).toString(), { method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json" }, body: JSON.stringify({ entries: entries.map(payload) }), signal, credentials: "omit" }); }
    catch (cause) { if (isAbort(signal, cause)) throw cause; throw new MessiApiError("network", "Unable to load watchlist data quality"); }
    const parsed = watchlistDataQualityEnvelopeSchema.safeParse(await parseResponse(response, "Watchlist data-quality response was not valid JSON"));
    if (!parsed.success) throw new MessiApiError("schema", "Watchlist data-quality response was invalid");
    return parsed.data.results;
  } catch (error) { return normalize(error, "Watchlist data-quality response was invalid"); }
}
