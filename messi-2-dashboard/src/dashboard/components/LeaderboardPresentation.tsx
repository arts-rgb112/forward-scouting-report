import type { ReactNode } from "react";

import type { QualityDisplay } from "../dataQualityViewModel";
import type { DatasetRouteState, Tier } from "../types";
import type { PlayerIdentityData, PlayerIdentityPresentation } from "./PlayerIdentity";
import { MetricScore, type MetricRankDisplay } from "./MetricScore";
import { PlayerIdentity } from "./PlayerIdentity";
import { TierBadge } from "./TierBadge";

export type LeaderboardPresentationPlayer<K extends string> = PlayerIdentityData & {
  rank: number; age: number | null; minutes: number; tier: Tier; score: number; scorePercentile?: number; stats: Record<K, number>;
};
export type MetricPresentation = { label: string; short: string; detail: string; formula: string };
export type MetricPresentationRegistry<K extends string> = Record<K, MetricPresentation>;
export type PresentationSort = { key: string; direction: "asc" | "desc" };
export type RankPresentation = { prefix?: ReactNode; mobilePrefix?: ReactNode; accessory?: ReactNode; hidden?: boolean };
export type LeaderboardPresentationRow<K extends string, P> = {
  key: string; source: P; playerId: number; identity: PlayerIdentityPresentation; identityDomId?: string | null; detailHref?: string;
  rank: RankPresentation; tier: Tier | null; tierAccessory?: ReactNode; score: number | null; scorePercentile?: number; stats: Partial<Record<K, number>>;
  minutes: number | null; age: number | null; metricSnapshot?: boolean; metricQuality?: QualityDisplay;
  metricRanks?: Partial<Record<K, MetricRankDisplay>>;
  profileAccessory?: ReactNode; mobileAccessory?: ReactNode; mobileAction?: ReactNode;
};
export type WatchPresentation<P> = {
  available: boolean; isWatched(player: P): boolean; onToggle(player: P): void | Promise<unknown>; unavailableLabel?: string;
  accessibleLabel?(player: P): string; visibleLabel?(player: P, watched: boolean, surface: "table" | "mobile"): ReactNode;
  buttonRef?(player: P, surface: "table" | "mobile", element: HTMLButtonElement | null): void;
};

type SharedProps<K extends string, P> = {
  players: readonly P[]; dataset?: DatasetRouteState; metricKeys: readonly K[]; metricRegistry: MetricPresentationRegistry<K>;
  sort: PresentationSort; onMetricSort?(key: "score" | K): void; onMinutesSort?(): void; detailHref?(player: P): string; watch: WatchPresentation<P>;
  rowAdapter?(player: P, index: number): LeaderboardPresentationRow<K, P>; caption?: string; density?: "main" | "watchlist";
  metricRanksByPlayerId?: Readonly<Record<number, Partial<Record<K, MetricRankDisplay>>>>;
};

export function LeaderboardTableColumns<K extends string>({ metricKeys, density = "main" }: { metricKeys: readonly K[]; density?: "main" | "watchlist" }) {
  return <colgroup><col className={density === "watchlist" ? "w-[430px]" : "w-[330px]"} /><col className="w-40" /><col className="w-24" />{metricKeys.map((key) => <col key={key} className="w-24" />)}<col className="w-24" /><col className="w-16" /><col className="w-24" /></colgroup>;
}
const order = (sort: PresentationSort, key: string) => sort.key === key ? (sort.direction === "asc" ? "ascending" : "descending") : "none";
function SortMetric<K extends string>({ metric, config, sort, onMetricSort }: { metric: K; config: MetricPresentation; sort: PresentationSort; onMetricSort(key: "score" | K): void }) { const active = sort.key === metric; return <button type="button" aria-label={`Sort by ${config.label}${active ? ` ${order(sort, metric)}` : ""}`} onClick={() => onMetricSort(metric)} className="min-h-11 px-1 text-[9px] uppercase tracking-wider hover:text-lime-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lime-300">{config.label}{active ? (sort.direction === "asc" ? " ↑" : " ↓") : ""}</button>; }
function SortScore<K extends string>({ sort, onMetricSort }: { sort: PresentationSort; onMetricSort(key: "score" | K): void }) { const active = sort.key === "score"; return <button type="button" aria-label={`Sort by M.E.S.S.I. score ${active ? order(sort, "score") : "descending"}`} onClick={() => onMetricSort("score")} className="min-h-11 px-1 text-[9px] uppercase tracking-wider hover:text-lime-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lime-300">M.E.S.S.I.{active ? (sort.direction === "asc" ? " ↑" : " ↓") : ""}</button>; }
export function LeaderboardTableHeader<K extends string>({ metricKeys, metricRegistry, sort, onMetricSort, onMinutesSort }: { metricKeys: readonly K[]; metricRegistry: MetricPresentationRegistry<K>; sort: PresentationSort; onMetricSort?(key: "score" | K): void; onMinutesSort?(): void }) {
  return <thead className="sticky top-0 z-30 bg-[#0b0e0f]/95"><tr className="h-11 border-b border-white/10 text-[9px] uppercase tracking-wider text-zinc-500"><th scope="col" className="sticky left-0 z-10 bg-[#0b0e0f] px-3 text-left">Player profile</th><th scope="col">Tier</th><th scope="col" aria-sort={onMetricSort ? order(sort, "score") : undefined}>{onMetricSort ? <SortScore sort={sort} onMetricSort={onMetricSort} /> : "M.E.S.S.I."}</th>{metricKeys.map((key) => <th key={key} scope="col" aria-sort={onMetricSort ? order(sort, key) : undefined}>{onMetricSort ? <SortMetric metric={key} config={metricRegistry[key]} sort={sort} onMetricSort={onMetricSort} /> : metricRegistry[key].label}</th>)}<th scope="col" className="text-right" aria-sort={onMinutesSort ? order(sort, "minutes") : undefined}>{onMinutesSort ? <button type="button" aria-label={`Sort by Minutes ${sort.key === "minutes" ? order(sort, "minutes") : ""}`} onClick={onMinutesSort} className="min-h-11 px-1 text-[9px] uppercase tracking-wider hover:text-lime-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lime-300">Minutes{sort.key === "minutes" ? (sort.direction === "asc" ? " ↑" : " ↓") : ""}</button> : "Minutes"}</th><th scope="col">Age</th><th scope="col">Watch</th></tr></thead>;
}

function isDefaultPlayer<K extends string>(value: unknown): value is LeaderboardPresentationPlayer<K> {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.id === "number" && typeof candidate.rank === "number" && typeof candidate.name === "string" && typeof candidate.score === "number" && Boolean(candidate.stats && typeof candidate.stats === "object") && Boolean(candidate.tier && typeof candidate.tier === "object");
}
function defaultRow<K extends string, P>(player: P, detailHref?: (player: P) => string): LeaderboardPresentationRow<K, P> {
  if (!isDefaultPlayer<K>(player)) throw new Error("Leaderboard rowAdapter is required for nullable or partial rows.");
  return { key: String(player.id), source: player, playerId: player.id, identity: { kind: "full", player }, detailHref: detailHref?.(player), rank: { prefix: String(player.rank).padStart(2, "0"), mobilePrefix: player.rank }, tier: player.tier, score: player.score, scorePercentile: player.scorePercentile, stats: player.stats, minutes: player.minutes, age: player.age };
}
function presentationRows<K extends string, P>(props: SharedProps<K, P>) { return props.players.map((player, index) => props.rowAdapter ? props.rowAdapter(player, index) : defaultRow<K, P>(player, props.detailHref)); }
function Identity<K extends string, P>({ row, dataset, mobile = false }: { row: LeaderboardPresentationRow<K, P>; dataset?: DatasetRouteState; mobile?: boolean }) {
  return row.identity.kind === "full"
    ? <PlayerIdentity player={row.identity.player} dataset={dataset} mobile={mobile} detailHref={row.detailHref} domId={row.identityDomId} />
    : <PlayerIdentity player={row.identity.player} partial dataset={dataset} mobile={mobile} detailHref={row.detailHref} domId={row.identityDomId} />;
}
const unavailableValue = (label: string) => <span aria-label={`${label} unavailable`} className="text-zinc-600">—</span>;
function WatchButton<K extends string, P>({ watch, row, surface }: { watch: WatchPresentation<P>; row: LeaderboardPresentationRow<K, P>; surface: "table" | "mobile" }) {
  const unavailable = watch.unavailableLabel ?? "준비 중"; const watched = watch.available ? watch.isWatched(row.source) : false;
  const visible = watch.visibleLabel?.(row.source, watched, surface) ?? (surface === "table" ? (watch.available ? (watched ? "✓" : "+") : unavailable) : (watch.available ? (watched ? "Saved to watchlist" : "Watch") : unavailable));
  return <button ref={(element) => watch.buttonRef?.(row.source, surface, element)} disabled={!watch.available} title={!watch.available ? unavailable : undefined} className={surface === "table" ? (watch.available ? "min-h-11 min-w-11 rounded focus-visible:ring-2 focus-visible:ring-lime-300" : "min-h-11 min-w-11 rounded text-[10px] text-zinc-500 disabled:cursor-not-allowed") : (watch.available ? "min-h-11 w-full rounded border border-white/10" : "min-h-11 w-full rounded border border-white/10 text-zinc-500 disabled:cursor-not-allowed")} onClick={watch.available ? () => { void watch.onToggle(row.source); } : undefined} aria-pressed={watch.available ? watched : false} aria-label={watch.accessibleLabel?.(row.source) ?? `${row.identity.player.name} watchlist${watch.available ? "" : `, ${unavailable}`}`}>{visible}</button>;
}

export function LeaderboardPlayerTable<K extends string, P>(props: SharedProps<K, P>) {
  const rows = presentationRows(props);
  const rankFor = (row: LeaderboardPresentationRow<K, P>, key: K) => row.metricRanks?.[key] ?? props.metricRanksByPlayerId?.[row.playerId]?.[key];
  return <section className="hidden rounded-lg border border-white/10 bg-[#0d1112] md:block"><div className="overflow-x-auto"><table className="w-full min-w-[1340px] table-fixed border-collapse"><caption className="sr-only">{props.caption ?? "Scouting dataset players and six sector scores"}</caption><LeaderboardTableColumns metricKeys={props.metricKeys} density={props.density} /><LeaderboardTableHeader metricKeys={props.metricKeys} metricRegistry={props.metricRegistry} sort={props.sort} onMetricSort={props.onMetricSort} onMinutesSort={props.onMinutesSort} /><tbody>{rows.map((row) => <tr key={row.key} className={`group ${props.density === "watchlist" ? "h-20" : "h-[72px]"} border-b border-white/[.07] hover:bg-lime-300/[.04]`}><th scope="row" className="sticky left-0 z-10 bg-[#0d1112] px-3 text-left group-hover:bg-[#121916]"><div className="flex items-center gap-3">{!row.rank.hidden && <span className="w-6 font-mono text-[10px] text-zinc-600">{row.rank.prefix ?? "—"}</span>}<div className="min-w-0 flex-1"><Identity row={row} dataset={props.dataset} />{(row.profileAccessory || row.rank.accessory) && <div className="ml-[60px] mt-1 flex flex-wrap items-center gap-1.5 text-[9px] text-zinc-400">{row.rank.accessory}{row.profileAccessory}</div>}</div></div></th><td className="px-1 text-center"><div className="flex flex-col items-center gap-1">{row.tier ? <TierBadge tier={row.tier} compact /> : unavailableValue("Tier")}{row.tierAccessory && <span className="text-[9px] text-zinc-500">{row.tierAccessory}</span>}</div></td><td title={row.scorePercentile === undefined ? undefined : `Cohort percentile: ${row.scorePercentile}`} className="text-center font-mono text-lg font-black">{row.score === null ? unavailableValue("M.E.S.S.I. score") : row.score.toFixed(1)}</td>{props.metricKeys.map((key) => <td key={key}>{row.stats[key] === undefined ? unavailableValue(props.metricRegistry[key].label) : <MetricScore playerId={row.playerId} metric={key} value={row.stats[key]} surface="table" snapshot={row.metricSnapshot} quality={row.metricQuality} presentation={props.metricRegistry[key]} metricRank={rankFor(row, key)} />}</td>)}<td className="px-2 text-right font-mono text-xs">{row.minutes === null ? unavailableValue("Minutes") : row.minutes.toLocaleString()}</td><td title={row.age === null ? "Birth date unavailable" : undefined} className="text-center font-mono text-xs">{row.age ?? "—"}</td><td className="text-center"><WatchButton watch={props.watch} row={row as LeaderboardPresentationRow<string, P>} surface="table" /></td></tr>)}</tbody></table></div></section>;
}

export function LeaderboardPlayerCardList<K extends string, P>(props: SharedProps<K, P>) {
  const rows = presentationRows(props); const scoreOrder = props.sort.key === "score" && props.sort.direction === "asc" ? "ascending" : "descending";
  const rankFor = (row: LeaderboardPresentationRow<K, P>, key: K) => row.metricRanks?.[key] ?? props.metricRanksByPlayerId?.[row.playerId]?.[key];
  return <section className="space-y-2 md:hidden" aria-label="Mobile player list">{props.onMetricSort && <button type="button" onClick={() => props.onMetricSort?.("score")} aria-label={`Sort by M.E.S.S.I. score ${scoreOrder}`} className="min-h-11 rounded border border-white/10 bg-[#0d1112] px-3 text-xs font-bold text-zinc-300">M.E.S.S.I. score {scoreOrder === "ascending" ? "↑" : "↓"}</button>}{rows.map((row) => <article key={row.key} className="rounded-lg border border-white/10 bg-[#0d1112] p-3"><div className="flex items-start gap-2">{!row.rank.hidden && <span className="pt-1 font-mono text-[10px] text-zinc-600">{row.rank.mobilePrefix ?? row.rank.prefix ?? "—"}</span>}<div className="min-w-0 flex-1"><div className="flex justify-between gap-2"><Identity row={row} dataset={props.dataset} mobile /><div className="text-right">{row.score === null ? unavailableValue("M.E.S.S.I. score") : <b title={row.scorePercentile === undefined ? undefined : `Cohort percentile: ${row.scorePercentile}`} className="font-mono text-lg">{row.score.toFixed(1)}</b>}<div>{row.tier ? <TierBadge tier={row.tier} compact /> : unavailableValue("Tier")}</div>{row.tierAccessory && <span className="text-[9px] text-zinc-500">{row.tierAccessory}</span>}</div></div></div></div>{(row.mobileAccessory || row.profileAccessory || row.rank.accessory) && <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[10px] text-zinc-400">{row.rank.accessory}{row.mobileAccessory ?? row.profileAccessory}</div>}<div className="mt-3 grid grid-cols-3 gap-2">{props.metricKeys.map((key) => <div key={key} className="rounded bg-black/20 p-2 text-center"><p className="mb-1 text-[9px] text-zinc-500">{props.metricRegistry[key].short}</p>{row.stats[key] === undefined ? unavailableValue(props.metricRegistry[key].label) : <MetricScore playerId={row.playerId} metric={key} value={row.stats[key]} surface="mobile" compact snapshot={row.metricSnapshot} quality={row.metricQuality} presentation={props.metricRegistry[key]} metricRank={rankFor(row, key)} />}</div>)}</div><div className={`mt-3 ${row.mobileAction ? "grid grid-cols-2 gap-2" : ""}`}>{row.mobileAction}<WatchButton watch={props.watch} row={row as LeaderboardPresentationRow<string, P>} surface="mobile" /></div></article>)}</section>;
}
