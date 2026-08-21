import { adaptPlayer } from "./adapter";
import { playerDetailEnvelopeSchema } from "./contracts";
import type { MessiApiConfig } from "./env";
import { MessiApiError } from "./errors";
import { fetchLeaderboardOptions } from "./leaderboardsApi";
import type { DatasetRouteState, LeaderboardOptions, Player } from "../dashboard/types";

export type PlayerHistoryContext = Pick<DatasetRouteState, "season" | "mode" | "scope" | "competition">;
export type PlayerHistoryEntry = { player: Player; context: PlayerHistoryContext };
const cache = new Map<string, PlayerHistoryEntry>();
const keyFor = (config: MessiApiConfig, id: number, context: PlayerHistoryContext) => `${config.baseUrl}|${id}|${context.season}|${context.mode}|${context.scope}|${context.competition}`;
const validSeason = (season: string) => /^\d{4}\/\d{4}$/.test(season) && Number(season.slice(5)) === Number(season.slice(0, 4)) + 1;

/** Summary-only historical request. It validates the server player identity before caching it. */
export async function fetchPlayerSummary(config: MessiApiConfig, id: number, context: PlayerHistoryContext, signal: AbortSignal): Promise<PlayerHistoryEntry> {
  if (!Number.isSafeInteger(id) || id <= 0 || !validSeason(context.season)) throw new MessiApiError("schema", "Player history request was invalid");
  const key = keyFor(config, id, context); const cached = cache.get(key); if (cached) return cached;
  const url = new URL(`/api/v2/players/${id}`, config.baseUrl);
  url.search = new URLSearchParams({ season: context.season, mode: context.mode, scope: String(context.scope), competition: context.competition, includeAnalysis: "false" }).toString();
  let response: Response;
  try { response = await fetch(url, { headers: { Accept: "application/json" }, credentials: "omit", signal }); }
  catch (cause) { if (signal.aborted) throw cause; throw new MessiApiError("network", "Unable to reach the M.E.S.S.I. API"); }
  if (!response.ok) throw new MessiApiError("http", `API returned ${response.status}`, response.status);
  let json: unknown; try { json = await response.json(); } catch { throw new MessiApiError("schema", "Response was not valid JSON"); }
  try {
    const parsed = playerDetailEnvelopeSchema.parse(json);
    if (parsed.data.id !== id) throw new MessiApiError("schema", "Player summary identity did not match request");
    const entry = { player: adaptPlayer(parsed.data, parsed.tierTaxonomyVersion), context };
    cache.set(key, entry); return entry;
  } catch (error) { if (error instanceof MessiApiError) throw error; throw new MessiApiError("schema", "Player summary response was invalid"); }
}

export function clearPlayerHistoryCache() { cache.clear(); }

export async function fetchHistoryLeaderboardOptions(config: MessiApiConfig, signal: AbortSignal): Promise<LeaderboardOptions> {
  return fetchLeaderboardOptions(config, signal);
}
