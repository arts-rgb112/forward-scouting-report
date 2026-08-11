import { useEffect, useMemo, useReducer, useRef, useState } from "react";

import { comparisonReducer, MAX_COMPARISON_PLAYERS } from "./comparisonState";
import { CompareTray } from "./components/CompareTray";
import { DashboardToolbar } from "./components/DashboardToolbar";
import { DatasetFooter } from "./components/DatasetFooter";
import { DatasetHeader } from "./components/DatasetHeader";
import { EmptyState } from "./components/EmptyState";
import { LeaderboardPagination } from "./components/LeaderboardPagination";
import { PlayerCardList } from "./components/PlayerCardList";
import { PlayerTable } from "./components/PlayerTable";
import { ScoreLegend } from "./components/ScoreLegend";
import { StatusFeedback } from "./components/StatusFeedback";
import { filterAndSortPlayers } from "./playerQuery";
import { PAGE_SIZE } from "./datasetRoute";
import type { DatasetMeta, DatasetRouteState, LeaderboardOptions, LeaderboardSearch, Player, PositionFilterCapability, ServerPageMeta, SortKey, SortState } from "./types";
import { readWatchlist, writeWatchlist } from "./watchlistStorage";

export type MessiScoutingDashboardProps = {
  players: readonly Player[];
  meta: DatasetMeta;
  refreshing: boolean;
  onRefresh(): void;
  refreshWarning?: React.ReactNode;
  dataset?: DatasetRouteState;
  options?: LeaderboardOptions;
  onDatasetChange?(next: DatasetRouteState): void;
  page?: number;
  onPageChange?(page: number, replace?: boolean): void;
  serverPage?: ServerPageMeta;
  search?: LeaderboardSearch;
  positionCapability?: PositionFilterCapability;
  onSearchChange?(next: LeaderboardSearch, replace?: boolean): void;
};

export default function MessiScoutingDashboard({
  players, meta, refreshing, onRefresh, refreshWarning,
  dataset = { season: meta.season, mode: "league", scope: (meta.scope ?? 7) as 3 | 5 | 7, competition: "all" },
  options, onDatasetChange = () => undefined, page = 1, onPageChange = () => undefined,
  serverPage, search, positionCapability = "unknown", onSearchChange = () => undefined,
}: MessiScoutingDashboardProps) {
  const validIds = useMemo(() => new Set(players.map((player) => player.id)), [players]);
  const [localQuery, setLocalQuery] = useState("");
  const [localRole, setLocalRole] = useState("ALL");
  const [localSort, setLocalSort] = useState<SortState>({ key: "score", direction: "desc" });
  const [watchOnly, setWatchOnly] = useState(false);
  const [watchlistIds, setWatchlistIds] = useState<number[]>(() => readWatchlist(validIds));
  const [feedback, setFeedback] = useState("");
  const [comparison, dispatchComparison] = useReducer(comparisonReducer, { ids: [], open: false });
  const leaderboardRef = useRef<HTMLElement>(null);
  const resultsSummaryRef = useRef<HTMLParagraphElement>(null);
  const previousPage = useRef(page);

  useEffect(() => {
    setWatchlistIds((ids) => ids.filter((id) => validIds.has(id)));
    dispatchComparison({ type: "reconcile", validIds });
  }, [validIds]);
  useEffect(() => { writeWatchlist(watchlistIds); }, [watchlistIds]);

  const serverDriven = Boolean(serverPage && search);
  const query = serverDriven ? search!.q : localQuery;
  const role = serverDriven ? (search!.role === "all" ? "ALL" : search!.role) : localRole;
  const position = serverDriven ? search!.position : "ALL";
  const sort: SortState = serverDriven ? { key: search!.sort, direction: search!.direction } : localSort;
  // A v2.1 response is already globally searched, sorted, and sliced by the
  // server. Applying client-side filtering or slicing would corrupt its ranks.
  const displayed = useMemo(
    () => serverDriven ? players : filterAndSortPlayers(players, { query, role, sort, watchOnly, watchlistIds }),
    [players, query, role, serverDriven, sort, watchOnly, watchlistIds],
  );
  const totalPages = serverDriven ? Math.max(1, serverPage!.totalPages) : Math.max(1, Math.ceil(displayed.length / 50));
  const safePage = Math.min(Math.max(1, page), totalPages);
  const pagePlayers = useMemo(
    () => serverDriven ? displayed : displayed.slice((safePage - 1) * 50, safePage * 50),
    [displayed, safePage, serverDriven],
  );

  useEffect(() => { if (page !== safePage) onPageChange(safePage, true); }, [onPageChange, page, safePage]);
  useEffect(() => {
    if (previousPage.current !== safePage) {
      const leaderboard = leaderboardRef.current;
      if (typeof leaderboard?.scrollIntoView === "function") leaderboard.scrollIntoView({ behavior: "smooth", block: "start" });
      resultsSummaryRef.current?.focus({ preventScroll: true });
    }
    previousPage.current = safePage;
  }, [safePage]);

  const watchedIds = useMemo(() => new Set(watchlistIds), [watchlistIds]);
  const comparedIds = useMemo(() => new Set(comparison.ids), [comparison.ids]);
  const byId = useMemo(() => new Map(players.map((player) => [player.id, player])), [players]);
  const comparedPlayers = comparison.ids.map((id) => byId.get(id)).filter((player): player is Player => Boolean(player));
  useEffect(() => {
    try { sessionStorage.setItem("messi-comparison-selection", JSON.stringify(comparedPlayers.map(({ id, name }) => ({ id, name })))); } catch { /* optional */ }
  }, [comparedPlayers]);

  const updateServerSearch = (patch: Partial<LeaderboardSearch>, replace = false) => {
    if (!search) return;
    onSearchChange({ ...search, ...patch, page: patch.page ?? 1 }, replace);
  };
  const hasFilters = Boolean(query || role !== "ALL" || position !== "ALL" || (!serverDriven && watchOnly) || sort.key !== "score" || sort.direction !== "desc");
  const resetFilters = () => {
    if (serverDriven) updateServerSearch({ q: "", role: "all", position: "ALL", sort: "score", direction: "desc", page: 1 });
    else { setLocalQuery(""); setLocalRole("ALL"); setLocalSort({ key: "score", direction: "desc" }); setWatchOnly(false); onPageChange(1); }
  };
  const changeQuery = (value: string) => {
    if (serverDriven) updateServerSearch({ q: value, page: 1 }, true);
    else { setLocalQuery(value); onPageChange(1); }
  };
  const changeRole = (value: string) => {
    if (serverDriven) updateServerSearch({ role: value === "Type A" || value === "Type B" ? value : "all", page: 1 });
    else { setLocalRole(value); onPageChange(1); }
  };
  const changePosition = (value: string) => {
    if (!serverDriven || (value !== "ALL" && positionCapability !== "supported")) return;
    updateServerSearch({ position: value, page: 1 });
  };
  const changeSort = (next: SortState) => {
    if (serverDriven) updateServerSearch({ sort: next.key, direction: next.direction, page: 1 });
    else { setLocalSort(next); onPageChange(1); }
  };
  const toggleWatch = (player: Player) => {
    setWatchlistIds((ids) => watchedIds.has(player.id) ? ids.filter((id) => id !== player.id) : [...ids, player.id]);
    if (!serverDriven) onPageChange(1);
  };
  const toggleCompare = (player: Player) => {
    if (!comparedIds.has(player.id) && comparison.ids.length >= MAX_COMPARISON_PLAYERS) { setFeedback("Choose exactly two players to compare."); return; }
    dispatchComparison({ type: "toggle", id: player.id });
  };
  const setMetricSort = (key: SortKey) => changeSort({ key, direction: sort.key === key ? (sort.direction === "desc" ? "asc" : "desc") : "desc" });
  const totalItems = serverDriven ? (meta.totalItems ?? meta.population) : displayed.length;
  const activePageSize = PAGE_SIZE;
  // During a request the previous server page remains on screen. Describe that
  // page honestly while making the destination page explicit in the live text.
  const shownPage = serverDriven && refreshing ? serverPage!.page : safePage;
  const start = totalItems && displayed.length ? (shownPage - 1) * activePageSize + 1 : 0;
  const end = displayed.length ? start + displayed.length - 1 : 0;
  const rangeLabel = displayed.length ? `${start}–${end} of ${totalItems}` : "0 of 0";
  const pendingLabel = refreshing && serverDriven ? `Loading page ${safePage} · currently showing ${rangeLabel}` : `${rangeLabel} players`;

  return <main id="main-content" className={`min-h-screen bg-[#080b0c] text-zinc-100 ${comparison.ids.length ? "pb-52" : ""}`}>
    <StatusFeedback message={feedback} />
    <div className="mx-auto max-w-[1580px] px-3 py-5 sm:px-6 lg:px-8">
      <DatasetHeader meta={meta} visibleCount={displayed.length} refreshing={refreshing} onRefresh={onRefresh} state={dataset} options={options} onStateChange={onDatasetChange} />
      {refreshWarning}
      <DashboardToolbar query={query} role={role} position={position} positionCapability={serverDriven ? positionCapability : "unsupported"} sort={sort.key} direction={sort.direction} watchOnly={watchOnly} watchCount={watchlistIds.length} watchAvailable={!serverDriven} resultLabel={displayed.length ? `${displayed.length} shown · ${totalItems} results` : "0 shown · 0 results"} hasFilters={hasFilters} players={players} dataset={dataset} onQueryChange={changeQuery} onRoleChange={changeRole} onPositionChange={changePosition} onSortChange={(key) => changeSort({ key, direction: key === "name" || key === "age" ? "asc" : "desc" })} onDirectionChange={(direction) => changeSort({ key: sort.key, direction })} onWatchOnlyChange={setWatchOnly} onReset={resetFilters} />
      <ScoreLegend />
      <section ref={leaderboardRef} aria-label="Leaderboard results" className="scroll-mt-4">
        <p ref={resultsSummaryRef} tabIndex={-1} aria-live="polite" className="mb-3 text-xs font-bold text-zinc-400">{pendingLabel}</p>
        {displayed.length ? <>
          <PlayerCardList players={pagePlayers} dataset={dataset} comparedIds={comparedIds} watchedIds={watchedIds} onToggleCompare={toggleCompare} onToggleWatch={toggleWatch} />
          <PlayerTable players={pagePlayers} dataset={dataset} comparedIds={comparedIds} watchedIds={watchedIds} sort={sort} onMetricSort={setMetricSort} onToggleCompare={toggleCompare} onToggleWatch={toggleWatch} />
          <LeaderboardPagination page={safePage} total={totalItems} pageSize={activePageSize} pending={refreshing && serverDriven} onPageChange={onPageChange} />
        </> : <EmptyState onReset={resetFilters} />}
      </section>
      <DatasetFooter meta={meta} resultRange={rangeLabel} />
    </div>
    <CompareTray players={comparedPlayers} dataset={dataset} onRemove={(id) => dispatchComparison({ type: "remove", id })} onClear={() => dispatchComparison({ type: "clear" })} />
  </main>;
}
