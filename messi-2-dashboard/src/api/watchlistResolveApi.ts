import { adaptPlayer } from "./adapter";
import { watchlistResolveEnvelopeSchema } from "./contracts";
import type { WatchlistResolveResultDto } from "./contracts";
import type { MessiApiConfig } from "./env";
import { MessiApiError } from "./errors";
import type { Player } from "../dashboard/types";
import type { WatchlistEntry } from "../dashboard/watchlistStorage";

export type ResolvedWatchlistEntry = { key: string; status: "resolved" | "unavailable" | "invalid_context"; player?: Player };
const CHUNK_SIZE = 100;

function payload(entry: WatchlistEntry) {
  return { key: entry.key, player: { idNamespace: entry.namespace, playerId: entry.playerId }, context: entry.context };
}

function exactContext(result: WatchlistResolveResultDto, entry: WatchlistEntry): boolean {
  const context = result.context;
  return context !== null
    && context.season === entry.context.season
    && context.mode === entry.context.mode
    && context.scope === entry.context.scope
    && context.competition === entry.context.competition;
}

function exactResolvedEntry(result: WatchlistResolveResultDto, entry: WatchlistEntry): boolean {
  const player = result.player;
  return result.status === "resolved"
    && result.key === entry.key
    && player !== null
    && player.idNamespace === entry.namespace
    && player.id === entry.playerId
    && player.playerId === entry.playerId
    && exactContext(result, entry);
}

async function resolveChunk(config: MessiApiConfig, entries: readonly WatchlistEntry[], signal?: AbortSignal): Promise<ResolvedWatchlistEntry[]> {
  let response: Response;
  try {
    response = await fetch(new URL("/api/v2/watchlist/resolve", config.baseUrl).toString(), {
      method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ entries: entries.map(payload) }), signal, credentials: "omit",
    });
  } catch (cause) {
    if (signal?.aborted) throw cause;
    throw new MessiApiError("network", "Unable to resolve saved watchlist contexts");
  }
  if (!response.ok) throw new MessiApiError("http", `Watchlist resolver returned ${response.status}`, response.status);
  let json: unknown;
  try { json = await response.json(); } catch { throw new MessiApiError("schema", "Watchlist resolver response was not valid JSON"); }
  const parsed = watchlistResolveEnvelopeSchema.safeParse(json);
  if (!parsed.success) throw new MessiApiError("schema", "Watchlist resolver response was invalid");
  const requestedCounts = new Map<string, number>();
  const resultsByKey = new Map<string, WatchlistResolveResultDto>();
  const resultCounts = new Map<string, number>();
  for (const entry of entries) requestedCounts.set(entry.key, (requestedCounts.get(entry.key) ?? 0) + 1);
  for (const result of parsed.data.results) {
    resultCounts.set(result.key, (resultCounts.get(result.key) ?? 0) + 1);
    resultsByKey.set(result.key, result);
  }

  // A response is trusted only when it is a one-to-one match with this exact saved entry.
  // Any missing, duplicate, or identity-mismatched response deliberately falls back to the
  // complete browser-owned snapshot instead of presenting a different current profile.
  return entries.map((entry) => {
    const result = resultsByKey.get(entry.key);
    if (requestedCounts.get(entry.key) !== 1 || resultCounts.get(entry.key) !== 1 || !result) {
      return { key: entry.key, status: "unavailable" };
    }
    if (result.status !== "resolved") return { key: entry.key, status: result.status };
    if (!exactResolvedEntry(result, entry)) return { key: entry.key, status: "unavailable" };
    return { key: entry.key, status: "resolved", player: adaptPlayer(result.player!, parsed.data.tierTaxonomyVersion) };
  });
}

/** Resolves only browser-owned V2 entries. The server's 100-entry hard limit is honored per request. */
export async function resolveWatchlistEntries(config: MessiApiConfig, entries: readonly WatchlistEntry[], signal?: AbortSignal): Promise<ResolvedWatchlistEntry[]> {
  const results: ResolvedWatchlistEntry[] = [];
  for (let index = 0; index < entries.length; index += CHUNK_SIZE) {
    results.push(...await resolveChunk(config, entries.slice(index, index + CHUNK_SIZE), signal));
  }
  return results;
}
