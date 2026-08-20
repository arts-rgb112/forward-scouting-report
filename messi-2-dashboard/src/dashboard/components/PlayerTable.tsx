import { metricConfig, metricKeys } from "../scoutingConfig";
import type { DatasetRouteState, MetricKey, Player, SortKey, SortState } from "../types";
import { contextFromDataset, watchlistKey } from "../watchlistStorage";
import { LeaderboardPlayerTable, LeaderboardTableColumns, LeaderboardTableHeader } from "./LeaderboardPresentation";

type Props = { players: readonly Player[]; dataset?: DatasetRouteState; watchedKeys?: ReadonlySet<string>; watchedIds?: ReadonlySet<number>; sort: SortState; onMetricSort(key: SortKey): void; onToggleWatch(player: Player): void; comparedIds?: ReadonlySet<number>; onToggleCompare?(player: Player): void };
export function TableColumns() { return <LeaderboardTableColumns metricKeys={metricKeys} />; }
export function TableHeader({ sort, onMetricSort }: { sort: SortState; onMetricSort(key: SortKey): void }) { return <LeaderboardTableHeader<MetricKey> metricKeys={metricKeys} metricRegistry={metricConfig} sort={sort} onMetricSort={onMetricSort} />; }
export function PlayerTable({ players, dataset, watchedKeys, watchedIds, sort, onMetricSort, onToggleWatch }: Props) {
  const context = dataset ? contextFromDataset(dataset) : undefined;
  const isWatched = (player: Player) => context ? Boolean(watchedKeys?.has(watchlistKey(player.id, context))) : Boolean(watchedIds?.has(player.id));
  return <LeaderboardPlayerTable<MetricKey, Player> players={players} dataset={dataset} metricKeys={metricKeys} metricRegistry={metricConfig} sort={sort} onMetricSort={onMetricSort} watch={{ available: true, isWatched, onToggle: onToggleWatch }} />;
}
