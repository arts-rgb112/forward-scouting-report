import { metricConfig, metricKeys } from "../scoutingConfig";
import type { MetricKey, SortState } from "../types";
import type { WatchlistRow } from "../watchlistViewModel";
import { datasetStateFromWatchlistEntry, watchlistContextLabel } from "../watchlistViewModel";
import { enabledLegacyHref, legacyDetailHref } from "../../navigation/legacyHandoff";
import { datasetHref } from "../datasetRoute";
import { AssetImage } from "./AssetImage";
import { MetricScore } from "./MetricScore";
import { TierBadge } from "./TierBadge";

type Props = { rows: readonly WatchlistRow[]; sort: SortState; onMetricSort(key: MetricKey): void; onRemove(key: string): void };
const emptyMetric = <span className="text-xs text-zinc-600">—</span>;

function detailHref(row: WatchlistRow) {
  const state = datasetStateFromWatchlistEntry(row.entry);
  const name = row.player?.name ?? row.entry.snapshot.name;
  const clubName = row.player?.club.name ?? row.entry.snapshot.clubName;
  return enabledLegacyHref(legacyDetailHref(row.entry.playerId, { name, clubName }, state) ?? "") ?? datasetHref(`/players/${row.entry.playerId}`, state);
}
function RowIdentity({ row }: { row: WatchlistRow }) {
  const player = row.player; const snapshot = row.entry.snapshot; const name = player?.name ?? snapshot.name;
  return <div className="flex min-w-0 items-center gap-3"><AssetImage src={player?.face ?? snapshot.face ?? null} alt={`${name} portrait`} kind="face" fallbackLabel={name} width={48} height={48} className="h-12 w-12 rounded-md border border-white/10 object-cover" /><div className="min-w-0"><a href={detailHref(row)} className="block truncate text-[13px] font-extrabold hover:text-lime-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lime-300">{name}</a><p className="mt-0.5 truncate text-[10px] text-zinc-500">{player?.club.name ?? snapshot.clubName} · {player?.league.name ?? snapshot.leagueName ?? "—"}</p><div className="mt-1 flex flex-wrap items-center gap-1"><span className="rounded border border-white/10 px-1.5 py-0.5 font-mono text-[9px] text-zinc-400">{player?.position ?? snapshot.position}</span>{player?.archetype && <span className="text-[9px] text-zinc-600">{player.archetype}</span>}<span className="rounded border border-lime-300/25 bg-lime-300/10 px-1.5 py-0.5 text-[9px] font-bold text-lime-100">{watchlistContextLabel(row.entry)}</span></div></div></div>;
}
function SortMetric({ metric, sort, onMetricSort }: { metric: MetricKey; sort: SortState; onMetricSort(metric: MetricKey): void }) {
  const active = sort.key === metric;
  return <button type="button" onClick={() => onMetricSort(metric)} className="min-h-11 px-1 text-[9px] uppercase tracking-wider hover:text-lime-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lime-300">{metricConfig[metric].label}{active ? (sort.direction === "asc" ? " ↑" : " ↓") : ""}</button>;
}

export function WatchlistTable({ rows, sort, onMetricSort, onRemove }: Props) {
  return <section className="hidden rounded-lg border border-white/10 bg-[#0d1112] md:block"><div className="overflow-x-auto"><table className="w-full min-w-[1340px] table-fixed border-collapse"><caption className="sr-only">Saved player contexts. Scores and ranks are specific to each saved context.</caption><colgroup><col className="w-[430px]" /><col className="w-20" /><col className="w-24" />{metricKeys.map((key) => <col key={key} className="w-24" />)}<col className="w-24" /><col className="w-16" /><col className="w-24" /></colgroup><thead className="sticky top-0 z-30 bg-[#0b0e0f]/95"><tr className="h-11 border-b border-white/10 text-[9px] uppercase tracking-wider text-zinc-500"><th scope="col" className="sticky left-0 z-10 bg-[#0b0e0f] px-3 text-left">Saved player context</th><th scope="col">Tier</th><th scope="col">M.E.S.S.I.</th>{metricKeys.map((key) => <th key={key} scope="col" aria-sort={sort.key === key ? (sort.direction === "asc" ? "ascending" : "descending") : "none"}><SortMetric metric={key} sort={sort} onMetricSort={onMetricSort} /></th>)}<th scope="col" className="text-right">Minutes</th><th scope="col">Age</th><th scope="col">Watch</th></tr></thead><tbody>{rows.map((row) => { const player = row.player; return <tr key={row.key} className="group h-[82px] border-b border-white/[.07] hover:bg-lime-300/[.04]"><th scope="row" className="sticky left-0 z-10 bg-[#0d1112] px-3 text-left group-hover:bg-[#121916]"><RowIdentity row={row} /></th><td className="px-1 text-center">{player ? <TierBadge tier={player.tier} compact /> : <span className="text-xs text-zinc-500">{row.entry.snapshot.tierLabel ?? "—"}</span>}</td><td className="text-center font-mono text-lg font-black">{player?.score ?? row.entry.snapshot.score ?? "—"}</td>{metricKeys.map((key) => <td key={key}>{player ? <MetricScore playerId={player.id} metric={key} value={player.stats[key]} surface="table" /> : <div className="flex justify-center">{emptyMetric}</div>}</td>)}<td className="px-2 text-right font-mono text-xs">{player ? player.minutes.toLocaleString() : "—"}</td><td className="text-center font-mono text-xs">{player?.age ?? "—"}</td><td className="text-center"><button type="button" className="min-h-11 min-w-11 rounded focus-visible:ring-2 focus-visible:ring-lime-300" onClick={() => onRemove(row.key)} aria-label={`Remove ${player?.name ?? row.entry.snapshot.name} saved context`}>×</button></td></tr>; })}</tbody></table></div></section>;
}
