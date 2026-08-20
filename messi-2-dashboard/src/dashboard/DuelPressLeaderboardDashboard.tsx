import type { DuelPressLeaderboardPayload, DuelPressMetricKey, DuelPressSearch } from "../api/duelPressTypes";
import { DashboardToolbar } from "./components/DashboardToolbar";
import { DatasetFooter } from "./components/DatasetFooter";
import { DatasetHeader } from "./components/DatasetHeader";
import { DuelPressPlayerCardList, DuelPressPlayerTable } from "./components/DuelPressLeaderboardPresentation";
import { EmptyState } from "./components/EmptyState";
import { LeaderboardPagination } from "./components/LeaderboardPagination";
import { ScoreLegend } from "./components/ScoreLegend";
import { duelPressDetailHref } from "./duelPressRoute";
import type { DatasetDisplayMeta, DatasetRouteState, LeaderboardOptions } from "./types";

type Props = { payload: DuelPressLeaderboardPayload; dataset: DatasetRouteState; options?: LeaderboardOptions; search: DuelPressSearch; refreshing: boolean; onRefresh(): void; onDatasetChange(state: DatasetRouteState): void; onSearchChange(search: DuelPressSearch, replace?: boolean): void; onPageChange(page: number): void; warning?: React.ReactNode };
export function duelPressDisplayMeta(meta: DuelPressLeaderboardPayload["meta"]): DatasetDisplayMeta {
  return { schemaVersion: meta.schemaVersion, season: meta.season, scope: meta.scope, population: meta.population, totalItems: meta.totalItems, returned: meta.returned, generatedAt: meta.generatedAt, source: meta.source, mode: meta.mode, competition: meta.competition };
}
export default function DuelPressLeaderboardDashboard({ payload, dataset, options, search, refreshing, onRefresh, onDatasetChange, onSearchChange, onPageChange, warning }: Props) {
  const update = (patch: Partial<DuelPressSearch>, replace = false) => onSearchChange({ ...search, ...patch, page: patch.page ?? 1 }, replace);
  const sort = (key: "score" | DuelPressMetricKey) => update({ sort: key, direction: search.sort === key && search.direction === "desc" ? "asc" : "desc", page: 1 });
  const reset = () => onSearchChange({ page: 1, pageSize: 50, q: "", role: "all", position: "ALL", ageBand: "all", minutesBand: "all", sort: "score", direction: "desc" });
  const meta = duelPressDisplayMeta(payload.meta); const total = payload.meta.totalItems;
  const start = payload.players.length ? (payload.meta.page - 1) * payload.meta.pageSize + 1 : 0; const end = start ? start + payload.players.length - 1 : 0;
  const range = payload.players.length ? `${start}–${end} of ${total}` : `0 of ${total}`;
  const presentationSort = { key: search.sort, direction: search.direction };
  return <main id="main-content" aria-busy={refreshing} className="min-h-screen bg-[#080b0c] text-zinc-100"><div className="mx-auto max-w-[1580px] px-3 py-5 sm:px-6 lg:px-8">
    <DatasetHeader meta={meta} visibleCount={payload.players.length} refreshing={refreshing} onRefresh={onRefresh} state={dataset} options={options} onStateChange={onDatasetChange} />
    {warning}
    <DashboardToolbar isRefreshing={refreshing} query={search.q} role={search.role === "all" ? "ALL" : search.role} position={search.position} ageBand={search.ageBand === "u25" ? "23-25" : search.ageBand} minutesBand={search.minutesBand} positionCapability="supported" ageCapability="supported" minutesCapability="supported" watchOnly={false} watchCount={0} watchAvailable={false} resultLabel={payload.players.length ? `${payload.players.length} shown · ${total} results` : `0 shown · ${total} results`} hasFilters={Boolean(search.q || search.role !== "all" || search.position !== "ALL" || search.ageBand !== "all" || search.minutesBand !== "all" || search.sort !== "score" || search.direction !== "desc")} players={payload.players} dataset={dataset} onPlayerSuggestionSelect={(player) => window.location.assign(duelPressDetailHref(player.id, dataset))} onQueryChange={(q) => update({ q }, true)} onRoleChange={(role) => update({ role: role === "Type A" || role === "Type B" ? role : "all" })} onPositionChange={(position) => update({ position })} onAgeBandChange={(ageBand) => update({ ageBand: ageBand === "23-25" ? "u25" : ageBand })} onMinutesBandChange={(minutesBand) => update({ minutesBand })} onWatchOnlyChange={() => undefined} onReset={reset} />
    <ScoreLegend />
    <section aria-label="Leaderboard results" className="scroll-mt-4"><p tabIndex={-1} className="mb-1 text-xs font-bold text-zinc-400">{range} players</p><p role="status" aria-live="polite" className="mb-3 min-h-5 text-xs text-zinc-500">{refreshing ? `Loading page ${payload.meta.page}.` : ""}</p>{payload.players.length ? <><DuelPressPlayerCardList players={payload.players} dataset={dataset} sort={presentationSort} onMetricSort={sort} /><DuelPressPlayerTable players={payload.players} dataset={dataset} sort={presentationSort} onMetricSort={sort} /><LeaderboardPagination page={payload.meta.page} total={total} pageSize={50} pending={refreshing} onPageChange={onPageChange} /></> : <EmptyState onReset={reset} />}</section>
    <DatasetFooter meta={meta} resultRange={range} />
  </div></main>;
}
