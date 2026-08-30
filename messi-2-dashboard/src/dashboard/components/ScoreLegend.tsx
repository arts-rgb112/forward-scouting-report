import { scoreBands } from "../scoutingConfig";

export function ScoreLegend() {
  return <aside aria-label="Ability score legend" className="mb-3 flex flex-wrap items-center gap-3 rounded-lg border border-white/10 bg-[#0d1112] px-3 py-2 type-caption text-zinc-500"><b className="text-zinc-300">Ability score</b>{scoreBands.map((band) => <span key={band.min} aria-label={`Ability score range ${band.label}`}><i aria-hidden="true" className={`mr-1 inline-block h-2 w-2 rounded-full ${band.dotClassName}`} />{band.rangeLabel}</span>)}</aside>;
}
