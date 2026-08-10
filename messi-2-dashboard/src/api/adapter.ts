import type { PlayerDto, PlayersEnvelope } from "./contracts";
import type { Player, PlayersPayload } from "../dashboard/types";
export const adaptPlayer = (dto: PlayerDto): Player => ({
  id: dto.id, rank: dto.rank, name: dto.name, position: dto.position, archetype: dto.archetype, age: dto.age,
  minutes: dto.minutes, tier: { ...dto.tier }, score: dto.score, face: dto.face,
  nation: dto.nation ? { ...dto.nation } : null, league: { ...dto.league }, club: { ...dto.club }, stats: { ...dto.stats },
});
export const adaptEnvelope = (envelope: PlayersEnvelope): PlayersPayload => ({ players: envelope.data.map(adaptPlayer), meta: { ...envelope.meta } });
