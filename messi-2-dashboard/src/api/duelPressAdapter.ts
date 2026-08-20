import type { DuelPressPlayerCore } from "./duelPressTypes";
import type { DuelPressRowCoreDto } from "./duelPressContracts";
/** Structural copy only: score, rank and every component remain server-owned. */
export function adaptDuelPressPlayerCore(dto: DuelPressRowCoreDto): DuelPressPlayerCore {
  return { ...dto, tier: { ...dto.tier }, nation: dto.nation ? { ...dto.nation } : null, league: { ...dto.league }, club: { ...dto.club }, stats: { ...dto.stats }, components: { ...dto.components }, pressingRawMetrics: { ...dto.pressingRawMetrics } };
}
