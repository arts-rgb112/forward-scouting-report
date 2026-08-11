import { useEffect, useMemo, useReducer, useRef, useState } from "react";

import { comparisonReducer, MAX_COMPARISON_PLAYERS } from "./comparisonState";
import { PAGE_SIZE } from "./datasetRoute";
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
import { derivePositions, filterAndSortPlayers } from "./playerQuery";
import type { DatasetMeta, DatasetRouteState, LeaderboardOptions, Player, SortKey, SortState } from "./types";
import { readWatchlist, writeWatchlist } from "./watchlistStorage";

export type MessiScoutingDashboardProps = {
  players: readonly Player[]; meta: DatasetMeta; refreshing: boolean; onRefresh(): void; refreshWarning?: React.ReactNode;
  dataset?: DatasetRouteState; options?: LeaderboardOptions; onDatasetChange?(next: DatasetRouteState): void;
  page?: number; onPageChange?(page: number, replace?: boolean): void;
};

export default function MessiScoutingDashboard({ players, meta, refreshing, onRefresh, refreshWarning, dataset = { season: meta.season, mode: "league", scope: (meta.scope ?? 7) as 3 | 5 | 7, competition: "all" }, options, onDatasetChange = () => undefined, page = 1, onPageChange = () => undefined }: MessiScoutingDashboardProps) {
  const validIds = useMemo(() => new Set(players.map((p) => p.id)), [players]);
  const [query, setQuery] = useState(""); const [role, setRole] = useState("ALL"); const [sort, setSort] = useState<SortState>({ key: "score", direction: "desc" });
  const [watchOnly, setWatchOnly] = useState(false); const [watchlistIds, setWatchlistIds] = useState<number[]>(() => readWatchlist(validIds));
  const [feedback, setFeedback] = useState(""); const [comparison, dispatchComparison] = useReducer(comparisonReducer, { ids: [], open: false });
  const leaderboardRef = useRef<HTMLElement>(null); const resultsSummaryRef = useRef<HTMLParagraphElement>(null); const previousPage = useRef(page);
  useEffect(() => { setWatchlistIds((ids) => ids.filter((id) => validIds.has(id))); dispatchComparison({ type: "reconcile", validIds }); }, [validIds]);
  useEffect(() => { writeWatchlist(watchlistIds); }, [watchlistIds]);
  useEffect(() => { if (meta.returned < meta.population) console.warn("Leaderboard response is partial; client-side pagination only covers returned rows.", { returned: meta.returned, population: meta.population }); }, [meta.population, meta.returned]);
  const positions = useMemo(() => derivePositions(players), [players]);
  // The order is deliberate: API rows -> filters -> sort -> client-side page slice.
  const filtered = useMemo(() => filterAndSortPlayers(players, { query, role, sort, watchOnly, watchlistIds }), [players, query, role, sort, watchOnly, watchlistIds]);
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(Math.max(1, page), totalPages);
  const pagePlayers = useMemo(() => filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE), [filtered, safePage]);
  useEffect(() => { if (page !== safePage) onPageChange(safePage, true); }, [onPageChange, page, safePage]);
  useEffect(() => {
    if (previousPage.current !== safePage) {
      leaderboardRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      resultsSummaryRef.current?.focus({ preventScroll: true });
    }
    previousPage.current = safePage;
  }, [safePage]);
  const watchedIds = useMemo(() => new Set(watchlistIds), [watchlistIds]); const comparedIds = useMemo(() => new Set(comparison.ids), [comparison.ids]);
  const byId = useMemo(() => new Map(players.map((p) => [p.id, p])), [players]); const comparedPlayers = comparison.ids.map((id) => byId.get(id)).filter((p): p is Player => Boolean(p));
  useEffect(() => { try { sessionStorage.setItem("messi-comparison-selection", JSON.stringify(comparedPlayers.map(({ id, name }) => ({ id, name })))); } catch { /* storage is optional */ } }, [comparedPlayers]);
  const hasFilters = Boolean(query || role !== "ALL" || watchOnly || sort.key !== "score" || sort.direction !== "desc");
  const resetPage = () => onPageChange(1);
  const resetFilters = () => { setQuery(""); setRole("ALL"); setSort({ key: "score", direction: "desc" }); setWatchOnly(false); resetPage(); };
  const changeQuery = (value: string) => { setQuery(value); resetPage(); };
  const changeRole = (value: string) => { setRole(value); resetPage(); };
  const changeWatchOnly = (value: boolean) => { setWatchOnly(value); resetPage(); };
  const changeSort = (next: SortState) => { setSort(next); resetPage(); };
  const toggleWatch = (player: Player) => { setWatchlistIds((ids) => watchedIds.has(player.id) ? ids.filter((id) => id !== player.id) : [...ids, player.id]); resetPage(); };
  const toggleCompare = (player: Player) => { if (!comparedIds.has(player.id) && comparison.ids.length >= MAX_COMPARISON_PLAYERS) { setFeedback("You can compare up to four players."); return; } dispatchComparison({ type: "toggle", id: player.id }); };
  const setMetricSort = (key: SortKey) => changeSort((current => ({ key, direction: current.key === key ? (current.direction === "desc" ? "asc" : "desc") : "desc" }))(sort));
  const start = filtered.length ? (safePage - 1) * PAGE_SIZE + 1 : 0; const end = Math.min(safePage * PAGE_SIZE, filtered.length);
  return <main id="main-content" className={`min-h-screen bg-[#080b0c] text-zinc-100 ${comparison.ids.length ? "pb-52" : ""}`}><StatusFeedback message={feedback} /><div className="mx-auto max-w-[1580px] px-3 py-5 sm:px-6 lg:px-8"><DatasetHeader meta={meta} visibleCount={filtered.length} refreshing={refreshing} onRefresh={onRefresh} state={dataset} options={options} onStateChange={onDatasetChange} />{refreshWarning}<DashboardToolbar query={query} role={role} sort={sort.key} watchOnly={watchOnly} watchCount={watchlistIds.length} positions={positions} resultCount={filtered.length} hasFilters={hasFilters} players={players} dataset={dataset} onQueryChange={changeQuery} onRoleChange={changeRole} onSortChange={(key) => changeSort({ key, direction: key === "name" || key === "age" ? "asc" : "desc" })} onWatchOnlyChange={changeWatchOnly} onReset={resetFilters} /><ScoreLegend /><section ref={leaderboardRef} aria-label="Leaderboard results" className="scroll-mt-4"><p ref={resultsSummaryRef} tabIndex={-1} aria-live="polite" className="mb-3 text-xs font-bold text-zinc-400">{filtered.length ? `${start}–${end} / ${filtered.length} players` : "0 / 0 players"}</p>{filtered.length ? <><PlayerCardList players={pagePlayers} dataset={dataset} comparedIds={comparedIds} watchedIds={watchedIds} onToggleCompare={toggleCompare} onToggleWatch={toggleWatch} /><PlayerTable players={pagePlayers} dataset={dataset} comparedIds={comparedIds} watchedIds={watchedIds} sort={sort} onMetricSort={setMetricSort} onToggleCompare={toggleCompare} onToggleWatch={toggleWatch} /><LeaderboardPagination page={safePage} total={filtered.length} pageSize={PAGE_SIZE} onPageChange={onPageChange} /></> : <EmptyState onReset={resetFilters} />}</section><DatasetFooter meta={meta} visibleCount={filtered.length} /></div><CompareTray players={comparedPlayers} dataset={dataset} onRemove={(id) => dispatchComparison({ type: "remove", id })} onClear={() => dispatchComparison({ type: "clear" })} /></main>;
}
