export const DUEL_PRESS_TAXONOMY_VERSION = "duel-press-v1" as const;
export const DUEL_PRESS_METRIC_KEYS = ["outsideShot", "boxThreat", "dangerZone", "combinedDuel", "spaceControl", "forwardPress"] as const;
export type DuelPressMetricKey = (typeof DUEL_PRESS_METRIC_KEYS)[number];
export type DuelPressSortKey = "score" | DuelPressMetricKey;
export type DuelPressComponents = { combinedDuelVolume: number; combinedDuelEfficiency: number; recoveries: number; finalThirdPossessionsWon: number };
export type PressingRawSource = "player_season_total" | "league_per90_fallback" | null;
export type PressingRawMetrics = {
  recoveries: number | null; recoveriesPer90: number | null; recoveriesSource: PressingRawSource;
  finalThirdPossessionsWon: number | null; finalThirdPossessionsWonPer90: number | null; finalThirdPossessionsWonSource: PressingRawSource;
};
/** Confirmed fields only. Display/meta fields remain fixture-gated. */
export type DuelPressPlayerCore = {
  id: number; idNamespace: "fotmob"; rank: number; score: number;
  stats: Record<DuelPressMetricKey, number>; components: DuelPressComponents; pressingRawMetrics: PressingRawMetrics;
};
export type DuelPressModeContext =
  | { season: string; mode: "league"; scope: 3 | 5 | 7 | 8; competition: "all" }
  | { season: string; mode: "europe"; scope: null; competition: "all" | "ucl" | "uel" | "uecl" };
export type TaxonomyPlayerCore =
  | { metricTaxonomyVersion: "legacy-v1"; player: import("../dashboard/types").LegacyPlayer }
  | { metricTaxonomyVersion: "duel-press-v1"; player: DuelPressPlayerCore };
