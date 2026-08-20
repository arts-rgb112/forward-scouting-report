import type { DuelPressPlayerCore } from "./duelPressTypes";
import type { DuelPressRowCoreDto } from "./duelPressContracts";
/** Structural copy only: score, rank and every component remain server-owned. */
export function adaptDuelPressPlayerCore(dto: DuelPressRowCoreDto): DuelPressPlayerCore {
  return { id: dto.id, idNamespace: dto.idNamespace, rank: dto.rank, score: dto.score, stats: { ...dto.stats }, components: { ...dto.components }, pressingRawMetrics: { ...dto.pressingRawMetrics } };
}
