import { datasetHref } from "../datasetRoute";
import type { DatasetRouteState, Player } from "../types";
import { AssetImage } from "./AssetImage";
import { duelPressCompareHref } from "../duelPressCompareUrl";

type Props = { players: readonly Player[]; dataset: DatasetRouteState; onRemove(playerId: number): void; onClear(): void };

export function CompareTray({ players, dataset, onRemove, onClear }: Props) {
  if (!players.length) return null;
  const compareHref = players.length === 2 ? duelPressCompareHref({ playerId: players[0].id, taxonomy: "legacy-v1", context: dataset.mode === "league" ? { season: dataset.season, mode: "league", scope: dataset.scope, competition: "all" } : { season: dataset.season, mode: "europe", scope: null, competition: dataset.competition } }, { playerId: players[1].id, taxonomy: "legacy-v1", context: dataset.mode === "league" ? { season: dataset.season, mode: "league", scope: dataset.scope, competition: "all" } : { season: dataset.season, mode: "europe", scope: null, competition: dataset.competition } }) : datasetHref("/compare", dataset);
  return <aside aria-label="Comparison selection" className="fixed inset-x-0 bottom-0 z-[60] border-t border-[#8cff68]/25 bg-[#090d0b]/95 shadow-[0_-16px_50px_rgba(0,0,0,.55)] backdrop-blur-xl">
    <div className="mx-auto max-w-[1580px] px-3 py-3 sm:px-6 lg:px-8"><div className="flex flex-col gap-3 sm:flex-row sm:items-center">
      <div className="min-w-0 flex-1"><div className="mb-2 flex items-center gap-2"><b className="text-base">Compare <span className="text-[#a7ff5b]">{players.length}/2</span></b><span className="type-caption text-zinc-500">{players.length < 2 ? "Select one more player to continue." : "Selections are ready for the comparison page."}</span></div>
        <div className="flex gap-2 overflow-x-auto pb-1">{players.map((player) => <div key={player.id} className="flex shrink-0 items-center gap-2 rounded-md border border-white/10 bg-white/[.04] p-1.5 pl-2"><AssetImage src={player.face} alt="" kind="face" fallbackLabel={player.name} width={32} height={32} className="h-8 w-8 rounded object-cover" /><span className="max-w-28 truncate type-caption font-bold">{player.name}</span><button type="button" onClick={() => onRemove(player.id)} aria-label={`Remove ${player.name} from comparison`} className="grid min-h-9 min-w-9 place-items-center rounded text-zinc-500 hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8cff68]">×</button></div>)}</div>
      </div>
      <div className="grid grid-cols-2 gap-2 sm:flex"><button type="button" onClick={onClear} className="min-h-11 rounded-md px-3 type-caption text-zinc-500 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8cff68]">Clear all</button>{players.length === 2 ? <a href={compareHref} className="inline-flex min-h-11 items-center justify-center rounded-md bg-[#8cff68] px-4 type-caption font-black text-[#0b160b] outline-none hover:bg-[#b1ff87] focus-visible:ring-2 focus-visible:ring-white">Open compare</a> : <span className="inline-flex min-h-11 items-center justify-center rounded-md bg-white/10 px-4 type-caption font-black text-zinc-500">Open compare</span>}</div>
    </div></div>
  </aside>;
}
