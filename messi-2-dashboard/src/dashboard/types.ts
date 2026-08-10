export const metricKeys = ["outsideShot", "boxThreat", "dangerZone", "aerial", "groundDuel", "spaceControl"] as const;
export type MetricKey = (typeof metricKeys)[number];
export const tierCodes = ["diamond", "platinum", "gold", "silver", "bronze", "iron"] as const;
export type TierCode = (typeof tierCodes)[number];
export type SortKey = "score" | "name" | "age";
export type AssetRef = { id: number; name: string; icon: string | null };
export type Tier = { code: TierCode; level: number; label: string };
export type Player = {
  id: number; rank: number; name: string; position: string; archetype: "Type A" | "Type B";
  age: number | null; minutes: number; tier: Tier; score: number; face: string | null;
  nation: AssetRef | null; league: AssetRef; club: AssetRef; stats: Record<MetricKey, number>;
};
export type DatasetMeta = {
  schemaVersion: "1.0.0"; season: string; scope: 3 | 5 | 7; population: number;
  returned: number; generatedAt: string; source: "messi-static-cohort";
};
export type PlayersPayload = { players: Player[]; meta: DatasetMeta };
