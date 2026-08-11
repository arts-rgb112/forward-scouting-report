import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { DashboardToolbar } from "./components/DashboardToolbar";
import { DatasetFooter } from "./components/DatasetFooter";
import { DatasetHeader } from "./components/DatasetHeader";
import { EmptyState } from "./components/EmptyState";
import { LeaderboardPagination } from "./components/LeaderboardPagination";
import { PlayerCardList } from "./components/PlayerCardList";
import { PlayerTable } from "./components/PlayerTable";
import { ScoreLegend } from "./components/ScoreLegend";
import { StatusFeedback } from "./components/StatusFeedback";
import { WatchlistDrawer } from "./components/WatchlistDrawer";
import { PAGE_SIZE } from "./datasetRoute";
import { filterAndSortPlayers } from "./playerQuery";
import type { DatasetMeta, DatasetRouteState, LeaderboardOptions, LeaderboardSearch, Player, PositionFilterCapability, ServerPageMeta, SortKey, SortState } from "./types";
import { contextFromDataset, entryFromPlayer, readWatchlist, removeWatchlistEntry, resolveUnresolvedLegacyIds, toggleWatchlistSelection, watchlistKey, writeWatchlist } from "./watchlistStorage";

export type MessiScoutingDashboardProps = {
  players: readonly Player[]; meta: DatasetMeta; refreshing: boolean; onRefresh(): void; refreshWarning?: React.ReactNode;
  dataset?: DatasetRouteState; options?: LeaderboardOptions; onDatasetChange?(next: DatasetRouteState): void;
  page?: number; onPageChange?(page: number, replace?: boolean): void; serverPage?: ServerPageMeta;
  search?: LeaderboardSearch; positionCapability?: PositionFilterCapability; onSearchChange?(next: LeaderboardSearch, replace?: boolean): void;
};

export default function MessiScoutingDashboard({
  players, meta, refreshing, onRefresh, refreshWarning,
  dataset = { season: meta.season, mode: "league", scope: (meta.scope ?? 7) as 3 | 5 | 7, competition: "all" },
  options, onDatasetChange = () => undefined, page = 1, onPageChange = () => undefined,
  serverPage, search, positionCapability = "unknown", onSearchChange = () => undefined,
}: MessiScoutingDashboardProps) {
  const currentContext = useMemo(() => contextFromDataset(dataset), [dataset.competition, dataset.mode, dataset.scope, dataset.season]);
  const [localQuery, setLocalQuery] = useState("");
  const [localRole, setLocalRole] = useState("ALL");
  const [localSort, setLocalSort] = useState<SortState>({ key: "score", direction: "desc" });
  const [watchlist, setWatchlist] = useState(() => readWatchlist(players, currentContext));
  const [watchlistOpen, setWatchlistOpen] = useState(false);
  const [feedback, setFeedback] = useState("");
  const leaderboardRef = useRef<HTMLElement>(null);
  const resultsSummaryRef = useRef<HTMLParagraphElement>(null);
  const previousPage = useRef(page);

  // Do not reconcile against the response: each item is a saved context snapshot, not a member of this page.
  useEffect(() => { writeWatchlist(watchlist); }, [watchlist]);
  // A later page may prove an old ID that was unresolved when V2 first migrated. It never infers an absent player's history.
  useEffect(() => { setWatchlist((current) => resolveUnresolvedLegacyIds(current, players, currentContext)); }, [currentContext, players]);

  const serverDriven = Boolean(serverPage && search);
  const query = serverDriven ? search!.q : localQuery;
  const role = serverDriven ? (search!.role === "all" ? "ALL" : search!.role) : localRole;
  const position = serverDriven ? search!.position : "ALL";
  const sort: SortState = serverDriven ? { key: search!.sort, direction: search!.direction } : localSort;
  // The v2.1 API owns filtering, rank, count, and slicing. Watchlist state never joins its query or local result filtering.
  const displayed = useMemo(() => serverDriven ? players : filterAndSortPlayers(players, { query, role, sort, watchOnly: false, watchlistIds: [] }), [players, query, role, serverDriven, sort]);
  const totalPages = serverDriven ? Math.max(1, serverPage!.totalPages) : Math.max(1, Math.ceil(displayed.length / PAGE_SIZE));
  const safePage = Math.min(Math.max(1, page), totalPages);
  const pagePlayers = useMemo(() => serverDriven ? displayed : displayed.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE), [displayed, safePage, serverDriven]);
  useEffect(() => { if (page !== safePage) onPageChange(safePage, true); }, [onPageChange, page, safePage]);
  useEffect(() => {
    if (previousPage.current !== safePage) { leaderboardRef.current?.scrollIntoView?.({ behavior: "smooth", block: "start" }); resultsSummaryRef.current?.focus({ preventScroll: true }); }
    previousPage.current = safePage;
  }, [safePage]);

  const watchedKeys = useMemo(() => new Set(watchlist.entries.map((entry) => entry.key)), [watchlist.entries]);
  const updateServerSearch = useCallback((patch: Partial<LeaderboardSearch>, replace = false) => { if (search) onSearchChange({ ...search, ...patch, page: patch.page ?? 1 }, replace); }, [onSearchChange, search]);
  const hasFilters = Boolean(query || role !== "ALL" || position !== "ALL" || sort.key !== "score" || sort.direction !== "desc");
  const resetFilters = useCallback(() => { if (serverDriven) updateServerSearch({ q: "", role: "all", position: "ALL", sort: "score", direction: "desc", page: 1 }); else { setLocalQuery(""); setLocalRole("ALL"); setLocalSort({ key: "score", direction: "desc" }); onPageChange(1); } }, [onPageChange, serverDriven, updateServerSearch]);
  const changeQuery = useCallback((value: string) => { if (serverDriven) updateServerSearch({ q: value, page: 1 }, true); else { setLocalQuery(value); onPageChange(1); } }, [onPageChange, serverDriven, updateServerSearch]);
  const changeRole = useCallback((value: string) => { if (serverDriven) updateServerSearch({ role: value === "Type A" || value === "Type B" ? value : "all", page: 1 }); else { setLocalRole(value); onPageChange(1); } }, [onPageChange, serverDriven, updateServerSearch]);
  const changePosition = useCallback((value: string) => { if (serverDriven && (value === "ALL" || positionCapability === "supported")) updateServerSearch({ position: value, page: 1 }); }, [positionCapability, serverDriven, updateServerSearch]);
  const changeSort = useCallback((next: SortState) => { if (serverDriven) updateServerSearch({ sort: next.key, direction: next.direction, page: 1 }); else { setLocalSort(next); onPageChange(1); } }, [onPageChange, serverDriven, updateServerSearch]);
  const toggleWatch = (player: Player) => {
    const key = watchlistKey(player.id, currentContext);
    if (watchedKeys.has(key)) { setWatchlist((current) => removeWatchlistEntry(current, key)); setFeedback(`${player.name} removed from watchlist.`); }
    else { setWatchlist((current) => ({ ...current, entries: [...current.entries, entryFromPlayer(player, currentContext)] })); setFeedback(`${player.name} saved with this leaderboard context.`); }
  };
  const removeWatch = (key: string) => { setWatchlist((current) => removeWatchlistEntry(current, key)); setFeedback("Watchlist entry removed."); };
  const toggleSelection = (key: string) => setWatchlist((current) => {
    if (current.selectedEntryKeys.includes(key)) { setFeedback("Comparison selection removed."); return toggleWatchlistSelection(current, key); }
    if (current.selectedEntryKeys.length >= 2) { setFeedback("You can select up to two watchlist entries for comparison."); return current; }
    setFeedback("Watchlist entry selected for comparison."); return toggleWatchlistSelection(current, key);
  });
  const setMetricSort = (key: SortKey) => changeSort({ key, direction: sort.key === key ? (sort.direction === "desc" ? "asc" : "desc") : "desc" });
  const totalItems = serverDriven ? (meta.totalItems ?? meta.population) : displayed.length;
  const shownPage = serverDriven && refreshing ? serverPage!.page : safePage;
  const start = totalItems && displayed.length ? (shownPage - 1) * PAGE_SIZE + 1 : 0;
  const end = displayed.length ? start + displayed.length - 1 : 0;
  const rangeLabel = displayed.length ? `${start}–${end} of ${totalItems}` : "0 of 0";

  return <main id="main-content" className="min-h-screen bg-[#080b0c] text-zinc-100">
    <StatusFeedback message={feedback} />
    <div className="mx-auto max-w-[1580px] px-3 py-5 sm:px-6 lg:px-8">
      <DatasetHeader meta={meta} visibleCount={displayed.length} refreshing={refreshing} onRefresh={onRefresh} state={dataset} options={options} onStateChange={onDatasetChange} />
      {refreshWarning}
      <DashboardToolbar query={query} role={role} position={position} positionCapability={serverDriven ? positionCapability : "unsupported"} sort={sort.key} direction={sort.direction} watchOnly={false} watchCount={watchlist.entries.length} resultLabel={displayed.length ? `${displayed.length} shown · ${totalItems} results` : "0 shown · 0 results"} hasFilters={hasFilters} players={players} dataset={dataset} onQueryChange={changeQuery} onRoleChange={changeRole} onPositionChange={changePosition} onSortChange={(key) => changeSort({ key, direction: key === "name" || key === "age" ? "asc" : "desc" })} onDirectionChange={(direction) => changeSort({ key: sort.key, direction })} onWatchOnlyChange={() => undefined} onOpenWatchlist={() => setWatchlistOpen(true)} onReset={resetFilters} />
      <ScoreLegend />
      <section ref={leaderboardRef} aria-label="Leaderboard results" className="scroll-mt-4"><p ref={resultsSummaryRef} tabIndex={-1} className="mb-1 text-xs font-bold text-zinc-400">{rangeLabel} players</p><p role="status" aria-live="polite" className="mb-3 min-h-5 text-xs text-zinc-500">{refreshing && serverDriven ? `Loading page ${safePage}.` : ""}</p>{displayed.length ? <><PlayerCardList players={pagePlayers} dataset={dataset} watchedKeys={watchedKeys} onToggleWatch={toggleWatch} /><PlayerTable players={pagePlayers} dataset={dataset} watchedKeys={watchedKeys} sort={sort} onMetricSort={setMetricSort} onToggleWatch={toggleWatch} /><LeaderboardPagination page={safePage} total={totalItems} pageSize={PAGE_SIZE} pending={refreshing && serverDriven} onPageChange={onPageChange} /></> : <EmptyState onReset={resetFilters} />}</section>
      <DatasetFooter meta={meta} resultRange={rangeLabel} />
    </div>
    <WatchlistDrawer open={watchlistOpen} entries={watchlist.entries} selectedKeys={watchlist.selectedEntryKeys} onClose={() => setWatchlistOpen(false)} onRemove={removeWatch} onToggleSelection={toggleSelection} feedback={feedback} />
  </main>;
}
