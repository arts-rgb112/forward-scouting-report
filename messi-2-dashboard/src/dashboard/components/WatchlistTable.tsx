import { metricConfig, metricKeys } from "../scoutingConfig";
import type { MetricKey, SortState } from "../types";
import type { WatchlistRow } from "../watchlistViewModel";
import { datasetStateFromWatchlistEntry, watchlistContextLabel } from "../watchlistViewModel";
import { enabledLegacyHref, legacyDetailHref } from "../../navigation/legacyHandoff";
import { datasetHref } from "../datasetRoute";
import { AssetImage } from "./AssetImage";
import { MetricScore } from "./MetricScore";
import { TierBadge } from "./TierBadge";

type Props = { rows: readonly WatchlistRow[]; sort: SortState; onMetricSort(key: MetricKey): void; onRemove(key: string): void; onRetry(): void };

function detailHref(row: WatchlistRow) {
  const state = datasetStateFromWatchlistEntry(row.entry);
  return enabledLegacyHref(legacyDetailHref(row.entry.playerId, { name: row.profile.name, clubName: row.profile.clubName }, state) ?? "") ?? datasetHref(`/players/${row.entry.playerId}`, state);
}
function sourceBadge(row: WatchlistRow) {
  if (row.source === "current") return <span className="rounded border border-sky-300/25 bg-sky-300/10 px-1.5 py-0.5 text-[9px] font-bold text-sky-100">현재 서버 데이터</span>;
  return <span title="Stored score at save time; current rank is not recomputed." className="rounded border border-amber-300/25 bg-amber-300/10 px-1.5 py-0.5 text-[9px] font-bold text-amber-100">저장 시점 스냅샷 · 현재 서버 데이터 아님</span>;
}
function SortMetric({ metric, sort, onMetricSort }: { metric: MetricKey; sort: SortState; onMetricSort(metric: MetricKey): void }) {
  const active = sort.key === metric;
  return <button type="button" onClick={() => onMetricSort(metric)} className="min-h-11 px-1 text-[9px] uppercase tracking-wider hover:text-lime-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lime-300">{metricConfig[metric].label}{active ? (sort.direction === "asc" ? " ↑" : " ↓") : ""}</button>;
}
function RowIdentity({ row }: { row: WatchlistRow }) {
  const profile = row.profile;
  return <div className="flex min-w-0 items-center gap-3"><AssetImage src={profile.face ?? null} alt={`${profile.name} portrait`} kind="face" fallbackLabel={profile.name} width={48} height={48} className="h-12 w-12 rounded-md border border-white/10 object-cover" /><div className="min-w-0"><a href={detailHref(row)} className="block truncate text-[13px] font-extrabold hover:text-lime-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lime-300">{profile.name}</a><p className="mt-0.5 truncate text-[10px] text-zinc-500">{profile.clubName} · {profile.leagueName ?? "—"}</p><div className="mt-1 flex flex-wrap items-center gap-1"><span className="rounded border border-white/10 px-1.5 py-0.5 font-mono text-[9px] text-zinc-400">{profile.position}</span>{profile.archetype && <span className="text-[9px] text-zinc-600">{profile.archetype}</span>}<span className="rounded border border-lime-300/25 bg-lime-300/10 px-1.5 py-0.5 text-[9px] font-bold text-lime-100">{watchlistContextLabel(row.entry)}</span>{sourceBadge(row)}</div></div></div>;
}

export function WatchlistTable({ rows, sort, onMetricSort, onRemove, onRetry }: Props) {
  return <section className="hidden rounded-lg border border-white/10 bg-[#0d1112] md:block"><div className="overflow-x-auto"><table className="w-full min-w-[1340px] table-fixed border-collapse"><caption className="sr-only">Saved player contexts. Snapshot scores are not current server ranks.</caption><colgroup><col className="w-[430px]" /><col className="w-20" /><col className="w-24" />{metricKeys.map((key) => <col key={key} className="w-24" />)}<col className="w-24" /><col className="w-16" /><col className="w-24" /></colgroup><thead className="sticky top-0 z-30 bg-[#0b0e0f]/95"><tr className="h-11 border-b border-white/10 text-[9px] uppercase tracking-wider text-zinc-500"><th scope="col" className="sticky left-0 z-10 bg-[#0b0e0f] px-3 text-left">Saved player context</th><th scope="col">Tier</th><th scope="col">M.E.S.S.I.</th>{metricKeys.map((key) => <th key={key} scope="col" aria-sort={sort.key === key ? (sort.direction === "asc" ? "ascending" : "descending") : "none"}><SortMetric metric={key} sort={sort} onMetricSort={onMetricSort} /></th>)}<th scope="col" className="text-right">Minutes</th><th scope="col">Age</th><th scope="col">Watch</th></tr></thead><tbody>{rows.map((row) => {
    if (row.source === "legacy-partial") return <tr key={row.key} className="border-b border-amber-300/15"><td colSpan={12} className="p-3"><div className="flex flex-wrap items-center gap-3 rounded border border-amber-300/20 bg-amber-300/[.04] p-3"><div className="min-w-64 flex-1"><a href={detailHref(row)} className="font-bold hover:text-lime-300">{row.profile.name}</a><p className="text-xs text-zinc-400">이전 형식으로 저장되어 지표·나이·출전 시간이 없습니다.</p></div><button type="button" onClick={onRetry} className="min-h-11 rounded border border-white/10 px-3 text-xs">Retry Resolve</button><a href={detailHref(row)} className="inline-flex min-h-11 items-center rounded border border-white/10 px-3 text-xs">Detail</a><button type="button" onClick={() => onRemove(row.key)} className="min-h-11 rounded border border-white/10 px-3 text-xs">Remove</button></div></td></tr>;
    const profile = row.profile; const snapshot = row.source === "snapshot";
    return <tr key={row.key} className="group h-[82px] border-b border-white/[.07] hover:bg-lime-300/[.04]"><th scope="row" className="sticky left-0 z-10 bg-[#0d1112] px-3 text-left group-hover:bg-[#121916]"><RowIdentity row={row} /></th><td className="px-1 text-center"><TierBadge tier={profile.tier!} compact /></td><td className="text-center font-mono text-lg font-black">{profile.score?.toFixed(1)}</td>{metricKeys.map((key) => <td key={key}><MetricScore playerId={row.entry.playerId} metric={key} value={profile.stats![key]!} surface="table" snapshot={snapshot} /></td>)}<td className="px-2 text-right font-mono text-xs">{profile.minutes?.toLocaleString()}</td><td className="text-center font-mono text-xs">{profile.age ?? "—"}</td><td className="text-center"><button type="button" className="min-h-11 min-w-11 rounded focus-visible:ring-2 focus-visible:ring-lime-300" onClick={() => onRemove(row.key)} aria-label={`Remove ${profile.name} saved context`}>×</button></td></tr>;
  })}</tbody></table></div></section>;
}
