import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";

import { MessiConfigError, type ConfigErrorCategory, parseMessiApiConfig, type MessiApiConfig } from "../api/env";
import { MessiApiError, isAbortError } from "../api/errors";
import { fetchLeaderboard, fetchLeaderboardOptions } from "../api/leaderboardsApi";
import { fetchPlayers } from "../api/playersApi";
import { datasetFromSearch, leaderboardHref, pageFromSearch } from "./datasetRoute";
import { ConfigErrorFallback } from "./components/ConfigErrorFallback";
import { DashboardDataFallback } from "./components/DashboardDataFallback";
import { DashboardLoading } from "./components/DashboardLoading";
import MessiScoutingDashboard from "./MessiScoutingDashboard";
import { playersResourceReducer, stablePayload } from "./playersResourceState";
import type { DatasetRouteState, LeaderboardOptions } from "./types";

type ParsedConfig = { config?: MessiApiConfig; category?: ConfigErrorCategory };
const fallbackRoute = (config: MessiApiConfig): DatasetRouteState => ({ season: config.season, mode: "league", scope: config.scope as 3 | 5 | 7, competition: "all" });
function routeFromUrl(config: MessiApiConfig) { return datasetFromSearch(window.location.search, fallbackRoute(config)); }
function apiError(error: unknown) { return error instanceof MessiApiError ? error : new MessiApiError("network", "Request failed"); }

export function PlayersResourceContainer() {
  const [state, dispatch] = useReducer(playersResourceReducer, { type: "idle" });
  const [options, setOptions] = useState<LeaderboardOptions>();
  const request = useRef(0); const controller = useRef<AbortController | null>(null); const stateRef = useRef(state); stateRef.current = state;
  const parsed = useMemo((): ParsedConfig => { try { return { config: parseMessiApiConfig(import.meta.env, import.meta.env.MODE) }; } catch (error) { return { category: error instanceof MessiConfigError ? error.category : "CONFIG_INVALID" }; } }, []);
  const [dataset, setDataset] = useState<DatasetRouteState>(() => parsed.config ? routeFromUrl(parsed.config) : { season: "2025/2026", mode: "league", scope: 7, competition: "all" });
  const [page, setPage] = useState(() => pageFromSearch(window.location.search));
  const datasetRef = useRef(dataset); datasetRef.current = dataset;

  const writeRoute = useCallback((next: DatasetRouteState, nextPage: number, replace = false) => {
    window.history[replace ? "replaceState" : "pushState"](null, "", leaderboardHref(next, nextPage));
    setDataset(next); setPage(nextPage);
  }, []);
  useEffect(() => {
    if (!parsed.config) return;
    const canonical = leaderboardHref(dataset, page);
    if (`${window.location.pathname}${window.location.search}` !== canonical) window.history.replaceState(null, "", canonical);
  }, [dataset, page, parsed.config]);
  useEffect(() => {
    if (!parsed.config) return;
    const onPopState = () => { setDataset(routeFromUrl(parsed.config!)); setPage(pageFromSearch(window.location.search)); };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [parsed.config]);

  const load = useCallback(async (next = dataset) => {
    if (!parsed.config) return;
    controller.current?.abort(); const abort = new AbortController(); controller.current = abort; const requestId = ++request.current;
    dispatch({ type: "start", requestId, previous: stablePayload(stateRef.current) });
    try { dispatch({ type: "resolve", requestId, payload: options ? await fetchLeaderboard(parsed.config, next, abort.signal) : await fetchPlayers(parsed.config, abort.signal) }); }
    catch (error) {
      if (isAbortError(error)) return;
      if (options) try { const fallback = await fetchPlayers(parsed.config, abort.signal); if (!abort.signal.aborted) dispatch({ type: "resolve", requestId, payload: fallback }); return; } catch (fallbackError) { if (isAbortError(fallbackError)) return; dispatch({ type: "reject", requestId, error: apiError(fallbackError) }); return; }
      dispatch({ type: "reject", requestId, error: apiError(error) });
    }
  }, [dataset, options, parsed.config]);
  useEffect(() => {
    if (!parsed.config) return;
    const abort = new AbortController();
    fetchLeaderboardOptions(parsed.config, abort.signal).then((value) => {
      setOptions(value);
      const current = datasetRef.current;
      const next = { ...current, season: value.seasons.includes(current.season) ? current.season : value.seasons[0] ?? current.season, competition: value.competitions[current.competition]?.available ? current.competition : "all" };
      if (next.season !== current.season || next.competition !== current.competition) {
        setDataset(next);
        setPage(1);
      }
    }).catch(() => setOptions(undefined));
    return () => abort.abort();
  }, [parsed.config]);
  useEffect(() => { if (!parsed.config) return; void load(dataset); return () => controller.current?.abort(); }, [dataset, load, parsed.config]);
  if (parsed.category) return <ConfigErrorFallback category={parsed.category} mode={import.meta.env.MODE} />;
  if (state.type === "idle" || state.type === "loading") return <DashboardLoading />;
  if (state.type === "error" && !state.previous) return <DashboardDataFallback error={state.error} onRetry={() => void load(dataset)} />;
  const payload = state.type === "error" ? state.previous! : state.payload;
  return <MessiScoutingDashboard players={payload.players} meta={payload.meta} refreshing={state.type === "refreshing"} onRefresh={() => void load(dataset)} refreshWarning={state.type === "error" ? <DashboardDataFallback error={state.error} hasPrevious onRetry={() => void load(dataset)} /> : undefined} dataset={dataset} options={options} page={page} onDatasetChange={(next) => writeRoute(next, 1)} onPageChange={(next, replace) => writeRoute(dataset, next, replace)} />;
}
