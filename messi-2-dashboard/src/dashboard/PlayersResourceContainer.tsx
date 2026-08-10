import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";

import { MessiConfigError, type ConfigErrorCategory, parseMessiApiConfig, type MessiApiConfig } from "../api/env";
import { MessiApiError, isAbortError } from "../api/errors";
import { fetchLeaderboard, fetchLeaderboardOptions } from "../api/leaderboardsApi";
import { fetchPlayers } from "../api/playersApi";
import { ConfigErrorFallback } from "./components/ConfigErrorFallback";
import { DashboardDataFallback } from "./components/DashboardDataFallback";
import { DashboardLoading } from "./components/DashboardLoading";
import MessiScoutingDashboard from "./MessiScoutingDashboard";
import { playersResourceReducer, stablePayload } from "./playersResourceState";
import type { DatasetRouteState, LeaderboardOptions } from "./types";

type ParsedConfig = { config?: MessiApiConfig; category?: ConfigErrorCategory };

function routeFromUrl(config: MessiApiConfig): DatasetRouteState {
  const query = new URLSearchParams(window.location.search);
  return {
    season: query.get("season") ?? config.season,
    mode: query.get("mode") === "europe" ? "europe" : "league",
    scope: ([3, 5, 7].includes(Number(query.get("scope"))) ? Number(query.get("scope")) : config.scope) as 3 | 5 | 7,
    competition: (["all", "ucl", "uel", "uecl"].includes(query.get("competition") ?? "") ? query.get("competition") : "all") as DatasetRouteState["competition"],
  };
}

function writeRoute(state: DatasetRouteState) {
  const query = new URLSearchParams({
    season: state.season,
    mode: state.mode,
    scope: String(state.scope),
    competition: state.competition,
  });
  window.history.replaceState(null, "", `${window.location.pathname}?${query.toString()}`);
}

function apiError(error: unknown) {
  return error instanceof MessiApiError ? error : new MessiApiError("network", "Request failed");
}

export function PlayersResourceContainer() {
  const [state, dispatch] = useReducer(playersResourceReducer, { type: "idle" });
  const [options, setOptions] = useState<LeaderboardOptions>();
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

  const [dataset, setDataset] = useState<DatasetRouteState>(() => parsed.config
    ? routeFromUrl(parsed.config)
    : { season: "2025/2026", mode: "league", scope: 7, competition: "all" });

  useEffect(() => {
    if (!parsed.config) return;
    const onPopState = () => setDataset(routeFromUrl(parsed.config!));
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [parsed.config]);

  const load = useCallback(async (next = dataset) => {
    if (!parsed.config) return;
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    const requestId = ++request.current;
    dispatch({ type: "start", requestId, previous: stablePayload(stateRef.current) });

    try {
      const payload = options
        ? await fetchLeaderboard(parsed.config, next, abort.signal)
        : await fetchPlayers(parsed.config, abort.signal);
      dispatch({ type: "resolve", requestId, payload });
    } catch (error) {
      if (isAbortError(error)) return;

      // Keep the dashboard usable if a newly introduced v2 endpoint is unavailable.
      if (options) {
        try {
          const fallback = await fetchPlayers(parsed.config, abort.signal);
          if (!abort.signal.aborted) dispatch({ type: "resolve", requestId, payload: fallback });
          return;
        } catch (fallbackError) {
          if (isAbortError(fallbackError)) return;
          dispatch({ type: "reject", requestId, error: apiError(fallbackError) });
          return;
        }
      }

      dispatch({ type: "reject", requestId, error: apiError(error) });
    }
  }, [dataset, options, parsed.config]);

  useEffect(() => {
    if (!parsed.config) return;
    const abort = new AbortController();
    fetchLeaderboardOptions(parsed.config, abort.signal)
      .then((value) => {
        setOptions(value);
        setDataset((current) => {
          const season = value.seasons.includes(current.season) ? current.season : value.seasons[0] ?? current.season;
          const competition = value.competitions[current.competition]?.available ? current.competition : "all";
          return { ...current, season, competition };
        });
      })
      .catch(() => setOptions(undefined));
    return () => abort.abort();
  }, [parsed.config]);

  useEffect(() => {
    if (!parsed.config) return;
    writeRoute(dataset);
    void load(dataset);
    return () => controller.current?.abort();
  }, [dataset, load, parsed.config]);

  if (parsed.category) return <ConfigErrorFallback category={parsed.category} mode={import.meta.env.MODE} />;
  if (state.type === "idle" || state.type === "loading") return <DashboardLoading />;
  if (state.type === "error" && !state.previous) return <DashboardDataFallback error={state.error} onRetry={() => void load(dataset)} />;

  const payload = state.type === "error" ? state.previous! : state.payload;
  return <MessiScoutingDashboard players={payload.players} meta={payload.meta} refreshing={state.type === "refreshing"} onRefresh={() => void load(dataset)} refreshWarning={state.type === "error" ? <DashboardDataFallback error={state.error} hasPrevious onRetry={() => void load(dataset)} /> : undefined} dataset={dataset} options={options} onDatasetChange={setDataset} />;
}
