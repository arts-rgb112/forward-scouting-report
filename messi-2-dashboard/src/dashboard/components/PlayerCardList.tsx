import { metricConfig, metricKeys } from "../scoutingConfig";
import type { DatasetRouteState, Player } from "../types";
import { contextFromDataset, watchlistKey } from "../watchlistStorage";
import { MetricScore } from "./MetricScore";
import { PlayerIdentity } from "./PlayerIdentity";
import { TierBadge } from "./TierBadge";

type Props = { players: readonly Player[]; dataset?: DatasetRouteState; watchedKeys?: ReadonlySet<string>; watchedIds?: ReadonlySet<number>; onToggleWatch(player: Player): void; comparedIds?: ReadonlySet<number>; onToggleCompare?(player: Player): void };
export function PlayerCardList({ players, dataset, watchedKeys, watchedIds, onToggleWatch }: Props) {
  const context = dataset ? contextFromDataset(dataset) : undefined;
  const isWatched = (player: Player) => context ? Boolean(watchedKeys?.has(watchlistKey(player.id, context))) : Boolean(watchedIds?.has(player.id));
  return <section className="space-y-2 md:hidden" aria-label="Mobile player list">{players.map((player) => <article key={player.id} className="rounded-lg border border-white/10 bg-[#0d1112] p-3"><div className="flex items-start gap-2"><span className="pt-1 font-mono text-[10px] text-zinc-600">{player.rank}</span><div className="min-w-0 flex-1"><div className="flex justify-between gap-2"><PlayerIdentity player={player} dataset={dataset} mobile /><div className="text-right"><b className="font-mono text-lg">{player.score.toFixed(1)}</b><div><TierBadge tier={player.tier} compact /></div></div></div></div></div><div className="mt-3 grid grid-cols-3 gap-2">{metricKeys.map((key) => <div key={key} className="rounded bg-black/20 p-2 text-center"><p className="mb-1 text-[9px] text-zinc-500">{metricConfig[key].short}</p><MetricScore playerId={player.id} metric={key} value={player.stats[key]} surface="mobile" compact /></div>)}</div><div className="mt-3"><button className="min-h-11 w-full rounded border border-white/10" onClick={() => onToggleWatch(player)} aria-pressed={isWatched(player)}>{isWatched(player) ? "Saved to watchlist" : "Watch"}</button></div></article>)}</section>;
}
