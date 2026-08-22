import type { DuelPressPlayerCore } from "./duelPressTypes";
import type { DuelPressRowCoreDto } from "./duelPressContracts";
import type { DuelPressV2Player } from "./duelPressV2Contracts";
/** Structural copy only: score, rank and every component remain server-owned. */
export function adaptDuelPressPlayerCore(dto: DuelPressRowCoreDto): DuelPressPlayerCore {
  return { ...dto, tier: { ...dto.tier }, nation: dto.nation ? { ...dto.nation } : null, league: { ...dto.league }, club: { ...dto.club }, stats: { ...dto.stats }, components: { ...dto.components }, pressingRawMetrics: { ...dto.pressingRawMetrics } };
}

/** Presentation adapter for the official v2 leaderboard. Only server-owned
 * percentile scores are exposed to the legacy table shape; v2 does not carry
 * the v1 raw component payload, so those fields remain unavailable. */
export function adaptDuelPressV2PlayerCore(dto: DuelPressV2Player["data"]): DuelPressPlayerCore {
  return {
    id: dto.id, idNamespace: dto.idNamespace, rank: dto.rank, name: dto.name,
    position: dto.position, archetype: dto.archetype === "Type B" ? "Type B" : "Type A",
    age: dto.age, minutes: dto.minutes, tier: { ...dto.tier, code: dto.tier.code as "diamond" | "emerald" | "platinum" | "gold" | "silver" | "bronze" }, score: dto.overallRating.percentileScore,
    face: dto.face, nation: dto.nation ? { ...dto.nation } : null, league: { ...dto.league }, club: { ...dto.club },
    stats: {
      outsideShot: dto.stats.outsideShot.percentileScore,
      boxThreat: dto.stats.boxThreat.percentileScore,
      dangerZone: dto.stats.dangerZone.percentileScore,
      combinedDuel: dto.stats.combinedDuel.percentileScore,
      spaceControl: dto.stats.spaceControl.percentileScore,
      forwardPress: dto.stats.forwardPress.percentileScore,
    },
  };
}
