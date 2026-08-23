export const DUEL_PRESS_TAXONOMY_VERSION = "duel-press-v1" as const;
export const DUEL_PRESS_METRIC_KEYS = ["outsideShot", "boxThreat", "dangerZone", "combinedDuel", "spaceControl", "forwardPress"] as const;
export type DuelPressMetricKey = (typeof DUEL_PRESS_METRIC_KEYS)[number];
export type DuelPressSortKey = "rank" | "score" | "name" | "minutes" | "age" | DuelPressMetricKey;
export type DuelPressComponents = { combinedDuelVolume: number; combinedDuelEfficiency: number; recoveries: number; finalThirdPossessionsWon: number };
export type PressingRawSource = "player_season_total" | "league_per90_fallback" | null;
export type PressingRawMetrics = {
  recoveries: number | null; recoveriesPer90: number | null; recoveriesSource: PressingRawSource;
  finalThirdPossessionsWon: number | null; finalThirdPossessionsWonPer90: number | null; finalThirdPossessionsWonSource: PressingRawSource;
};
/** Confirmed fields only. Display/meta fields remain fixture-gated. */
export type DuelPressPlayerCore = {
  id: number; idNamespace: "fotmob"; rank: number; name: string; position: string; archetype: "Type A" | "Type B"; age: number | null; minutes: number;
  tier: { code: "diamond" | "emerald" | "platinum" | "gold" | "silver" | "bronze"; level: number; label: string; taxonomyVersion: "crystal-v2" }; score: number; scorePercentile?: number; face: string;
  nation: { id: number; name: string; icon: string } | null; league: { id: number; name: string; icon: string }; club: { id: number; name: string; icon: string };
  stats: Record<DuelPressMetricKey, number>; components?: DuelPressComponents; pressingRawMetrics?: PressingRawMetrics;
};
export type DuelPressModeContext =
  | { season: string; mode: "league"; scope: 3 | 5 | 7 | 8; competition: "all" }
  | { season: string; mode: "europe"; scope: null; competition: "all" | "ucl" | "uel" | "uecl" };
export type DuelPressSearch = { page: number; pageSize: 50; q: string; role: "all" | "Type A" | "Type B"; position: string; ageBand: "all" | "u23" | "u25" | "26-30" | "31-plus"; minutesBand: "all" | "200-499" | "500-999" | "1000-1499" | "1500-1999" | "2000-2999" | "3000-plus"; sort: DuelPressSortKey; direction: "asc" | "desc" };
export type DuelPressLeaderboardPayload = {
  players: DuelPressPlayerCore[];
  meta: import("./duelPressContracts").DuelPressLeaderboardDto["meta"];
  serverPage: { page: number; pageSize: 50; totalPages: number; hasNextPage: boolean };
  /**
   * Server-owned v2 rating snapshot.  This is deliberately absent for the
   * legacy/v1 transport so consumers cannot accidentally treat v1 data as a
   * v2 snapshot.  It participates in resource identity and cache invalidation;
   * it is never used to calculate or transform a score in the browser.
   */
  ratingSnapshotId?: string;
};
export type TaxonomyPlayerCore =
  | { metricTaxonomyVersion: "legacy-v1"; player: import("../dashboard/types").LegacyPlayer }
  | { metricTaxonomyVersion: "duel-press-v1"; player: DuelPressPlayerCore };
