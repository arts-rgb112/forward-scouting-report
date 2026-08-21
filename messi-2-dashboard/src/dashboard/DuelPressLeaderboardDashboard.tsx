import { useEffect, useMemo, useRef, useState } from "react";

import type { MessiApiConfig } from "../api/env";
import type { DuelPressLeaderboardPayload, DuelPressMetricKey, DuelPressModeContext, DuelPressPlayerCore, DuelPressSearch } from "../api/duelPressTypes";
import { DashboardToolbar } from "./components/DashboardToolbar";
import { DatasetFooter } from "./components/DatasetFooter";
import { DatasetHeader } from "./components/DatasetHeader";
import { DuelPressPlayerCardList, DuelPressPlayerTable } from "./components/DuelPressLeaderboardPresentation";
import { EmptyState } from "./components/EmptyState";
import { LeaderboardPagination } from "./components/LeaderboardPagination";
import { ScoreLegend } from "./components/ScoreLegend";
import { StatusFeedback } from "./components/StatusFeedback";
import { TaxonomyWatchlistView } from "./components/TaxonomyWatchlistView";
import { WatchlistV3Drawer } from "./components/WatchlistV3Drawer";
import { WatchlistV3SortControls } from "./components/WatchlistV3SortControls";
import { duelPressDetailHref } from "./duelPressRoute";
import type { AgeBand, DatasetDisplayMeta, DatasetRouteState, LeaderboardOptions, MinutesBand } from "./types";
import { useOptionalWatchlistV3, WATCHLIST_V3_ENABLED } from "./useWatchlistV3";
import { useVisibleDuelWatchlistResolution } from "./useVisibleDuelWatchlistResolution";
import { useLegacyWatchlistResolution } from "./useLegacyWatchlistResolution";
import { useLegacyWatchlistQuality } from "./useLegacyWatchlistQuality";
import type { DuelPressV3Entry, LegacyV3Entry } from "./watchlistV3Contracts";
import { defaultWatchlistV3Filters, watchlistV3Page, type WatchlistV3Filters } from "./watchlistV3ViewModel";
import { useMetricRanks, type MetricRankTarget } from "./useMetricRanks";

type Props = { payload: DuelPressLeaderboardPayload; apiConfig?: MessiApiConfig; dataset: DatasetRouteState; options?: LeaderboardOptions; search: DuelPressSearch; refreshing: boolean; onRefresh(): void; onDatasetChange(state: DatasetRouteState): void; onSearchChange(search: DuelPressSearch, replace?: boolean): void; onPageChange(page: number): void; warning?: React.ReactNode };
export function duelPressDisplayMeta(meta: DuelPressLeaderboardPayload["meta"]): DatasetDisplayMeta { return { schemaVersion: meta.schemaVersion, season: meta.season, scope: meta.scope, population: meta.population, totalItems: meta.totalItems, returned: meta.returned, generatedAt: meta.generatedAt, source: meta.source, mode: meta.mode, competition: meta.competition }; }
const contextFromDataset = (dataset: DatasetRouteState): DuelPressModeContext => dataset.mode === "league" ? { season: dataset.season, mode: "league", scope: dataset.scope, competition: "all" } : { season: dataset.season, mode: "europe", scope: null, competition: dataset.competition };
const contextFromPayload = (payload: DuelPressLeaderboardPayload): DuelPressModeContext => payload.meta.mode === "league" ? { season: payload.meta.season, mode: "league", scope: payload.meta.scope!, competition: "all" } : { season: payload.meta.season, mode: "europe", scope: null, competition: payload.meta.competition! };
const leaderboardMetricRankKey = (playerId: number) => `leaderboard:${playerId}`;
export function watchlistMetricRankTargets(entries: readonly DuelPressV3Entry[], resolutions: Readonly<Record<string, import("./duelPressWatchlistResolver").DuelWatchlistResolution>>, preferences: Readonly<Record<string, "saved" | "current">>): MetricRankTarget[] {
  // Do not fan out A → A+B → A+B+C as the visible resolver finishes. A rank
  // batch starts only when every visible duel context reached a terminal state.
  if (!entries.every((entry) => { const resolution = resolutions[entry.key]; return resolution !== undefined && resolution.status !== "pending"; })) return [];
  return entries.flatMap((entry) => {
    const resolved = resolutions[entry.key];
    return preferences[entry.key] !== "saved" && resolved?.status === "current" && resolved.player?.id === entry.playerId && resolved.player.idNamespace === "fotmob"
      ? [{ key: entry.key, playerId: entry.playerId, context: entry.context }]
      : [];
  });
}

export default function DuelPressLeaderboardDashboard({ payload, apiConfig, dataset, options, search, refreshing, onRefresh, onDatasetChange, onSearchChange, onPageChange, warning }: Props) {
  const v3 = useOptionalWatchlistV3(); const enabled = WATCHLIST_V3_ENABLED && Boolean(v3); const context = useMemo(() => contextFromDataset(dataset), [dataset]);
  const [watchFilters, setWatchFilters] = useState<WatchlistV3Filters>(defaultWatchlistV3Filters); const [retryEpoch, setRetryEpoch] = useState(0);
  const resultsSummaryRef = useRef<HTMLParagraphElement>(null);
  const viewMode = enabled ? v3!.viewMode : "leaderboard"; const isWatchlist = viewMode === "watchlist";
  const update = (patch: Partial<DuelPressSearch>, replace = false) => onSearchChange({ ...search, ...patch, page: patch.page ?? 1 }, replace);
  const sort = (key: "score" | DuelPressMetricKey) => update({ sort: key, direction: search.sort === key && search.direction === "desc" ? "asc" : "desc", page: 1 });
  const resetLeaderboard = () => onSearchChange({ page: 1, pageSize: 50, q: "", role: "all", position: "ALL", ageBand: "all", minutesBand: "all", sort: "score", direction: "desc" });
  const patchWatchFilters = (patch: Partial<WatchlistV3Filters>) => { setWatchFilters((current) => ({ ...current, ...patch })); v3!.setWatchlistPage(1); };
  const reset = () => { if (isWatchlist) { setWatchFilters(defaultWatchlistV3Filters); v3!.setWatchlistPage(1); } else resetLeaderboard(); };
  const meta = duelPressDisplayMeta(payload.meta); const total = payload.meta.totalItems;
  const start = payload.players.length ? (payload.meta.page - 1) * payload.meta.pageSize + 1 : 0; const end = start ? start + payload.players.length - 1 : 0;
  const range = payload.players.length ? `${start}–${end} of ${total}` : `0 of ${total}`; const presentationSort = { key: search.sort, direction: search.direction };
  const watchView = useMemo(() => watchlistV3Page(enabled ? v3!.entries : [], watchFilters, enabled ? v3!.watchlistPage : 1), [enabled, v3?.entries, v3?.watchlistPage, watchFilters]); const watchPage = watchView.page;
  useEffect(() => { if (enabled && v3!.watchlistPage !== watchPage) v3!.setWatchlistPage(watchPage); }, [enabled, v3, watchPage]);
  const visibleEntries = watchView.visible;
  const visibleDuel = useMemo(() => visibleEntries.filter((entry): entry is DuelPressV3Entry => entry.taxonomy === "duel-press-v1"), [visibleEntries]);
  const visibleLegacy = useMemo(() => visibleEntries.filter((entry): entry is LegacyV3Entry => entry.taxonomy === "legacy-v1"), [visibleEntries]);
  const resolutions = useVisibleDuelWatchlistResolution(apiConfig, visibleDuel, enabled && isWatchlist, retryEpoch);
  const legacyResolutions = useLegacyWatchlistResolution(apiConfig, visibleLegacy, enabled && isWatchlist, retryEpoch);
  const legacyQuality = useLegacyWatchlistQuality(apiConfig, visibleLegacy, legacyResolutions, enabled && isWatchlist);
  const pending = Object.values(resolutions).some((resolution) => resolution.status === "pending") || Object.values(legacyResolutions).some((resolution) => resolution.status === "pending");
  const canonicalContext = useMemo(() => contextFromPayload(payload), [payload]);
  const leaderboardRankTargets = useMemo<MetricRankTarget[]>(() => !isWatchlist ? payload.players.slice(0, 50).map((player) => ({ key: leaderboardMetricRankKey(player.id), playerId: player.id, context: canonicalContext })) : [], [canonicalContext, isWatchlist, payload.players]);
  const watchlistRankTargets = useMemo<MetricRankTarget[]>(() => isWatchlist ? watchlistMetricRankTargets(visibleDuel, resolutions, v3!.displayPreference) : [], [isWatchlist, resolutions, v3?.displayPreference, visibleDuel]);
  const metricRanks = useMetricRanks(apiConfig, isWatchlist ? watchlistRankTargets : leaderboardRankTargets, Boolean(apiConfig));
  const leaderboardMetricRanks = useMemo(() => Object.fromEntries(payload.players.map((player) => [player.id, metricRanks[leaderboardMetricRankKey(player.id)] ?? {}])), [metricRanks, payload.players]);
  const watchRange = visibleEntries.length ? `${watchView.start}–${watchView.end} of ${watchView.total} saved contexts` : `0 of ${watchView.total} saved contexts`;
  const watch = enabled ? { available: true, isWatched: (player: DuelPressPlayerCore) => v3!.isWatched("duel-press-v1", player.id, context), onToggle: (player: DuelPressPlayerCore) => { v3!.toggleDuel(player, context); }, accessibleLabel: (player: DuelPressPlayerCore) => `${v3!.isWatched("duel-press-v1", player.id, context) ? "Remove" : "Save"} ${player.name}, ${context.season}, ${context.mode === "league" ? `${context.scope} leagues` : `Europe ${context.competition.toUpperCase()}`}, duel and press taxonomy` } : undefined;
  return <main id="main-content" aria-busy={isWatchlist ? pending : refreshing} className="min-h-screen bg-[#080b0c] text-zinc-100"><StatusFeedback message={enabled ? v3!.feedback : ""} /><div className="mx-auto max-w-[1580px] px-3 py-5 sm:px-6 lg:px-8">
    <DatasetHeader meta={meta} visibleCount={isWatchlist ? watchView.total : payload.players.length} refreshing={isWatchlist ? pending : refreshing} onRefresh={isWatchlist ? () => setRetryEpoch((value) => value + 1) : onRefresh} state={dataset} options={options} onStateChange={onDatasetChange} watchlistMode={isWatchlist} />
    {!isWatchlist && warning}
    <DashboardToolbar isRefreshing={!isWatchlist && refreshing} query={isWatchlist ? watchFilters.query : search.q} role={isWatchlist ? watchFilters.role : search.role === "all" ? "ALL" : search.role} position={isWatchlist ? watchFilters.position : search.position} ageBand={isWatchlist ? watchFilters.ageBand : search.ageBand === "u25" ? "23-25" : search.ageBand} minutesBand={isWatchlist ? watchFilters.minutesBand : search.minutesBand} positionCapability="supported" ageCapability="supported" minutesCapability="supported" watchOnly={false} watchCount={enabled ? v3!.watchCount : 0} watchAvailable={enabled} viewMode={viewMode} onViewModeChange={(mode) => v3?.setViewMode(mode)} onOpenWatchlist={() => v3?.setDrawerOpen(true)} resultLabel={isWatchlist ? `${watchView.total} saved contexts` : payload.players.length ? `${payload.players.length} shown · ${total} results` : `0 shown · ${total} results`} hasFilters={isWatchlist ? JSON.stringify(watchFilters) !== JSON.stringify(defaultWatchlistV3Filters) : Boolean(search.q || search.role !== "all" || search.position !== "ALL" || search.ageBand !== "all" || search.minutesBand !== "all" || search.sort !== "score" || search.direction !== "desc")} players={payload.players} dataset={dataset} onPlayerSuggestionSelect={(player) => window.location.assign(duelPressDetailHref(player.id, dataset))} onQueryChange={(q) => isWatchlist ? patchWatchFilters({ query: q }) : update({ q }, true)} onRoleChange={(role) => { if (isWatchlist) patchWatchFilters({ role: role === "Type A" || role === "Type B" ? role : "ALL" }); else update({ role: role === "Type A" || role === "Type B" ? role : "all" }); }} onPositionChange={(position) => isWatchlist ? patchWatchFilters({ position }) : update({ position })} onAgeBandChange={(ageBand) => isWatchlist ? patchWatchFilters({ ageBand: ageBand as AgeBand }) : update({ ageBand: ageBand === "23-25" ? "u25" : ageBand })} onMinutesBandChange={(minutesBand) => isWatchlist ? patchWatchFilters({ minutesBand: minutesBand as MinutesBand }) : update({ minutesBand })} onWatchOnlyChange={() => undefined} onReset={reset} />
    {!isWatchlist && <ScoreLegend />}
    <section aria-label={isWatchlist ? "Watchlist results" : "Leaderboard results"} className="scroll-mt-4">{isWatchlist && <WatchlistV3SortControls sort={watchFilters.sort} direction={watchFilters.direction} onChange={(nextSort, direction) => patchWatchFilters({ sort: nextSort, direction })} />}<p ref={resultsSummaryRef} tabIndex={-1} aria-label={isWatchlist ? "Watchlist results summary" : undefined} className="mb-1 text-xs font-bold text-zinc-400">{isWatchlist ? watchRange : `${range} players`}</p><p role="status" aria-live="polite" className="mb-3 min-h-5 text-xs text-zinc-500">{isWatchlist ? (pending ? "Refreshing visible saved contexts; snapshots remain visible." : "") : refreshing ? `Loading page ${payload.meta.page}.` : ""}</p>{isWatchlist ? (visibleEntries.length ? <><TaxonomyWatchlistView entries={visibleEntries} resolutions={resolutions} legacyResolutions={legacyResolutions} legacyQuality={legacyQuality} metricRanks={metricRanks} preferences={v3!.displayPreference} fallbackFocusRef={resultsSummaryRef} sort={watchFilters.sort} direction={watchFilters.direction} onMetricSort={(key) => patchWatchFilters({ sort: key, direction: watchFilters.sort === key && watchFilters.direction === "desc" ? "asc" : "desc" })} onPreference={v3!.setDisplayPreference} onRemove={v3!.remove} onRetry={() => setRetryEpoch((value) => value + 1)} /><LeaderboardPagination page={watchPage} total={watchView.total} pageSize={50} onPageChange={v3!.setWatchlistPage} /></> : <div className="rounded-lg border border-dashed border-white/15 p-6 text-sm text-zinc-400">{v3!.watchCount ? "No saved contexts match these filters." : "No saved contexts yet. Save a player from a leaderboard context to see it here."}</div>) : payload.players.length ? <><DuelPressPlayerCardList players={payload.players} dataset={dataset} sort={presentationSort} onMetricSort={sort} watch={watch} metricRanksByPlayerId={leaderboardMetricRanks} /><DuelPressPlayerTable players={payload.players} dataset={dataset} sort={presentationSort} onMetricSort={sort} watch={watch} metricRanksByPlayerId={leaderboardMetricRanks} /><LeaderboardPagination page={payload.meta.page} total={total} pageSize={50} pending={refreshing} onPageChange={onPageChange} /></> : <EmptyState onReset={reset} />}</section>
    <DatasetFooter meta={meta} resultRange={isWatchlist ? watchRange : range} />
  </div>{enabled && <WatchlistV3Drawer open={v3!.drawerOpen} entries={v3!.entries} selectedKeys={v3!.envelope.selectedEntryKeys} feedback={v3!.feedback} onClose={() => v3!.setDrawerOpen(false)} onRemove={v3!.remove} onToggleSelection={v3!.toggleSelection} />}</main>;
}
