import type { DuelPressMetricKey, DuelPressPlayerCore } from "../../api/duelPressTypes";
import { DUEL_PRESS_METRIC_KEYS } from "../../api/duelPressTypes";
import { duelPressMetricConfig } from "../duelPressRegistry";
import { duelPressDetailHref } from "../duelPressRoute";
import type { DatasetRouteState } from "../types";
import { LeaderboardPlayerCardList, LeaderboardPlayerTable, type PresentationSort, type WatchPresentation } from "./LeaderboardPresentation";
import type { MetricRankMap } from "../useMetricRanks";

type Props = {
  players: readonly DuelPressPlayerCore[]; dataset: DatasetRouteState; sort: PresentationSort;
  onMetricSort(key: "score" | DuelPressMetricKey): void;
  watch?: WatchPresentation<DuelPressPlayerCore>;
  metricRanksByPlayerId?: Readonly<Record<number, MetricRankMap>>;
};
const unavailableWatch = { available: false, isWatched: () => false, onToggle: () => undefined, unavailableLabel: "준비 중" } as const;
export function DuelPressPlayerTable(props: Props) {
  return <LeaderboardPlayerTable players={props.players} dataset={props.dataset} metricKeys={DUEL_PRESS_METRIC_KEYS} metricRegistry={duelPressMetricConfig} sort={props.sort} onMetricSort={props.onMetricSort} detailHref={(player) => duelPressDetailHref(player.id, props.dataset)} watch={props.watch ?? unavailableWatch} metricRanksByPlayerId={props.metricRanksByPlayerId} />;
}
export function DuelPressPlayerCardList(props: Props) {
  return <LeaderboardPlayerCardList players={props.players} dataset={props.dataset} metricKeys={DUEL_PRESS_METRIC_KEYS} metricRegistry={duelPressMetricConfig} sort={props.sort} onMetricSort={props.onMetricSort} detailHref={(player) => duelPressDetailHref(player.id, props.dataset)} watch={props.watch ?? unavailableWatch} metricRanksByPlayerId={props.metricRanksByPlayerId} />;
}
