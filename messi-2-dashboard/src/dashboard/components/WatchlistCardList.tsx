import { metricConfig, metricKeys } from "../scoutingConfig";
import type { WatchlistRow } from "../watchlistViewModel";
import { datasetStateFromWatchlistEntry, watchlistContextLabel } from "../watchlistViewModel";
import { enabledLegacyHref, legacyDetailHref } from "../../navigation/legacyHandoff";
import { datasetHref } from "../datasetRoute";
import { MetricScore } from "./MetricScore";
import { TierBadge } from "./TierBadge";

type Props = { rows: readonly WatchlistRow[]; onRemove(key: string): void };
function profileHref(row: WatchlistRow) {
  const state = datasetStateFromWatchlistEntry(row.entry); const player = row.player;
  return enabledLegacyHref(legacyDetailHref(row.entry.playerId, { name: player?.name ?? row.entry.snapshot.name, clubName: player?.club.name ?? row.entry.snapshot.clubName }, state) ?? "") ?? datasetHref(`/players/${row.entry.playerId}`, state);
}
export function WatchlistCardList({ rows, onRemove }: Props) {
  return <section className="space-y-2 md:hidden" aria-label="Saved player contexts">{rows.map((row) => { const player = row.player; const name = player?.name ?? row.entry.snapshot.name; return <article key={row.key} className="rounded-lg border border-white/10 bg-[#0d1112] p-3"><div className="flex items-start justify-between gap-2"><div className="min-w-0"><a href={profileHref(row)} className="block truncate font-bold hover:text-lime-300">{name}</a><p className="truncate text-[10px] text-zinc-500">{player?.position ?? row.entry.snapshot.position} · {player?.club.name ?? row.entry.snapshot.clubName}</p><span className="mt-2 inline-flex rounded border border-lime-300/25 bg-lime-300/10 px-2 py-1 text-[9px] font-bold text-lime-100">{watchlistContextLabel(row.entry)}</span></div><div className="text-right"><b className="font-mono text-lg">{player?.score ?? row.entry.snapshot.score ?? "—"}</b><div>{player ? <TierBadge tier={player.tier} compact /> : <span className="text-xs text-zinc-500">{row.entry.snapshot.tierLabel ?? "—"}</span>}</div></div></div><div className="mt-3 grid grid-cols-3 gap-2">{metricKeys.map((key) => <div key={key} className="rounded bg-black/20 p-2 text-center"><p className="mb-1 text-[9px] text-zinc-500">{metricConfig[key].short}</p>{player ? <MetricScore playerId={player.id} metric={key} value={player.stats[key]} surface="mobile" compact /> : <span className="inline-flex h-9 items-center text-xs text-zinc-600">—</span>}</div>)}</div><p className="mt-3 text-[10px] text-zinc-500">Saved-context metrics are not ranked against one another.</p><button type="button" className="mt-2 min-h-11 w-full rounded border border-white/10" onClick={() => onRemove(row.key)}>Remove this context</button></article>; })}</section>;
}
