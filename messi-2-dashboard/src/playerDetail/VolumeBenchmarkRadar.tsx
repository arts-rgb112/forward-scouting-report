import { useState } from "react";

import type { VolumeBenchmarkState } from "./useVolumeBenchmark";

const panel = "min-w-0 overflow-hidden [overflow-wrap:anywhere] [&_button]:min-w-0 [&_button]:break-words rounded-xl border border-white/10 bg-[#101415] p-4";

export function VolumeBenchmarkRadar({ state, playerName, onRetry }: { state: VolumeBenchmarkState; playerName: string; onRetry(): void }) {
  const [selected, setSelected] = useState(0);
  const ready = state.kind === "ready" ? state.data : undefined;
  const axisCount = ready?.axes.length ?? 6;
  const center = 70;
  const point = (value: number, index: number) => {
    const angle = -Math.PI / 2 + index * (Math.PI * 2 / axisCount);
    const radius = value * 0.55;
    return `${center + Math.cos(angle) * radius},${center + Math.sin(angle) * radius}`;
  };

  return <section className={panel} aria-labelledby="volume-benchmark-heading">
    <h2 id="volume-benchmark-heading" className="text-sm font-black">Volume benchmark radar</h2>
    {state.kind === "loading" && <div aria-busy="true" className="mt-3 h-48 animate-pulse rounded bg-white/10 motion-reduce:animate-none">Loading benchmark…</div>}
    {state.kind === "disabled" && <p className="mt-3 text-sm text-zinc-400">8-league benchmark is not enabled.</p>}
    {state.kind === "error" && <div role="alert" className="mt-3 text-sm text-amber-100">Benchmark could not be loaded.<button type="button" onClick={onRetry} className="ml-2 min-h-11 rounded border px-3 focus-visible:ring-2 focus-visible:ring-lime-300">Retry</button></div>}
    {state.kind === "unavailable" && <p className="mt-3 text-sm text-zinc-400">8-league average benchmark is unavailable for this context.</p>}
    {ready && <>
      <svg viewBox="0 0 140 140" className="mt-2 h-auto w-full" role="img" aria-labelledby="volume-radar-title volume-radar-desc">
        <title id="volume-radar-title">{playerName} versus 8-league average</title>
        <desc id="volume-radar-desc">Six-axis volume benchmark. Player is solid; average is dashed.</desc>
        <g className="fill-none stroke-zinc-600" strokeWidth=".5">{[0, 25, 50, 75, 100].map((value) => <polygon key={value} points={ready.axes.map((_, index) => point(value, index)).join(" ")} />)}</g>
        <polygon data-series="player" points={ready.axes.map((axis, index) => point(axis.playerScore, index)).join(" ")} className="fill-lime-300/20 stroke-lime-300" />
        <polygon data-series="average" points={ready.axes.map((axis, index) => point(axis.averageScore, index)).join(" ")} className="fill-violet-300/15 stroke-violet-300" strokeDasharray="4 3" />
      </svg>
      <p className="text-xs"><span className="text-lime-200">Player — solid</span> · <span className="text-violet-200">8-league avg — dashed</span></p>
      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
        {ready.axes.map((axis, index) => <button key={axis.id} type="button" onClick={() => setSelected(index)} onKeyDown={(event) => {
          if (event.key === "ArrowRight" || event.key === "ArrowLeft") setSelected((index + (event.key === "ArrowRight" ? 1 : axisCount - 1)) % axisCount);
        }} aria-pressed={selected === index} className="min-h-11 rounded border border-white/10 p-2 text-left text-xs focus-visible:ring-2 focus-visible:ring-lime-300">
          <b className="block break-words">{axis.label}</b>
          <span className="block">Player {axis.playerScore}/100 · avg {axis.averageScore}/100</span>
          <span className="block">Raw {axis.playerRawValue ?? "unavailable"} · avg {axis.averageRawValue ?? "unavailable"}</span>
          <span className="block">#{axis.playerRank}/{axis.population} · {axis.tier}{axis.imputed ? " · source-incomplete" : ""}</span>
        </button>)}
      </div>
    </>}
  </section>;
}
