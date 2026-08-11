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
  const [optionsResolved, setOptionsResolved] = useState(false);
  const request = useRef(0); const optionsRequest = useRef(0); const controller = useRef<AbortController | null>(null); const optionsController = useRef<AbortController | null>(null); const optionsTimer = useRef<number | undefined>(undefined); const stateRef = useRef(state); stateRef.current = state;
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
    try {
      // v1 has no Europe/competition context. Never let it stand in for a
      // Europe URL, where its row count could incorrectly normalize `page`.
      if (!options && next.mode === "europe") throw new MessiApiError("network", "European leaderboard options are unavailable");
      dispatch({ type: "resolve", requestId, payload: options ? await fetchLeaderboard(parsed.config, next, abort.signal) : await fetchPlayers(parsed.config, abort.signal) });
    }
    catch (error) {
      if (isAbortError(error)) return;
      if (options && next.mode === "league") try { const fallback = await fetchPlayers(parsed.config, abort.signal); if (!abort.signal.aborted) dispatch({ type: "resolve", requestId, payload: fallback }); return; } catch (fallbackError) { if (isAbortError(fallbackError)) return; dispatch({ type: "reject", requestId, error: apiError(fallbackError) }); return; }
      dispatch({ type: "reject", requestId, error: apiError(error) });
    }
  }, [dataset, options, parsed.config]);

  const probeOptions = useCallback(() => {
    if (!parsed.config) return () => undefined;
    optionsController.current?.abort();
    if (optionsTimer.current !== undefined) window.clearTimeout(optionsTimer.current);
    setOptions(undefined);
    setOptionsResolved(false);
    const abort = new AbortController();
    optionsController.current = abort;
    const requestId = ++optionsRequest.current;
    const timer = window.setTimeout(() => {
      if (!abort.signal.aborted && optionsRequest.current === requestId) {
        // The v2 capability probe is slow: retain the requested URL context, but
        // permit the established v1 fallback flow instead of leaving a permanent skeleton.
        setOptions(undefined);
        setOptionsResolved(true);
      }
    }, 8_000);
    optionsTimer.current = timer;
    const isCurrent = () => !abort.signal.aborted && optionsRequest.current === requestId;
    fetchLeaderboardOptions(parsed.config, abort.signal).then((value) => {
      if (!isCurrent()) return;
      window.clearTimeout(timer);
      optionsTimer.current = undefined;
      setOptions(value);
      const current = datasetRef.current;
      const next = { ...current, season: value.seasons.includes(current.season) ? current.season : value.seasons[0] ?? current.season, competition: value.competitions[current.competition]?.available ? current.competition : "all" };
      if (next.season !== current.season || next.competition !== current.competition) {
        setDataset(next);
        setPage(1);
      }
      setOptionsResolved(true);
    }).catch(() => {
      if (!isCurrent()) return;
      window.clearTimeout(timer);
      optionsTimer.current = undefined;
      setOptions(undefined);
      setOptionsResolved(true);
    });
    return () => {
      if (optionsRequest.current !== requestId) return;
      window.clearTimeout(timer);
      optionsTimer.current = undefined;
      abort.abort();
    };
  }, [parsed.config]);
  useEffect(() => probeOptions(), [probeOptions]);
  // Do not render a v1 fallback payload for a context URL before v2 options have settled:
  // it could incorrectly normalize a valid URL-backed page using the wrong dataset.
  useEffect(() => { if (!parsed.config || !optionsResolved) return; void load(dataset); return () => controller.current?.abort(); }, [dataset, load, optionsResolved, parsed.config]);
  if (parsed.category) return <ConfigErrorFallback category={parsed.category} mode={import.meta.env.MODE} />;
  if (state.type === "idle" || state.type === "loading") return <DashboardLoading />;
  const retry = () => { if (dataset.mode === "europe") probeOptions(); else void load(dataset); };
  if (state.type === "error" && !state.previous) return <DashboardDataFallback error={state.error} onRetry={retry} />;
  const payload = state.type === "error" ? state.previous! : state.payload;
  return <MessiScoutingDashboard players={payload.players} meta={payload.meta} refreshing={state.type === "refreshing"} onRefresh={() => void load(dataset)} refreshWarning={state.type === "error" ? <DashboardDataFallback error={state.error} hasPrevious onRetry={retry} /> : undefined} dataset={dataset} options={options} page={page} onDatasetChange={(next) => writeRoute(next, 1)} onPageChange={(next, replace) => writeRoute(dataset, next, replace)} />;
}
