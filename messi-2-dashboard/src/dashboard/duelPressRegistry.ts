import { metricConfig } from "./scoutingConfig";
import { legacyMetricKeys } from "./types";
import { DUEL_PRESS_METRIC_KEYS, type DuelPressMetricKey } from "../api/duelPressTypes";
import type { MetricPresentation } from "./components/LeaderboardPresentation";
export const duelPressMetricConfig: Record<DuelPressMetricKey, MetricPresentation> = {
  outsideShot: metricConfig.outsideShot, boxThreat: metricConfig.boxThreat, dangerZone: metricConfig.dangerZone,
  combinedDuel: { label: "통합 경합", short: "경합", detail: "지상·공중 경합의 시도량과 승패 마진을 각각 정규화해 균등 결합한 종합 경합 영향력입니다." },
  spaceControl: metricConfig.spaceControl,
  forwardPress: { label: "전방 압박 효율", short: "전방 압박", detail: "파이널 서드에서의 소유권 획득과 경기 전체의 볼 회수 빈도를 동일 코호트 백분위로 변환한 뒤 50:50으로 결합한 압박·세컨드볼 회수 지표입니다." },
};
export const duelPressTaxonomyRegistry = { "legacy-v1": { metricKeys: legacyMetricKeys, config: metricConfig }, "duel-press-v1": { metricKeys: DUEL_PRESS_METRIC_KEYS, config: duelPressMetricConfig } } as const;
