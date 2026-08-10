import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";

import { MessiConfigError, type ConfigErrorCategory, parseMessiApiConfig, type MessiApiConfig } from "../api/env";
import { MessiApiError, isAbortError } from "../api/errors";
import { fetchPlayers } from "../api/playersApi";
import { ConfigErrorFallback } from "./components/ConfigErrorFallback";
import { DashboardDataFallback } from "./components/DashboardDataFallback";
import { DashboardLoading } from "./components/DashboardLoading";
import MessiScoutingDashboard from "./MessiScoutingDashboard";
import { playersResourceReducer, stablePayload } from "./playersResourceState";

type ParsedConfig = { config?: MessiApiConfig; category?: ConfigErrorCategory };

export function PlayersResourceContainer() {
  const [state, dispatch] = useReducer(playersResourceReducer, { type: "idle" });
  const request = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;
  const parsed = useMemo((): ParsedConfig => {
    try {
      return { config: parseMessiApiConfig(import.meta.env, import.meta.env.MODE) };
    } catch (error) {
      return { category: error instanceof MessiConfigError ? error.category : "CONFIG_INVALID" };
    }
  }, []);

  const load = useCallback(() => {
    if (!parsed.config) return;
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    const requestId = ++request.current;
    const previous = stablePayload(stateRef.current);
    dispatch({ type: "start", requestId, previous });
    fetchPlayers(parsed.config, abort.signal)
      .then((payload) => dispatch({ type: "resolve", requestId, payload }))
      .catch((error) => {
        if (!isAbortError(error)) dispatch({ type: "reject", requestId, error: error instanceof MessiApiError ? error : new MessiApiError("network", "Request failed") });
      });
  }, [parsed.config]);

  useEffect(() => {
    if (!parsed.config) return;
    load();
    return () => controller.current?.abort();
  }, [load, parsed.config]);

  if (parsed.category) return <ConfigErrorFallback category={parsed.category} mode={import.meta.env.MODE} />;
  if (state.type === "idle" || state.type === "loading") return <DashboardLoading />;
  if (state.type === "error" && !state.previous) return <DashboardDataFallback error={state.error} onRetry={load} />;
  const payload = state.type === "error" ? state.previous! : state.payload;
  if (!payload.players.length) return <main className="grid min-h-screen place-items-center bg-[#080b0c] text-zinc-100"><section className="text-center"><h1 className="font-bold">No players in this dataset</h1><p className="mt-2 text-sm text-zinc-500">Season {payload.meta.season} · scope {payload.meta.scope}</p><button onClick={load} className="mt-5 min-h-11 rounded border border-white/10 px-4">Refresh</button></section></main>;
  return <MessiScoutingDashboard players={payload.players} meta={payload.meta} refreshing={state.type === "refreshing"} onRefresh={load} refreshWarning={state.type === "error" ? <DashboardDataFallback error={state.error} hasPrevious onRetry={load} /> : undefined} />;
}
