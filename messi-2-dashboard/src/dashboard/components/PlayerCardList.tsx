import { metricConfig, metricKeys } from "../scoutingConfig";
import type { DatasetRouteState, MetricKey, Player, SortState } from "../types";
import { contextFromDataset, watchlistKey } from "../watchlistStorage";
import { LeaderboardPlayerCardList } from "./LeaderboardPresentation";

type Props = { players: readonly Player[]; dataset?: DatasetRouteState; watchedKeys?: ReadonlySet<string>; watchedIds?: ReadonlySet<number>; onToggleWatch(player: Player): void; comparedIds?: ReadonlySet<number>; onToggleCompare?(player: Player): void; sort?: SortState; onScoreSort?(): void };
export function PlayerCardList({ players, dataset, watchedKeys, watchedIds, onToggleWatch, sort = { key: "score", direction: "desc" }, onScoreSort }: Props) {
  const context = dataset ? contextFromDataset(dataset) : undefined;
  const isWatched = (player: Player) => context ? Boolean(watchedKeys?.has(watchlistKey(player.id, context))) : Boolean(watchedIds?.has(player.id));
  return <LeaderboardPlayerCardList<MetricKey, Player> players={players} dataset={dataset} metricKeys={metricKeys} metricRegistry={metricConfig} sort={sort} onMetricSort={() => onScoreSort?.()} watch={{ available: true, isWatched, onToggle: onToggleWatch }} />;
}
