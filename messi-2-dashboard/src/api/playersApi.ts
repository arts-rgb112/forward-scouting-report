import { ZodError } from "zod";
import { adaptEnvelope } from "./adapter";
import { buildPlayersUrl, type MessiApiConfig } from "./env";
import { isAbortError, MessiApiError } from "./errors";
import { abortableSleep, asNetworkError, RETRYABLE_STATUS, retryDelay } from "./retry";
import { parsePlayersEnvelope } from "./contracts";
import type { PlayersPayload } from "../dashboard/types";
type Deps = { fetch?: typeof globalThis.fetch; sleep?: typeof abortableSleep; random?: () => number; now?: () => number };
export async function fetchPlayers(config: MessiApiConfig, signal: AbortSignal, deps: Deps = {}): Promise<PlayersPayload> {
  const fetcher = deps.fetch ?? fetch; const sleep = deps.sleep ?? abortableSleep;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetcher(buildPlayersUrl(config), { method: "GET", credentials: "omit", headers: { Accept: "application/json" }, signal });
      if (!response.ok) {
        const error = new MessiApiError("http", `API returned ${response.status}`, response.status, retryDelay(attempt, response.headers.get("Retry-After"), deps.now?.() ?? Date.now(), deps.random ?? Math.random));
        if (!RETRYABLE_STATUS.has(response.status) || attempt === 2) throw error;
        await sleep(error.retryAfter!, signal); continue;
      }
      let json: unknown; try { json = await response.json(); } catch { throw new MessiApiError("schema", "Response was not valid JSON"); }
      try { return adaptEnvelope(parsePlayersEnvelope(json, config)); } catch (error) { if (error instanceof ZodError) throw new MessiApiError("schema", "Response did not match schema"); throw error; }
    } catch (error) {
      if (isAbortError(error) || signal.aborted) throw error;
      if (error instanceof MessiApiError && (error.kind !== "network" || attempt === 2 || !RETRYABLE_STATUS.has(error.status ?? 0))) throw error;
      if (error instanceof MessiApiError && error.kind === "http") throw error;
      if (attempt === 2) throw asNetworkError(error);
      await sleep(retryDelay(attempt, null, deps.now?.() ?? Date.now(), deps.random ?? Math.random), signal);
    }
  }
  throw new MessiApiError("network", "Request failed");
}
