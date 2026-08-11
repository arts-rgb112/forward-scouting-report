import { adaptPlayer } from "./adapter";
import { watchlistResolveEnvelopeSchema } from "./contracts";
import type { MessiApiConfig } from "./env";
import { MessiApiError } from "./errors";
import type { Player } from "../dashboard/types";
import type { WatchlistEntry } from "../dashboard/watchlistStorage";

export type ResolvedWatchlistEntry = { key: string; status: "resolved" | "unavailable" | "invalid_context"; player?: Player };
const CHUNK_SIZE = 100;

function payload(entry: WatchlistEntry) {
  return { key: entry.key, player: { idNamespace: entry.namespace, playerId: entry.playerId }, context: entry.context };
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
  const requested = new Set(entries.map((entry) => entry.key));
  return parsed.data.results.filter((result) => requested.has(result.key)).map((result) => ({
    key: result.key, status: result.status,
    // A malformed "resolved" result is never permitted to manufacture a row.
    player: result.status === "resolved" && result.player ? adaptPlayer(result.player) : undefined,
  }));
}

/** Resolves only browser-owned V2 entries. The server's 100-entry hard limit is honored per request. */
export async function resolveWatchlistEntries(config: MessiApiConfig, entries: readonly WatchlistEntry[], signal?: AbortSignal): Promise<ResolvedWatchlistEntry[]> {
  const results: ResolvedWatchlistEntry[] = [];
  for (let index = 0; index < entries.length; index += CHUNK_SIZE) {
    results.push(...await resolveChunk(config, entries.slice(index, index + CHUNK_SIZE), signal));
  }
  return results;
}
