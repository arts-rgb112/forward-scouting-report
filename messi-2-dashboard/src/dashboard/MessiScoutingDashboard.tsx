import { useEffect, useMemo, useReducer, useState } from "react";
import { comparisonReducer, MAX_COMPARISON_PLAYERS } from "./comparisonState";
import { CompareTray } from "./components/CompareTray";
import { DashboardToolbar } from "./components/DashboardToolbar";
import { DatasetFooter } from "./components/DatasetFooter";
import { DatasetHeader } from "./components/DatasetHeader";
import { EmptyState } from "./components/EmptyState";
import { PlayerCardList } from "./components/PlayerCardList";
import { PlayerTable } from "./components/PlayerTable";
import { ScoreLegend } from "./components/ScoreLegend";
import { StatusFeedback } from "./components/StatusFeedback";
import { derivePositions, filterAndSortPlayers } from "./playerQuery";
import type { DatasetMeta, DatasetRouteState, LeaderboardOptions, Player, SortKey, SortState } from "./types";
import { readWatchlist, writeWatchlist } from "./watchlistStorage";

export type MessiScoutingDashboardProps = { players: readonly Player[]; meta: DatasetMeta; refreshing: boolean; onRefresh(): void; refreshWarning?: React.ReactNode; dataset?: DatasetRouteState; options?: LeaderboardOptions; onDatasetChange?(next: DatasetRouteState): void };

export default function MessiScoutingDashboard({ players, meta, refreshing, onRefresh, refreshWarning, dataset = { season: meta.season, mode: "league", scope: (meta.scope ?? 7) as 3 | 5 | 7, competition: "all" }, options, onDatasetChange = () => undefined }: MessiScoutingDashboardProps) {
  const validIds = useMemo(() => new Set(players.map((p) => p.id)), [players]);
  const [query, setQuery] = useState(""); const [role, setRole] = useState("ALL");
  const [sort, setSort] = useState<SortState>({ key: "score", direction: "desc" });
  const [watchOnly, setWatchOnly] = useState(false); const [watchlistIds, setWatchlistIds] = useState<number[]>(() => readWatchlist(validIds));
  const [feedback, setFeedback] = useState(""); const [comparison, dispatchComparison] = useReducer(comparisonReducer, { ids: [], open: false });
  useEffect(() => { setWatchlistIds((ids) => ids.filter((id) => validIds.has(id))); dispatchComparison({ type: "reconcile", validIds }); }, [validIds]);
  useEffect(() => { writeWatchlist(watchlistIds); }, [watchlistIds]);
  const positions = useMemo(() => derivePositions(players), [players]);
  const filtered = useMemo(() => filterAndSortPlayers(players, { query, role, sort, watchOnly, watchlistIds }), [players, query, role, sort, watchOnly, watchlistIds]);
  const watchedIds = useMemo(() => new Set(watchlistIds), [watchlistIds]); const comparedIds = useMemo(() => new Set(comparison.ids), [comparison.ids]);
  const byId = useMemo(() => new Map(players.map((p) => [p.id, p])), [players]); const comparedPlayers = comparison.ids.map((id) => byId.get(id)).filter((p): p is Player => Boolean(p));
  const hasFilters = Boolean(query || role !== "ALL" || watchOnly || sort.key !== "score" || sort.direction !== "desc");
  const resetFilters = () => { setQuery(""); setRole("ALL"); setSort({ key: "score", direction: "desc" }); setWatchOnly(false); };
  const toggleWatch = (player: Player) => setWatchlistIds((ids) => watchedIds.has(player.id) ? ids.filter((id) => id !== player.id) : [...ids, player.id]);
  const toggleCompare = (player: Player) => { if (!comparedIds.has(player.id) && comparison.ids.length >= MAX_COMPARISON_PLAYERS) { setFeedback("You can compare up to four players."); return; } dispatchComparison({ type: "toggle", id: player.id }); };
  const setMetricSort = (key: SortKey) => setSort((current) => ({ key, direction: current.key === key ? (current.direction === "desc" ? "asc" : "desc") : "desc" }));
  return <main className={`min-h-screen bg-[#080b0c] text-zinc-100 ${comparison.ids.length ? "pb-52" : ""}`}><StatusFeedback message={feedback} /><div className="mx-auto max-w-[1580px] px-3 py-5 sm:px-6 lg:px-8"><DatasetHeader meta={meta} visibleCount={filtered.length} refreshing={refreshing} onRefresh={onRefresh} state={dataset} options={options} onStateChange={onDatasetChange} />{refreshWarning}<DashboardToolbar query={query} role={role} sort={sort.key} watchOnly={watchOnly} watchCount={watchlistIds.length} positions={positions} resultCount={filtered.length} hasFilters={hasFilters} players={players} onQueryChange={setQuery} onRoleChange={setRole} onSortChange={(key) => setSort({ key, direction: key === "name" || key === "age" ? "asc" : "desc" })} onWatchOnlyChange={setWatchOnly} onReset={resetFilters} /><ScoreLegend />{filtered.length ? <><PlayerCardList players={filtered} comparedIds={comparedIds} watchedIds={watchedIds} onToggleCompare={toggleCompare} onToggleWatch={toggleWatch} /><PlayerTable players={filtered} comparedIds={comparedIds} watchedIds={watchedIds} sort={sort} onMetricSort={setMetricSort} onToggleCompare={toggleCompare} onToggleWatch={toggleWatch} /></> : <EmptyState onReset={resetFilters} />}<DatasetFooter meta={meta} visibleCount={filtered.length} /></div><CompareTray players={comparedPlayers} open={comparison.open} onRemove={(id) => dispatchComparison({ type: "remove", id })} onClear={() => dispatchComparison({ type: "clear" })} onOpenChange={(open) => dispatchComparison({ type: "set-open", open })} /></main>;
}
