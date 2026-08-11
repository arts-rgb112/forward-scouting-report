export const metricKeys = ["outsideShot", "boxThreat", "dangerZone", "aerial", "groundDuel", "spaceControl"] as const;
export type MetricKey = (typeof metricKeys)[number];
export const tierCodes = ["diamond", "platinum", "gold", "silver", "bronze", "iron"] as const;
export type TierCode = (typeof tierCodes)[number];
export type SortKey = "score" | "name" | "age" | MetricKey;
export type SortState = { key: SortKey; direction: "asc" | "desc" };
export type DatasetMode = "league" | "europe";
export type CompetitionCode = "all" | "ucl" | "uel" | "uecl";
export type DatasetRouteState = { season: string; mode: DatasetMode; scope: 3 | 5 | 7; competition: CompetitionCode };
export type CompetitionOption = { code: CompetitionCode; label: string; available: boolean; reason: string | null };
export type LeaderboardOptions = { seasons: string[]; scopes: { value: 3 | 5 | 7; label: string; leagueIds: number[] }[]; competitions: Record<CompetitionCode, CompetitionOption> };
export type AssetRef = { id: number; name: string; icon: string | null };
export type Tier = { code: TierCode; level: number; label: string };
export type Player = {
  id: number; rank: number; name: string; position: string; archetype: "Type A" | "Type B";
  age: number | null; minutes: number; tier: Tier; score: number; face: string | null;
  nation: AssetRef | null; league: AssetRef; club: AssetRef; stats: Record<MetricKey, number>;
};
export type DatasetMeta = {
  schemaVersion: "1.0.0" | "2.0.0" | "2.1.0"; season: string; scope: 3 | 5 | 7 | null; population: number;
  returned: number; generatedAt: string; source: "messi-static-cohort"; mode?: DatasetMode; competition?: CompetitionCode | null;
};
export type ServerPageMeta = { page: number; pageSize: number; totalPages: number; hasNextPage: boolean };
export type PlayersPayload = { players: Player[]; meta: DatasetMeta; serverPage?: ServerPageMeta };
export type LeaderboardSearch = { page: number; pageSize: number; q: string; role: "all" | "Type A" | "Type B"; sort: SortKey; direction: "asc" | "desc" };
export type RadarAxis = { id: string; label: string; score: number; percentile: number | null; rank: number | null; population: number; rawValue: number | null; tier: "S" | "A" | "B" | "C" | "D"; imputed: boolean };
export type PlayerAnalysis = { score: { value: number; rank: number | null; topPercent: number | null; population: number; archetype: "Type A" | "Type B" }; volumeRadar: { kind: "volume"; axes: RadarAxis[] }; ratioRadar: { kind: "ratio"; axes: RadarAxis[] }; rawMetrics: Record<string, number | null>; spatial: { available: boolean; heatmapPointCount: number; inBoxRatio: number | null; outBoxFinalRatio: number | null; midThirdRatio: number | null; finalThirdRatio: number | null; ccaAreaPct: number | null; laneRatios: number[]; dangerZoneDensity: number | null; deepBoxZoneScore: number | null } };
export type PlayerDetail = { player: Player; analysis?: PlayerAnalysis };
export type PlayerComparison = { players: PlayerDetail[]; meta: Omit<DatasetMeta, "schemaVersion" | "returned"> };
