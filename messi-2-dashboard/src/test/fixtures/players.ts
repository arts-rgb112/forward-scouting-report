import type { DatasetMeta, Player } from "../../dashboard/types";
const asset = (id: number, name: string) => ({ id, name, icon: null });
export const samplePlayers: Player[] = [
 { id: 1, rank: 2, name: "Erling Haaland", position: "CF", archetype: "Type A", age: 25, minutes: 1900, tier: { code: "diamond", level: 2, label: "Diamond II" }, score: 94.2, face: null, nation: asset(1, "Norway"), league: asset(10, "Premier League"), club: asset(20, "Manchester City"), stats: { outsideShot: 82, boxThreat: 98, dangerZone: 94, aerial: 91, groundDuel: 79, spaceControl: 93 } },
 { id: 2, rank: 1, name: "Kylian Mbappe", position: "LW", archetype: "Type B", age: null, minutes: 1800, tier: { code: "platinum", level: 1, label: "Platinum I" }, score: 95.1, face: null, nation: null, league: asset(11, "La Liga"), club: asset(21, "Real Madrid"), stats: { outsideShot: 93, boxThreat: 96, dangerZone: 97, aerial: 51, groundDuel: 88, spaceControl: 94 } },
];
export const sampleMeta: DatasetMeta = { schemaVersion: "1.0.0", season: "2025/2026", scope: 7, population: 2, returned: 2, generatedAt: "2026-08-10T12:00:00+09:00", source: "messi-static-cohort" };
