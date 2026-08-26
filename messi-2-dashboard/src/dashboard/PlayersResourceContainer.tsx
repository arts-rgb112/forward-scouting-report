import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";

import { MessiConfigError, type ConfigErrorCategory, parseMessiApiConfig, type MessiApiConfig } from "../api/env";
import { MessiApiError, isAbortError } from "../api/errors";
import { leaderboardTaxonomyMode } from "../api/duelPressFeatureGate";
import { duelPressV2Enabled } from "../api/duelPressV2FeatureGate";
import { fetchLeaderboard, fetchLeaderboardOptions } from "../api/leaderboardsApi";
import { datasetFromSearch, datasetKeyOf, leaderboardHref, leaderboardSearchFromSearch, preserveExternalQuery } from "./datasetRoute";
import { ConfigErrorFallback } from "./components/ConfigErrorFallback";
import { DashboardDataFallback } from "./components/DashboardDataFallback";
import { DashboardLoading } from "./components/DashboardLoading";
import MessiScoutingDashboard from "./MessiScoutingDashboard";
import { playersResourceReducer, stablePayload } from "./playersResourceState";
import type { DatasetMeta, DatasetRouteState, LeaderboardOptions, LeaderboardSearch, PositionFilterCapability } from "./types";
import { DuelPressPlayersResourceContainer } from "./DuelPressPlayersResourceContainer";

type ParsedConfig = { config?: MessiApiConfig; category?: ConfigErrorCategory };
const fallbackRoute = (config: MessiApiConfig): DatasetRouteState => ({ season: config.season, mode: "league", scope: 8, competition: "all" });
function routeFromUrl(config: MessiApiConfig) { return datasetFromSearch(window.location.search, fallbackRoute(config)); }
function apiError(error: unknown) { return error instanceof MessiApiError ? error : new MessiApiError("network", "Request failed"); }
export function positionWasApplied(meta: DatasetMeta, requested: string) {
  if (!meta.applied || !Object.hasOwn(meta.applied, "position")) return false;
  return requested === "ALL" ? meta.applied.position === null || meta.applied.position === "ALL" : meta.applied.position === requested;
}
export function bandWasApplied(meta: DatasetMeta, key: "ageBand" | "minutesBand", requested: string) {
  if (!meta.applied || !Object.hasOwn(meta.applied, key)) return false;
  const applied = meta.applied[key];
  return requested === "all" ? applied === null || applied === "all" : applied === requested;
}

export function PlayersResourceContainer() {
  if (duelPressV2Enabled(import.meta.env)) return <DuelPressPlayersResourceContainer />;
  if (leaderboardTaxonomyMode(import.meta.env, import.meta.env.MODE) === "duel-press-v1") return <DuelPressPlayersResourceContainer />;
  return <LegacyPlayersResourceContainer />;
}

function LegacyPlayersResourceContainer() {
  const [state, dispatch] = useReducer(playersResourceReducer, { type: "idle" });
  const [options, setOptions] = useState<LeaderboardOptions>();
  const [optionsResolved, setOptionsResolved] = useState(false);
  const [resolvedRouteKey, setResolvedRouteKey] = useState<string>();
  const [resolvedDatasetKey, setResolvedDatasetKey] = useState<string>();
  const resolvedDatasetKeyRef = useRef<string | undefined>(undefined);
  const request = useRef(0); const optionsRequest = useRef(0); const controller = useRef<AbortController | null>(null); const optionsController = useRef<AbortController | null>(null); const optionsTimer = useRef<number | undefined>(undefined); const stateRef = useRef(state); stateRef.current = state;
  const parsed = useMemo((): ParsedConfig => { try { return { config: parseMessiApiConfig(import.meta.env, import.meta.env.MODE) }; } catch (error) { return { category: error instanceof MessiConfigError ? error.category : "CONFIG_INVALID" }; } }, []);
  const [dataset, setDataset] = useState<DatasetRouteState>(() => parsed.config ? routeFromUrl(parsed.config) : { season: "2025/2026", mode: "league", scope: 8, competition: "all" });
  const [search, setSearch] = useState<LeaderboardSearch>(() => leaderboardSearchFromSearch(window.location.search));
  const [positionCapability, setPositionCapability] = useState<PositionFilterCapability>("unknown");
  const [ageCapability, setAgeCapability] = useState<PositionFilterCapability>("unknown");
  const [minutesCapability, setMinutesCapability] = useState<PositionFilterCapability>("unknown");
  const datasetRef = useRef(dataset); datasetRef.current = dataset;
  const searchRef = useRef(search); searchRef.current = search;
  const positionCapabilityRef = useRef(positionCapability); positionCapabilityRef.current = positionCapability;
  const ageCapabilityRef = useRef(ageCapability); ageCapabilityRef.current = ageCapability;
  const minutesCapabilityRef = useRef(minutesCapability); minutesCapabilityRef.current = minutesCapability;
  const routeKey = preserveExternalQuery(leaderboardHref(dataset, search), window.location.search);
  const datasetKey = datasetKeyOf(dataset);

  const writeRoute = useCallback((next: DatasetRouteState, nextSearch: LeaderboardSearch, replace = false) => {
    const canonicalNextKey = leaderboardHref(next, nextSearch);
    if (canonicalNextKey === leaderboardHref(datasetRef.current, searchRef.current)) return;
    const nextKey = preserveExternalQuery(canonicalNextKey, window.location.search);
    if (`${window.location.pathname}${window.location.search}` !== nextKey) {
      window.history[replace ? "replaceState" : "pushState"](null, "", nextKey);
    }
    setDataset(next); setSearch(nextSearch);
  }, []);
  useEffect(() => {
    if (!parsed.config) return;
    if (`${window.location.pathname}${window.location.search}` !== routeKey) window.history.replaceState(null, "", routeKey);
  }, [parsed.config, routeKey]);
  // Shared URLs may carry a once-valid position. Do not advertise or forward it
  // before this server has explicitly echoed that it applied position filtering.
  useEffect(() => {
    if (positionCapability === "supported" || search.position === "ALL") return;
    writeRoute(dataset, { ...search, position: "ALL", page: 1 }, true);
  }, [dataset, positionCapability, search, writeRoute]);
  useEffect(() => {
    if (ageCapability === "supported" || search.ageBand === "all") return;
    writeRoute(dataset, { ...search, ageBand: "all", page: 1 }, true);
  }, [ageCapability, dataset, search, writeRoute]);
  useEffect(() => {
    if (minutesCapability === "supported" || search.minutesBand === "all") return;
    writeRoute(dataset, { ...search, minutesBand: "all", page: 1 }, true);
  }, [dataset, minutesCapability, search, writeRoute]);
  useEffect(() => {
    if (!parsed.config) return;
    const onPopState = () => {
      const next = routeFromUrl(parsed.config!);
      const nextSearch = leaderboardSearchFromSearch(window.location.search);
      if (leaderboardHref(next, nextSearch) === leaderboardHref(datasetRef.current, searchRef.current)) return;
      setDataset(next); setSearch(nextSearch);
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [parsed.config]);

  const load = useCallback(async () => {
    if (!parsed.config) return;
    const next = datasetRef.current;
    const nextSearch = searchRef.current;
    const requestRouteKey = leaderboardHref(next, nextSearch);
    const requestDatasetKey = datasetKeyOf(next);
    controller.current?.abort(); const abort = new AbortController(); controller.current = abort; const requestId = ++request.current;
    const previous = resolvedDatasetKeyRef.current === requestDatasetKey ? stablePayload(stateRef.current) : undefined;
    dispatch({ type: "start", requestId, previous });
    try {
      const requestSearch = {
        ...nextSearch,
        position: positionCapabilityRef.current === "supported" ? nextSearch.position : "ALL",
        ageBand: ageCapabilityRef.current === "supported" ? nextSearch.ageBand : "all",
        minutesBand: minutesCapabilityRef.current === "supported" ? nextSearch.minutesBand : "all",
        page: nextSearch.position !== "ALL" && positionCapabilityRef.current !== "supported" || nextSearch.ageBand !== "all" && ageCapabilityRef.current !== "supported" || nextSearch.minutesBand !== "all" && minutesCapabilityRef.current !== "supported" ? 1 : nextSearch.page,
      };
      const payload = await fetchLeaderboard(parsed.config, next, requestSearch, abort.signal);
      if (request.current !== requestId || abort.signal.aborted) return;
      if (payload.serverPage && positionCapabilityRef.current !== "unsupported") {
        const proven = positionWasApplied(payload.meta, requestSearch.position);
        setPositionCapability(proven ? "supported" : "unsupported");
        // A supposedly supported filter that is not echoed exactly is unsafe:
        // discard it and refetch the unfiltered first page instead of rendering
        // results that could be mislabeled as position-filtered.
        if (requestSearch.position !== "ALL" && !proven) {
          writeRoute(next, { ...nextSearch, position: "ALL", page: 1 }, true);
          return;
        }
      }
      if (payload.serverPage && ageCapabilityRef.current !== "unsupported") setAgeCapability(bandWasApplied(payload.meta, "ageBand", requestSearch.ageBand) ? "supported" : "unsupported");
      if (payload.serverPage && minutesCapabilityRef.current !== "unsupported") setMinutesCapability(bandWasApplied(payload.meta, "minutesBand", requestSearch.minutesBand) ? "supported" : "unsupported");
      setResolvedRouteKey(requestRouteKey);
      resolvedDatasetKeyRef.current = requestDatasetKey;
      setResolvedDatasetKey(requestDatasetKey);
      dispatch({ type: "resolve", requestId, payload });
    }
    catch (error) {
      if (isAbortError(error) || abort.signal.aborted || request.current !== requestId) return;
      dispatch({ type: "reject", requestId, error: apiError(error) });
    }
  }, [parsed.config, writeRoute]);

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
        writeRoute(next, { ...searchRef.current, page: 1 }, true);
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
  }, [parsed.config, writeRoute]);
  useEffect(() => probeOptions(), [probeOptions]);
  const scope8Supported = options?.scopes.some((scope) => scope.value === 8) === true;
  // Do not render a v1 fallback payload for a context URL before v2 options have settled:
  // it could incorrectly normalize a valid URL-backed page using the wrong dataset.
  useEffect(() => {
    if (!parsed.config || !optionsResolved) return;
    if (dataset.mode === "league" && dataset.scope === 8 && !scope8Supported) {
      controller.current?.abort();
      setResolvedRouteKey(undefined);
      resolvedDatasetKeyRef.current = undefined;
      setResolvedDatasetKey(undefined);
      dispatch({ type: "clear" });
      return;
    }
    void load();
    return () => controller.current?.abort();
  }, [dataset.mode, dataset.scope, load, optionsResolved, parsed.config, routeKey, scope8Supported]);
  const resolvedPayload = state.type === "success" || state.type === "empty" ? state.payload : undefined;
  const normalizedPage = resolvedRouteKey === routeKey && resolvedPayload?.serverPage && resolvedPayload.serverPage.totalPages > 0
    ? Math.min(resolvedPayload.serverPage.page, resolvedPayload.serverPage.totalPages)
    : undefined;
  useEffect(() => {
    if (normalizedPage === undefined || normalizedPage === searchRef.current.page) return;
    writeRoute(datasetRef.current, { ...searchRef.current, page: normalizedPage }, true);
  }, [normalizedPage, writeRoute]);
  const handlePageChange = useCallback((next: number, replace?: boolean) => {
    writeRoute(datasetRef.current, { ...searchRef.current, page: next }, replace);
  }, [writeRoute]);
  const handleRefresh = useCallback(() => { void load(); }, [load]);
  const handleDatasetChange = useCallback((next: DatasetRouteState) => {
    setPositionCapability("unknown");
    setAgeCapability("unknown"); setMinutesCapability("unknown");
    writeRoute(next, { ...searchRef.current, page: 1 });
  }, [writeRoute]);
  const handleSearchChange = useCallback((next: LeaderboardSearch, replace?: boolean) => {
    writeRoute(datasetRef.current, next, replace);
  }, [writeRoute]);
  if (parsed.category) return <ConfigErrorFallback category={parsed.category} mode={import.meta.env.MODE} />;
  const scope8Unsupported = dataset.mode === "league" && dataset.scope === 8 && optionsResolved && !scope8Supported;
  if (scope8Unsupported) return <main id="main-content" className="grid min-h-screen place-items-center bg-[#080b0c] p-6 text-zinc-100"><section role="alert" className="max-w-md rounded-lg border border-amber-300/30 bg-[#101415] p-6 text-center"><h1 className="font-bold">현재 선택한 8개 리그 데이터는 이 서버에서 지원되지 않습니다.</h1><p className="mt-2 text-sm text-zinc-400">URL과 저장된 컨텍스트는 변경되지 않았습니다. 사용 가능한 리그 범위를 직접 선택하세요.</p></section></main>;
  // Query/filter/page changes keep this dataset's payload mounted. A true
  // dataset transition must never expose rows retained from the old dataset.
  if (resolvedDatasetKey !== datasetKey && !(state.type === "error" && !state.previous)) return <DashboardLoading />;
  if (state.type === "idle" || state.type === "loading") return <DashboardLoading />;
  const retry = () => { if (dataset.mode === "europe") probeOptions(); else void load(); };
  if (state.type === "error" && !state.previous) return <DashboardDataFallback error={state.error} onRetry={retry} />;
  const payload = state.type === "error" ? state.previous! : state.payload;
  return <MessiScoutingDashboard players={payload.players} meta={payload.meta} serverPage={payload.serverPage} search={search} positionCapability={positionCapability} ageCapability={ageCapability} minutesCapability={minutesCapability} page={search.page} onPageChange={handlePageChange} refreshing={state.type === "refreshing"} onRefresh={handleRefresh} refreshWarning={state.type === "error" ? <DashboardDataFallback error={state.error} hasPrevious onRetry={retry} /> : undefined} dataset={dataset} options={options} onDatasetChange={handleDatasetChange} onSearchChange={handleSearchChange} apiConfig={parsed.config} />;
}
