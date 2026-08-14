import { datasetHref } from "../datasetRoute";
import type { DatasetRouteState, Player } from "../types";
import { AssetImage } from "./AssetImage";
import { enabledLegacyHref, legacyDetailHref } from "../../navigation/legacyHandoff";
import { leagueFallbackLabel } from "../leagueDisplay";

export function PlayerIdentity({ player, mobile = false, dataset }: { player: Player; mobile?: boolean; dataset?: DatasetRouteState }) {
  const size = mobile ? 56 : 48;
  const query = new URLSearchParams(window.location.search);
  const rawScope = Number(query.get("scope"));
  const current = dataset ?? { season: query.get("season") || "2025/2026", mode: query.get("mode") === "europe" ? "europe" as const : "league" as const, scope: ([3, 5, 7, 8].includes(rawScope) ? rawScope : 8) as DatasetRouteState["scope"], competition: "all" as const };
  const detailHref = enabledLegacyHref(legacyDetailHref(player.id, { name: player.name, clubName: player.club.name }, current) ?? "") ?? datasetHref(`/players/${player.id}`, current);
  return <div id={mobile ? undefined : `player-${player.id}`} className="flex min-w-0 items-center gap-3">
    <AssetImage src={player.face} alt={`${player.name} portrait`} kind="face" fallbackLabel={player.name} width={size} height={size} className={`${mobile ? "h-14 w-14" : "h-12 w-12"} rounded-md border border-white/10 object-cover`} />
    <div className="min-w-0"><a href={detailHref} className="block truncate text-[13px] font-extrabold hover:text-lime-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lime-300">{player.name}</a>
      {mobile && <p className="mt-0.5 truncate text-[10px] text-zinc-500">{player.club.name} · {player.league.name}</p>}
      <div className="mt-1 flex items-center gap-1.5">{player.nation && <AssetImage src={player.nation.icon} alt="" kind="nation" fallbackLabel={player.nation.name} width={20} height={16} className="h-4 w-5 rounded-sm object-cover" />}<AssetImage src={player.league.icon} alt="" kind="league" fallbackLabel={leagueFallbackLabel(player.league)} width={16} height={16} className="h-4 w-4 rounded-sm object-cover" /><AssetImage src={player.club.icon} alt="" kind="club" fallbackLabel={player.club.name} width={16} height={16} className="h-4 w-4 rounded-sm object-cover" /><span className="ml-1 rounded border border-white/10 px-1.5 py-0.5 font-mono text-[9px] text-zinc-400">{player.position}</span><span className="text-[9px] text-zinc-600">{player.archetype}</span></div>
    </div>
  </div>;
}
