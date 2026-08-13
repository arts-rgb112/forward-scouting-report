import type { PlayerDto, PlayersEnvelope } from "./contracts";
import type { Player, PlayersPayload, PlayerAnalysis } from "../dashboard/types";
export const adaptPlayer = (dto: PlayerDto, responseTierTaxonomyVersion?: string): Player => ({
  id: dto.id, rank: dto.rank, name: dto.name, position: dto.position, archetype: dto.archetype, age: dto.age,
  minutes: dto.minutes, tier: { ...dto.tier, ...(dto.tier.taxonomyVersion ?? responseTierTaxonomyVersion ? { taxonomyVersion: dto.tier.taxonomyVersion ?? responseTierTaxonomyVersion } : {}) }, score: dto.score, face: dto.face,
  nation: dto.nation ? { ...dto.nation } : null, league: { ...dto.league }, club: { ...dto.club }, stats: { ...dto.stats },
});
export const adaptEnvelope = (envelope: PlayersEnvelope): PlayersPayload => {
  const tierTaxonomyVersion = envelope.tierTaxonomyVersion ?? envelope.meta.tierTaxonomyVersion;
  return { players: envelope.data.map((player) => adaptPlayer(player, tierTaxonomyVersion)), meta: { ...envelope.meta, ...(tierTaxonomyVersion ? { tierTaxonomyVersion } : {}) } };
};
export const adaptAnalysis = (analysis: PlayerAnalysis): PlayerAnalysis => ({ ...analysis, score: { ...analysis.score }, volumeRadar: { ...analysis.volumeRadar, axes: analysis.volumeRadar.axes.map((axis) => ({ ...axis })) }, ratioRadar: { ...analysis.ratioRadar, axes: analysis.ratioRadar.axes.map((axis) => ({ ...axis })) }, rawMetrics: { ...analysis.rawMetrics }, spatial: { ...analysis.spatial, laneRatios: [...analysis.spatial.laneRatios], depthRatios: [...analysis.spatial.depthRatios], positionalGrid: analysis.spatial.positionalGrid.map((cell) => ({ ...cell })) } });
