import { useEffect, useRef, useState } from "react";

import type { MessiApiConfig } from "../api/env";
import { MessiApiError } from "../api/errors";
import { resolveWatchlistEntries } from "../api/watchlistResolveApi";
import type { Player } from "./types";
import type { WatchlistEntry } from "./watchlistStorage";
import type { LegacyV3Entry } from "./watchlistV3Contracts";

export type LegacyWatchlistResolution = { status: "pending" | "current" | "unavailable" | "invalid-context" | "resolver-unavailable" | "offline" | "contract-error"; player?: Player };
export const bridgeLegacyV3Entry = (entry: LegacyV3Entry): WatchlistEntry => ({ version: 2, namespace: "fotmob", key: entry.key, playerId: entry.playerId, savedAt: entry.savedAt, snapshot: structuredClone(entry.snapshot), context: entry.context.mode === "league" ? { season: entry.context.season, mode: "league", scope: entry.context.scope, competition: null } : { season: entry.context.season, mode: "europe", scope: null, competition: entry.context.competition } });
const suppressedOrigins = new Set<string>();
const suppressionKey = (origin: string) => `messi-2-watchlist:v3:legacy-resolver-403:${origin}`;
const apiOrigin = (config: MessiApiConfig) => new URL(config.baseUrl).origin;
function resolverSuppressed(config: MessiApiConfig) { const origin = apiOrigin(config); if (suppressedOrigins.has(origin)) return true; try { if (sessionStorage.getItem(suppressionKey(origin)) === "true") { suppressedOrigins.add(origin); return true; } } catch { /* module memory remains the fallback */ } return false; }
function suppressResolver(config: MessiApiConfig) { const origin = apiOrigin(config); suppressedOrigins.add(origin); try { sessionStorage.setItem(suppressionKey(origin), "true"); } catch { /* module memory remains the fallback */ } }
export function clearLegacyWatchlistResolverSuppression(baseUrl?: string) { if (!baseUrl) { suppressedOrigins.clear(); return; } const origin = new URL(baseUrl).origin; suppressedOrigins.delete(origin); try { sessionStorage.removeItem(suppressionKey(origin)); } catch { /* explicit reset remains best effort */ } }

/** V3 remains the only storage writer; this hook only bridges visible legacy entries to the established resolver DTO. */
export function useLegacyWatchlistResolution(config: MessiApiConfig | undefined, entries: readonly LegacyV3Entry[], active: boolean, retryEpoch = 0) {
  const [results, setResults] = useState<Record<string, LegacyWatchlistResolution>>({}); const generation = useRef(0);
  const key = entries.map((entry) => entry.key).join("\u0000");
  useEffect(() => {
    const id = ++generation.current; const controller = new AbortController();
    if (!active || !entries.length) { setResults({}); return () => controller.abort(); }
    if (config && resolverSuppressed(config)) { setResults(Object.fromEntries(entries.map((entry) => [entry.key, { status: "resolver-unavailable" } satisfies LegacyWatchlistResolution]))); return () => controller.abort(); }
    if (!config) { setResults(Object.fromEntries(entries.map((entry) => [entry.key, { status: "offline" } satisfies LegacyWatchlistResolution]))); return () => controller.abort(); }
    setResults(Object.fromEntries(entries.map((entry) => [entry.key, { status: "pending" } satisfies LegacyWatchlistResolution])));
    void resolveWatchlistEntries(config, entries.map(bridgeLegacyV3Entry), controller.signal).then((resolved) => {
      if (controller.signal.aborted || id !== generation.current) return;
      const byKey: Record<string, LegacyWatchlistResolution> = {};
      for (const entry of entries) {
        const result = resolved.find((candidate) => candidate.key === entry.key);
        byKey[entry.key] = result?.status === "resolved" && result.player ? { status: "current", player: result.player } : result?.status === "invalid_context" ? { status: "invalid-context" } : { status: "unavailable" };
      }
      setResults(byKey);
    }).catch((error: unknown) => {
      if (controller.signal.aborted || id !== generation.current) return;
      if (error instanceof MessiApiError && error.kind === "http" && error.status === 403 && config) suppressResolver(config);
      const status: LegacyWatchlistResolution["status"] = error instanceof MessiApiError && error.kind === "http" && error.status === 403 ? "resolver-unavailable" : error instanceof MessiApiError && error.kind === "schema" ? "contract-error" : "offline";
      setResults(Object.fromEntries(entries.map((entry) => [entry.key, { status } satisfies LegacyWatchlistResolution])));
    });
    return () => controller.abort();
  }, [active, config, key, retryEpoch]);
  return results;
}
