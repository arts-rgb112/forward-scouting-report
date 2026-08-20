import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { MessiApiConfig } from "../api/env";
import { resolveWatchlistEntries, type ResolvedWatchlistEntry } from "../api/watchlistResolveApi";
import { fetchWatchlistDataQuality } from "../api/dataQualityApi";
import { DashboardToolbar } from "./components/DashboardToolbar";
import { DatasetFooter } from "./components/DatasetFooter";
import { DatasetHeader } from "./components/DatasetHeader";
import { EmptyState } from "./components/EmptyState";
import { LeaderboardPagination } from "./components/LeaderboardPagination";
import { PlayerCardList } from "./components/PlayerCardList";
import { PlayerTable } from "./components/PlayerTable";
import { ScoreLegend } from "./components/ScoreLegend";
import { resolveTierPresentation } from "./scoutingConfig";
import { StatusFeedback } from "./components/StatusFeedback";
import { WatchlistCardList } from "./components/WatchlistCardList";
import { WatchlistDrawer } from "./components/WatchlistDrawer";
import { WatchlistV3Drawer } from "./components/WatchlistV3Drawer";
import { WatchlistV3SortControls } from "./components/WatchlistV3SortControls";
import { TaxonomyWatchlistView } from "./components/TaxonomyWatchlistView";
import { WatchlistTable } from "./components/WatchlistTable";
import { PAGE_SIZE } from "./datasetRoute";
import { filterAndSortPlayers } from "./playerQuery";
import type { AgeBand, DatasetMeta, DatasetRouteState, LeaderboardOptions, LeaderboardSearch, MinutesBand, Player, PositionFilterCapability, ServerPageMeta, SortKey, SortState } from "./types";
import { contextFromDataset, entryFromPlayer, readWatchlist, removeWatchlistEntry, resolveUnresolvedLegacyIds, toggleWatchlistSelection, watchlistKey, writeWatchlist } from "./watchlistStorage";
import { filterAndSortWatchlistRows, watchlistPage, watchlistRows } from "./watchlistViewModel";
import { watchlistQualityDisplays, type QualityDisplay } from "./dataQualityViewModel";
import { useOptionalWatchlistV3, WATCHLIST_V3_ENABLED } from "./useWatchlistV3";
import type { DuelPressModeContext } from "../api/duelPressTypes";
import { useVisibleDuelWatchlistResolution } from "./useVisibleDuelWatchlistResolution";
import { useLegacyWatchlistResolution } from "./useLegacyWatchlistResolution";
import { useLegacyWatchlistQuality } from "./useLegacyWatchlistQuality";
import type { DuelPressV3Entry, LegacyV3Entry } from "./watchlistV3Contracts";
import { defaultWatchlistV3Filters, watchlistV3Page, type WatchlistV3CommonSort, type WatchlistV3Filters } from "./watchlistV3ViewModel";

export type MessiScoutingDashboardProps = {
  players: readonly Player[]; meta: DatasetMeta; refreshing: boolean; onRefresh(): void; refreshWarning?: React.ReactNode;
  dataset?: DatasetRouteState; options?: LeaderboardOptions; onDatasetChange?(next: DatasetRouteState): void;
  page?: number; onPageChange?(page: number, replace?: boolean): void; serverPage?: ServerPageMeta;
  search?: LeaderboardSearch; positionCapability?: PositionFilterCapability; ageCapability?: PositionFilterCapability; minutesCapability?: PositionFilterCapability; onSearchChange?(next: LeaderboardSearch, replace?: boolean): void;
  apiConfig?: MessiApiConfig;
};

export default function MessiScoutingDashboard({
  players, meta, refreshing, onRefresh, refreshWarning, apiConfig,
  dataset = { season: meta.season, mode: "league", scope: meta.scope ?? 8, competition: "all" },
  options, onDatasetChange = () => undefined, page = 1, onPageChange = () => undefined,
  serverPage, search, positionCapability = "unknown", ageCapability = "unknown", minutesCapability = "unknown", onSearchChange = () => undefined,
}: MessiScoutingDashboardProps) {
  const v3 = useOptionalWatchlistV3(); const watchV3Enabled = WATCHLIST_V3_ENABLED && Boolean(v3);
  const currentContext = useMemo(() => contextFromDataset(dataset), [dataset.competition, dataset.mode, dataset.scope, dataset.season]);
  const currentV3Context = useMemo<DuelPressModeContext>(() => dataset.mode === "league" ? { season: dataset.season, mode: "league", scope: dataset.scope, competition: "all" } : { season: dataset.season, mode: "europe", scope: null, competition: dataset.competition }, [dataset.competition, dataset.mode, dataset.scope, dataset.season]);
  const [localQuery, setLocalQuery] = useState(""); const [localRole, setLocalRole] = useState("ALL");
  const [localSort, setLocalSort] = useState<SortState>({ key: "score", direction: "desc" });
  const [watchlist, setWatchlist] = useState(() => readWatchlist(players, currentContext));
  const [viewMode, setViewMode] = useState<"leaderboard" | "watchlist">("leaderboard");
  const [watchQuery, setWatchQuery] = useState(""); const [watchRole, setWatchRole] = useState("ALL"); const [watchPosition, setWatchPosition] = useState("ALL"); const [watchAgeBand, setWatchAgeBand] = useState<AgeBand>("all"); const [watchMinutesBand, setWatchMinutesBand] = useState<MinutesBand>("all");
  const [watchSort, setWatchSort] = useState<SortState>({ key: "score", direction: "desc" }); const [watchPage, setWatchPage] = useState(1);
  const [v3Sort, setV3Sort] = useState<WatchlistV3CommonSort>(defaultWatchlistV3Filters.sort); const [v3Direction, setV3Direction] = useState<"asc" | "desc">(defaultWatchlistV3Filters.direction);
  const [resolvedWatchlist, setResolvedWatchlist] = useState<Record<string, ResolvedWatchlistEntry>>({});
  const [resolvingWatchlist, setResolvingWatchlist] = useState(false); const [resolverStatus, setResolverStatus] = useState("");
  const [watchlistQuality, setWatchlistQuality] = useState<Record<string, QualityDisplay>>({});
  // Changes only when a new resolve attempt starts. This lets an explicit retry refresh a
  // stable-looking page once, without allowing ordinary recomputation to duplicate a batch.
  const [resolveEpoch, setResolveEpoch] = useState(0);
  const [watchlistOpen, setWatchlistOpen] = useState(false); const [feedback, setFeedback] = useState("");
  const leaderboardRef = useRef<HTMLElement>(null); const resultsSummaryRef = useRef<HTMLParagraphElement>(null); const previousPage = useRef(page); const previousWatchPage = useRef(watchPage);
  const resolverRequest = useRef(0); const resolverController = useRef<AbortController | null>(null);
  const qualityRequest = useRef(0); const qualityController = useRef<AbortController | null>(null); const qualityBatchKey = useRef<string | undefined>(undefined);

  useEffect(() => { if (!watchV3Enabled) writeWatchlist(watchlist); }, [watchV3Enabled, watchlist]);
  useEffect(() => { if (!watchV3Enabled) setWatchlist((current) => resolveUnresolvedLegacyIds(current, players, currentContext)); }, [currentContext, players, watchV3Enabled]);
  const invalidateWatchlistQuality = useCallback(() => {
    qualityRequest.current += 1;
    qualityController.current?.abort();
    qualityController.current = null;
    qualityBatchKey.current = undefined;
    setWatchlistQuality({});
  }, []);
  const resolveSavedContexts = useCallback(async () => {
    resolverController.current?.abort();
    invalidateWatchlistQuality();
    setResolveEpoch((value) => value + 1);
    const controller = new AbortController();
    resolverController.current = controller;
    const requestId = ++resolverRequest.current;
    // A retry must never keep an old response when a key is missing, invalid, or unavailable.
    const requestedKeys = new Set(watchlist.entries.map((entry) => entry.key));
    setResolvedWatchlist((current) => Object.fromEntries(Object.entries(current).filter(([key]) => !requestedKeys.has(key))));
    if (watchV3Enabled) { setResolvingWatchlist(false); setResolverStatus(""); return; }
    if (!watchlist.entries.length) { setResolvingWatchlist(false); setResolverStatus("No saved contexts to resolve."); return; }
    if (!apiConfig) { setResolvingWatchlist(false); setResolverStatus("Resolver unavailable; showing saved snapshots."); return; }
    setResolvingWatchlist(true); setResolverStatus("Resolving saved contexts; snapshots remain visible.");
    try {
      const results = await resolveWatchlistEntries(apiConfig, watchlist.entries, controller.signal);
      if (controller.signal.aborted || requestId !== resolverRequest.current) return;
      setResolvedWatchlist((current) => {
        const next = { ...current };
        // Store only a validated current profile. unavailable/invalid/missing results stay on
        // their immutable snapshot instead of retaining an obsolete resolved profile.
        for (const result of results) if (requestedKeys.has(result.key) && result.status === "resolved" && result.player) next[result.key] = result;
        return next;
      });
      const validResolved = results.filter((result) => result.status === "resolved" && result.player).length;
      const invalid = results.filter((result) => result.status === "invalid_context").length;
      const unavailable = results.length - validResolved - invalid;
      const missing = Math.max(0, watchlist.entries.length - new Set(results.map((result) => result.key)).size);
      setResolverStatus(missing
        ? `Resolver response missing ${missing} saved context${missing === 1 ? "" : "s"}; showing saved snapshots.`
        : invalid || unavailable
          ? `Resolved ${validResolved} saved context${validResolved === 1 ? "" : "s"}; ${invalid ? `${invalid} invalid context${invalid === 1 ? "" : "s"}` : ""}${invalid && unavailable ? " and " : ""}${unavailable ? `${unavailable} unavailable context${unavailable === 1 ? "" : "s"}` : ""} retain snapshots.`
          : "Saved contexts resolved with current server data.");
    } catch {
      if (!controller.signal.aborted && requestId === resolverRequest.current) setResolverStatus("Saved-context resolver failed; showing saved snapshots.");
    } finally { if (requestId === resolverRequest.current) setResolvingWatchlist(false); }
  }, [apiConfig, invalidateWatchlistQuality, watchlist.entries, watchV3Enabled]);
  const invalidateWatchlistResolve = () => { resolverRequest.current += 1; resolverController.current?.abort(); };
  useEffect(() => {
    if (viewMode === "watchlist") { void resolveSavedContexts(); return () => resolverController.current?.abort(); }
    resolverRequest.current += 1; resolverController.current?.abort();
    return undefined;
  }, [resolveSavedContexts, viewMode]);

  const serverDriven = Boolean(serverPage && search);
  const normalQuery = serverDriven ? search!.q : localQuery; const normalRole = serverDriven ? (search!.role === "all" ? "ALL" : search!.role) : localRole;
  const normalPosition = serverDriven ? search!.position : "ALL"; const normalAgeBand = serverDriven ? search!.ageBand : "all"; const normalMinutesBand = serverDriven ? search!.minutesBand : "all"; const normalSort: SortState = serverDriven ? { key: search!.sort, direction: search!.direction } : localSort;
  const displayed = useMemo(() => serverDriven ? players : filterAndSortPlayers(players, { query: normalQuery, role: normalRole, sort: normalSort, watchOnly: false, watchlistIds: [] }), [players, normalQuery, normalRole, normalSort, serverDriven]);
  const totalPages = serverDriven ? Math.max(1, serverPage!.totalPages) : Math.max(1, Math.ceil(displayed.length / PAGE_SIZE)); const safePage = Math.min(Math.max(1, page), totalPages);
  const pagePlayers = useMemo(() => serverDriven ? displayed : displayed.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE), [displayed, safePage, serverDriven]);
  useEffect(() => { if (viewMode === "leaderboard" && page !== safePage) onPageChange(safePage, true); }, [onPageChange, page, safePage, viewMode]);
  useEffect(() => { if (viewMode === "leaderboard" && previousPage.current !== safePage) { leaderboardRef.current?.scrollIntoView?.({ behavior: "smooth", block: "start" }); resultsSummaryRef.current?.focus({ preventScroll: true }); } previousPage.current = safePage; }, [safePage, viewMode]);

  const watchedKeys = useMemo(() => watchV3Enabled ? new Set(players.filter((player) => v3!.isWatched("legacy-v1", player.id, currentV3Context)).map((player) => watchlistKey(player.id, currentContext))) : new Set(watchlist.entries.map((entry) => entry.key)), [currentContext, currentV3Context, players, v3, watchV3Enabled, watchlist.entries]);
  const allWatchRows = useMemo(() => watchlistRows(watchlist.entries, resolvedWatchlist), [resolvedWatchlist, watchlist.entries]);
  const filteredWatchRows = useMemo(() => filterAndSortWatchlistRows(allWatchRows, { query: watchQuery, role: watchRole, position: watchPosition, ageBand: watchAgeBand, minutesBand: watchMinutesBand, sort: watchSort }), [allWatchRows, watchAgeBand, watchMinutesBand, watchPosition, watchQuery, watchRole, watchSort]);
  const legacyPartialCount = useMemo(() => allWatchRows.filter((row) => row.source === "legacy-partial").length, [allWatchRows]);
  const localWatchPage = useMemo(() => watchlistPage(filteredWatchRows, watchPage), [filteredWatchRows, watchPage]);
  useEffect(() => { if (watchPage !== localWatchPage.page) setWatchPage(localWatchPage.page); }, [localWatchPage.page, watchPage]);
  useEffect(() => {
    if (viewMode === "watchlist" && previousWatchPage.current !== localWatchPage.page) { leaderboardRef.current?.scrollIntoView?.({ behavior: "smooth", block: "start" }); resultsSummaryRef.current?.focus({ preventScroll: true }); }
    previousWatchPage.current = localWatchPage.page;
  }, [localWatchPage.page, viewMode]);
  // Companion quality is intentionally page-scoped and memory-only. It never participates in
  // resolve, sorting, snapshots, or localStorage, and is shown only after the primary resolve
  // has produced an exact current profile with the same key/context.
  const currentVisibleEntries = useMemo(() => localWatchPage.rows
    .filter((row) => row.source === "current")
    .map((row) => row.entry), [localWatchPage.rows]);
  useEffect(() => {
    if (watchV3Enabled || viewMode !== "watchlist" || !apiConfig || !currentVisibleEntries.length) {
      qualityController.current?.abort(); qualityController.current = null; qualityRequest.current += 1; qualityBatchKey.current = undefined;
      setWatchlistQuality({});
      return;
    }
    const entries = currentVisibleEntries;
    const batchKey = `${resolveEpoch}:${entries.map((entry) => entry.key).join("|")}`;
    // React recomputation may replace the rows array without changing the resolved visible
    // page. One resolve generation and one exact target set must produce one request only.
    if (qualityBatchKey.current === batchKey) return;
    qualityController.current?.abort(); const requestId = ++qualityRequest.current;
    qualityBatchKey.current = batchKey;
    const controller = new AbortController(); qualityController.current = controller;
    setWatchlistQuality(Object.fromEntries(entries.map((entry) => [entry.key, { kind: "pending" } satisfies QualityDisplay])));
    void fetchWatchlistDataQuality(apiConfig, entries, controller.signal).then((results) => {
      if (!controller.signal.aborted && requestId === qualityRequest.current) setWatchlistQuality(watchlistQualityDisplays(entries, results));
    }).catch((error: unknown) => {
      if (!controller.signal.aborted && requestId === qualityRequest.current) {
        const cause = error instanceof Error && "kind" in error && (error as { kind?: string }).kind === "http" ? "http" : error instanceof Error && "kind" in error && (error as { kind?: string }).kind === "network" ? "network" : "schema";
        setWatchlistQuality(Object.fromEntries(entries.map((entry) => [entry.key, { kind: "unknown", cause } satisfies QualityDisplay])));
      }
    });
    return () => controller.abort();
  }, [apiConfig, currentVisibleEntries, resolveEpoch, viewMode, watchV3Enabled]);

  const updateServerSearch = useCallback((patch: Partial<LeaderboardSearch>, replace = false) => { if (search) onSearchChange({ ...search, ...patch, page: patch.page ?? 1 }, replace); }, [onSearchChange, search]);
  const query = viewMode === "watchlist" ? watchQuery : normalQuery; const role = viewMode === "watchlist" ? watchRole : normalRole; const position = viewMode === "watchlist" ? watchPosition : normalPosition; const ageBand = viewMode === "watchlist" ? watchAgeBand : normalAgeBand; const minutesBand = viewMode === "watchlist" ? watchMinutesBand : normalMinutesBand; const sort = viewMode === "watchlist" ? watchSort : normalSort;
  const hasFilters = viewMode === "watchlist" ? Boolean(watchQuery || watchRole !== "ALL" || watchPosition !== "ALL" || watchAgeBand !== "all" || watchMinutesBand !== "all" || (watchV3Enabled ? v3Sort !== "savedAt" || v3Direction !== "desc" : watchSort.key !== "score" || watchSort.direction !== "desc")) : Boolean(normalQuery || normalRole !== "ALL" || normalPosition !== "ALL" || normalAgeBand !== "all" || normalMinutesBand !== "all" || normalSort.key !== "score" || normalSort.direction !== "desc");
  const resetFilters = useCallback(() => { if (viewMode === "watchlist") { setWatchQuery(""); setWatchRole("ALL"); setWatchPosition("ALL"); setWatchAgeBand("all"); setWatchMinutesBand("all"); setWatchSort({ key: "score", direction: "desc" }); setV3Sort("savedAt"); setV3Direction("desc"); setWatchPage(1); v3?.setWatchlistPage(1); } else if (serverDriven) updateServerSearch({ q: "", role: "all", position: "ALL", ageBand: "all", minutesBand: "all", sort: "score", direction: "desc", page: 1 }); else { setLocalQuery(""); setLocalRole("ALL"); setLocalSort({ key: "score", direction: "desc" }); onPageChange(1); } }, [onPageChange, serverDriven, updateServerSearch, v3, viewMode]);
  const resetWatchPage = useCallback(() => { setWatchPage(1); if (watchV3Enabled) v3!.setWatchlistPage(1); }, [v3, watchV3Enabled]);
  const changeQuery = useCallback((value: string) => { if (viewMode === "watchlist") { setWatchQuery(value); resetWatchPage(); } else if (serverDriven) updateServerSearch({ q: value, page: 1 }, true); else { setLocalQuery(value); onPageChange(1); } }, [onPageChange, resetWatchPage, serverDriven, updateServerSearch, viewMode]);
  const changeRole = useCallback((value: string) => { if (viewMode === "watchlist") { setWatchRole(value); resetWatchPage(); } else if (serverDriven) updateServerSearch({ role: value === "Type A" || value === "Type B" ? value : "all", page: 1 }); else { setLocalRole(value); onPageChange(1); } }, [onPageChange, resetWatchPage, serverDriven, updateServerSearch, viewMode]);
  const changePosition = useCallback((value: string) => { if (viewMode === "watchlist") { setWatchPosition(value); resetWatchPage(); } else if (serverDriven && (value === "ALL" || positionCapability === "supported")) updateServerSearch({ position: value, page: 1 }); }, [positionCapability, resetWatchPage, serverDriven, updateServerSearch, viewMode]);
  const changeAgeBand = useCallback((value: AgeBand) => { if (viewMode === "watchlist") { setWatchAgeBand(value); resetWatchPage(); } else if (serverDriven && (value === "all" || ageCapability === "supported")) updateServerSearch({ ageBand: value, page: 1 }); }, [ageCapability, resetWatchPage, serverDriven, updateServerSearch, viewMode]);
  const changeMinutesBand = useCallback((value: MinutesBand) => { if (viewMode === "watchlist") { setWatchMinutesBand(value); resetWatchPage(); } else if (serverDriven && (value === "all" || minutesCapability === "supported")) updateServerSearch({ minutesBand: value, page: 1 }); }, [minutesCapability, resetWatchPage, serverDriven, updateServerSearch, viewMode]);
  const changeSort = useCallback((next: SortState) => { if (viewMode === "watchlist") { setWatchSort(next); setWatchPage(1); } else if (serverDriven) updateServerSearch({ sort: next.key, direction: next.direction, page: 1 }); else { setLocalSort(next); onPageChange(1); } }, [onPageChange, serverDriven, updateServerSearch, viewMode]);
  const toggleWatch = (player: Player) => { if (watchV3Enabled) { v3!.toggleLegacy(player, currentV3Context); return; } const key = watchlistKey(player.id, currentContext); invalidateWatchlistResolve(); invalidateWatchlistQuality(); setResolvedWatchlist((current) => { const { [key]: _discarded, ...rest } = current; return rest; }); if (watchedKeys.has(key)) { setWatchlist((current) => removeWatchlistEntry(current, key)); setFeedback(`${player.name} removed from watchlist.`); } else { setWatchlist((current) => ({ ...current, entries: [...current.entries, entryFromPlayer(player, currentContext)] })); setFeedback(`${player.name} saved with this leaderboard context.`); } };
  const removeWatch = (key: string) => { invalidateWatchlistResolve(); invalidateWatchlistQuality(); setResolvedWatchlist((current) => { const { [key]: _discarded, ...rest } = current; return rest; }); setWatchlist((current) => removeWatchlistEntry(current, key)); setFeedback("Watchlist entry removed."); };
  const toggleSelection = (key: string) => setWatchlist((current) => { if (current.selectedEntryKeys.includes(key)) { setFeedback("Comparison selection removed."); return toggleWatchlistSelection(current, key); } if (current.selectedEntryKeys.length >= 2) { setFeedback("You can select up to two watchlist entries for comparison."); return current; } setFeedback("Watchlist entry selected for comparison."); return toggleWatchlistSelection(current, key); });
  const setMetricSort = (key: SortKey) => changeSort({ key, direction: sort.key === key ? (sort.direction === "desc" ? "asc" : "desc") : "desc" });
  const normalTotal = serverDriven ? (meta.totalItems ?? meta.population) : displayed.length; const shownPage = serverDriven && refreshing ? serverPage!.page : safePage;
  const normalStart = normalTotal && displayed.length ? (shownPage - 1) * PAGE_SIZE + 1 : 0; const normalEnd = displayed.length ? normalStart + displayed.length - 1 : 0;
  const normalRange = displayed.length ? `${normalStart}–${normalEnd} of ${normalTotal}` : "0 of 0";
  const watchStart = filteredWatchRows.length ? (localWatchPage.page - 1) * 50 + 1 : 0; const watchEnd = filteredWatchRows.length ? watchStart + localWatchPage.rows.length - 1 : 0;
  const watchRange = filteredWatchRows.length ? `${watchStart}–${watchEnd} of ${filteredWatchRows.length} saved contexts` : `0 of ${filteredWatchRows.length} saved contexts`;
  const v3Filters: WatchlistV3Filters = { query: watchQuery, role: watchRole === "Type A" || watchRole === "Type B" ? watchRole : "ALL", position: watchPosition, ageBand: watchAgeBand, minutesBand: watchMinutesBand, sort: v3Sort, direction: v3Direction };
  const v3View = useMemo(() => watchlistV3Page(watchV3Enabled ? v3!.entries : [], v3Filters, watchV3Enabled ? v3!.watchlistPage : 1), [v3?.entries, v3?.watchlistPage, v3Direction, v3Sort, watchAgeBand, watchMinutesBand, watchPosition, watchQuery, watchRole, watchV3Enabled]); const v3Visible = v3View.visible;
  useEffect(() => { if (watchV3Enabled && v3!.watchlistPage !== v3View.page) v3!.setWatchlistPage(v3View.page); }, [v3, v3View.page, watchV3Enabled]);
  const v3VisibleDuel = useMemo(() => v3Visible.filter((entry): entry is DuelPressV3Entry => entry.taxonomy === "duel-press-v1"), [v3Visible]); const v3VisibleLegacy = useMemo(() => v3Visible.filter((entry): entry is LegacyV3Entry => entry.taxonomy === "legacy-v1"), [v3Visible]);
  const v3DuelResolutions = useVisibleDuelWatchlistResolution(apiConfig, v3VisibleDuel, watchV3Enabled && viewMode === "watchlist", resolveEpoch); const v3LegacyResolutions = useLegacyWatchlistResolution(apiConfig, v3VisibleLegacy, watchV3Enabled && viewMode === "watchlist", resolveEpoch);
  const v3LegacyQuality = useLegacyWatchlistQuality(apiConfig, v3VisibleLegacy, v3LegacyResolutions, watchV3Enabled && viewMode === "watchlist");
  const v3Resolving = Object.values(v3DuelResolutions).some((result) => result.status === "pending") || Object.values(v3LegacyResolutions).some((result) => result.status === "pending");
  const v3ResolverStatus = v3Resolving ? "Refreshing visible V3 contexts; saved snapshots remain visible." : "";
  const v3Range = v3Visible.length ? `${v3View.start}–${v3View.end} of ${v3View.total} saved contexts` : `0 of ${v3View.total} saved contexts`;
  const isWatchlist = viewMode === "watchlist"; const rangeLabel = isWatchlist ? watchRange : normalRange;
  const effectiveRangeLabel = isWatchlist && watchV3Enabled ? v3Range : rangeLabel;
  const hasLegacyTierTaxonomy = !isWatchlist && displayed.some((player) => resolveTierPresentation(player.tier).taxonomy === "legacy-v1");

  return <main id="main-content" aria-busy={isWatchlist ? (watchV3Enabled ? v3Resolving : resolvingWatchlist) : refreshing} className="min-h-screen bg-[#080b0c] text-zinc-100"><StatusFeedback message={watchV3Enabled ? v3!.feedback : feedback} /><div className="mx-auto max-w-[1580px] px-3 py-5 sm:px-6 lg:px-8">
    <DatasetHeader meta={meta} visibleCount={isWatchlist ? (watchV3Enabled ? v3View.total : filteredWatchRows.length) : displayed.length} refreshing={isWatchlist ? (watchV3Enabled ? v3Resolving : resolvingWatchlist) : refreshing} onRefresh={isWatchlist ? (watchV3Enabled ? () => setResolveEpoch((value) => value + 1) : () => void resolveSavedContexts()) : onRefresh} state={dataset} options={options} onStateChange={onDatasetChange} watchlistMode={isWatchlist} />
    {!isWatchlist && refreshWarning}
    <DashboardToolbar isRefreshing={!isWatchlist && refreshing} query={query} role={role} position={position} ageBand={ageBand} minutesBand={minutesBand} positionCapability={isWatchlist ? "supported" : (serverDriven ? positionCapability : "unsupported")} ageCapability={isWatchlist ? "supported" : (serverDriven ? ageCapability : "unsupported")} minutesCapability={isWatchlist ? "supported" : (serverDriven ? minutesCapability : "unsupported")} watchOnly={false} watchCount={watchV3Enabled ? v3!.watchCount : watchlist.entries.length} resultLabel={isWatchlist ? `Watchlist · ${watchV3Enabled ? v3!.watchCount : watchlist.entries.length} saved contexts` : (displayed.length ? `${displayed.length} shown · ${normalTotal} results` : "0 shown · 0 results")} hasFilters={hasFilters} players={players} dataset={dataset} onQueryChange={changeQuery} onRoleChange={changeRole} onPositionChange={changePosition} onAgeBandChange={changeAgeBand} onMinutesBandChange={changeMinutesBand} onWatchOnlyChange={() => undefined} viewMode={viewMode} onViewModeChange={(mode) => { setViewMode(mode); if (watchV3Enabled) v3!.setViewMode(mode); }} onOpenWatchlist={() => watchV3Enabled ? v3!.setDrawerOpen(true) : setWatchlistOpen(true)} onReset={resetFilters} />
    {hasLegacyTierTaxonomy && <div aria-label="Leaderboard tier taxonomy status" title="Some players in this leaderboard response use the previous overall M.E.S.S.I. tier taxonomy. Legacy labels preserve their original meaning." className="mb-2 flex items-center"><span className="rounded border border-zinc-400/30 bg-zinc-400/10 px-1.5 py-0.5 text-[10px] font-semibold text-zinc-300">Legacy tier taxonomy</span></div>}
    <ScoreLegend />
    <section ref={leaderboardRef} aria-label={isWatchlist ? "Watchlist results" : "Leaderboard results"} className="scroll-mt-4">{isWatchlist && watchV3Enabled && <WatchlistV3SortControls sort={v3Sort} direction={v3Direction} onChange={(nextSort, direction) => { setV3Sort(nextSort); setV3Direction(direction); v3!.setWatchlistPage(1); }} />}<p ref={resultsSummaryRef} tabIndex={-1} aria-label={isWatchlist ? "Watchlist results summary" : undefined} className="mb-1 text-xs font-bold text-zinc-400">{effectiveRangeLabel}{isWatchlist ? "" : " players"}</p><p role="status" aria-live="polite" className="mb-3 min-h-5 text-xs text-zinc-500">{isWatchlist ? (watchV3Enabled ? v3ResolverStatus : resolverStatus) : (refreshing && serverDriven ? `Loading page ${safePage}.` : "")}</p>{isWatchlist && watchV3Enabled ? (v3Visible.length ? <><TaxonomyWatchlistView entries={v3Visible} resolutions={v3DuelResolutions} legacyResolutions={v3LegacyResolutions} legacyQuality={v3LegacyQuality} preferences={v3!.displayPreference} fallbackFocusRef={resultsSummaryRef} onPreference={v3!.setDisplayPreference} onRemove={v3!.remove} onRetry={() => setResolveEpoch((value) => value + 1)} /><LeaderboardPagination page={v3View.page} total={v3View.total} pageSize={50} onPageChange={v3!.setWatchlistPage} /></> : <div className="rounded-lg border border-dashed border-white/15 p-6 text-sm text-zinc-400">No saved contexts match these local filters.</div>) : isWatchlist ? (localWatchPage.rows.length ? <><WatchlistCardList rows={localWatchPage.rows} qualityByKey={watchlistQuality} sort={watchSort} onScoreSort={() => setMetricSort("score")} onRemove={removeWatch} onRetry={() => void resolveSavedContexts()} /><WatchlistTable rows={localWatchPage.rows} qualityByKey={watchlistQuality} sort={watchSort} onMetricSort={setMetricSort} onRemove={removeWatch} onRetry={() => void resolveSavedContexts()} /><LeaderboardPagination page={localWatchPage.page} total={filteredWatchRows.length} pageSize={50} onPageChange={setWatchPage} /></> : <div className="rounded-lg border border-dashed border-white/15 p-6 text-sm text-zinc-400">{watchlist.entries.length ? "No saved contexts match these local filters." : "No saved contexts yet. Save a player from any leaderboard context to see it here."}</div>) : (displayed.length ? <><PlayerCardList players={pagePlayers} dataset={dataset} watchedKeys={watchedKeys} sort={normalSort} onScoreSort={() => setMetricSort("score")} onToggleWatch={toggleWatch} /><PlayerTable players={pagePlayers} dataset={dataset} watchedKeys={watchedKeys} sort={normalSort} onMetricSort={setMetricSort} onToggleWatch={toggleWatch} /><LeaderboardPagination page={safePage} total={normalTotal} pageSize={PAGE_SIZE} pending={refreshing && serverDriven} onPageChange={onPageChange} /></> : <EmptyState onReset={resetFilters} />)}</section>
    <DatasetFooter meta={meta} resultRange={effectiveRangeLabel} />
  </div>{watchV3Enabled ? <WatchlistV3Drawer open={v3!.drawerOpen} entries={v3!.entries} selectedKeys={v3!.envelope.selectedEntryKeys} onClose={() => v3!.setDrawerOpen(false)} onRemove={v3!.remove} onToggleSelection={v3!.toggleSelection} feedback={v3!.feedback} /> : <WatchlistDrawer open={watchlistOpen} entries={watchlist.entries} selectedKeys={watchlist.selectedEntryKeys} onClose={() => setWatchlistOpen(false)} onRemove={removeWatch} onToggleSelection={toggleSelection} feedback={feedback} />}</main>;
}
