import { datasetHref } from "../datasetRoute";
import type { AssetRef, DatasetRouteState, Player } from "../types";
import { AssetImage } from "./AssetImage";
import { legacyDetailHref, resolveLegacyOrInternalHref } from "../../navigation/legacyHandoff";
import { leagueFallbackLabel } from "../leagueDisplay";

export type PlayerIdentityData = Pick<Player, "id" | "name" | "position" | "archetype" | "face"> & { nation: AssetRef | null; league: AssetRef; club: AssetRef };
export type PartialPlayerIdentityData = {
  id: number; name: string; position?: string; archetype?: Player["archetype"]; face?: string | null;
  nation?: AssetRef | null; league?: AssetRef; club?: AssetRef; leagueName?: string; clubName?: string;
};
export type PlayerIdentityPresentation = { kind: "full"; player: PlayerIdentityData } | { kind: "partial"; player: PartialPlayerIdentityData };
type SharedIdentityProps = { mobile?: boolean; dataset?: DatasetRouteState; detailHref?: string; domId?: string | null };
type PlayerIdentityProps = SharedIdentityProps & ({ player: PlayerIdentityData; partial?: false } | { player: PartialPlayerIdentityData; partial: true });
function isPartialIdentity(player: PlayerIdentityData | PartialPlayerIdentityData, partial: boolean): player is PartialPlayerIdentityData { return partial; }

export function PlayerIdentity({ player, partial = false, mobile = false, dataset, detailHref: suppliedDetailHref, domId }: PlayerIdentityProps) {
  const size = mobile ? 56 : 48;
  const query = new URLSearchParams(window.location.search);
  const rawScope = Number(query.get("scope"));
  const current = dataset ?? { season: query.get("season") || "2025/2026", mode: query.get("mode") === "europe" ? "europe" as const : "league" as const, scope: ([3, 5, 7, 8].includes(rawScope) ? rawScope : 8) as DatasetRouteState["scope"], competition: "all" as const };
  const clubName = isPartialIdentity(player, partial) ? player.club?.name ?? player.clubName : player.club.name;
  const leagueName = isPartialIdentity(player, partial) ? player.league?.name ?? player.leagueName : player.league.name;
  const detailHref = suppliedDetailHref ?? resolveLegacyOrInternalHref(legacyDetailHref(player.id, { name: player.name, clubName: clubName ?? "" }, current), datasetHref(`/players/${player.id}`, current));
  const resolvedDomId = domId === undefined ? (mobile ? undefined : `player-${player.id}`) : domId ?? undefined;
  return <div id={resolvedDomId} className="flex min-w-0 items-center gap-3">
    {(!partial || player.face !== undefined) ? <AssetImage src={player.face ?? null} alt={`${player.name} portrait`} kind="face" fallbackLabel={player.name} width={size} height={size} className={`${mobile ? "h-14 w-14" : "h-12 w-12"} rounded-md border border-white/10 object-cover`} /> : <span aria-label={`${player.name} portrait unavailable`} className={`${mobile ? "h-14 w-14" : "h-12 w-12"} grid shrink-0 place-items-center rounded-md border border-white/10 text-zinc-600`}>—</span>}
    <div className="min-w-0"><a href={detailHref} className="block truncate text-[13px] font-extrabold hover:text-lime-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lime-300">{player.name}</a>
      {mobile && <p className="mt-0.5 truncate text-[10px] text-zinc-500">{clubName ?? "—"} · {leagueName ?? "—"}</p>}
      <div className="mt-1 flex items-center gap-1.5">{player.nation && <AssetImage src={player.nation.icon} alt="" kind="nation" fallbackLabel={player.nation.name} width={20} height={16} className="h-4 w-5 rounded-sm object-cover" />}{player.league && <AssetImage src={player.league.icon} alt="" kind="league" fallbackLabel={leagueFallbackLabel(player.league)} width={16} height={16} className="h-4 w-4 rounded-sm object-cover" />}{player.club && <AssetImage src={player.club.icon} alt="" kind="club" fallbackLabel={player.club.name} width={16} height={16} className="h-4 w-4 rounded-sm object-cover" />}{player.position ? <span className="ml-1 rounded border border-white/10 px-1.5 py-0.5 font-mono text-[9px] text-zinc-400">{player.position}</span> : <span aria-label="Position unavailable" className="ml-1 text-[9px] text-zinc-600">—</span>}{player.archetype && <span className="text-[9px] text-zinc-600">{player.archetype}</span>}</div>
    </div>
  </div>;
}
