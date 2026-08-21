import { useId, useRef, useState } from "react";

import type { RatioBenchmarkState } from "./useRatioBenchmark";
import type { VolumeBenchmarkState } from "./useVolumeBenchmark";

type BenchmarkState = VolumeBenchmarkState | RatioBenchmarkState;
type ReadyBenchmark = Extract<BenchmarkState, { kind: "ready" }>["data"];
type Mode = "volume" | "ratio";

const panel = "min-w-0 overflow-hidden [overflow-wrap:anywhere] [&_button]:min-w-0 [&_button]:break-words rounded-xl border border-white/10 bg-[#101415] p-4";
const raw = (value: number | null) => value === null ? "unavailable" : String(value);

function Radar({ mode, data, playerName }: { mode: Mode; data: ReadyBenchmark; playerName: string }) {
  const prefix = `${mode}-${useId().replace(/:/g, "")}`;
  const axisCount = data.axes.length; const center = 70;
  const point = (value: number, index: number) => {
    const angle = -Math.PI / 2 + index * (Math.PI * 2 / axisCount); const radius = value * .55;
    return `${center + Math.cos(angle) * radius},${center + Math.sin(angle) * radius}`;
  };
  return <svg viewBox="0 0 140 140" className="mt-2 h-auto w-full" role="img" aria-labelledby={`${prefix}-title ${prefix}-desc`}>
    <title id={`${prefix}-title`}>{playerName} versus 8-league average {mode} benchmark</title>
    <desc id={`${prefix}-desc`}>Six-axis authoritative {mode} benchmark. Player is solid lime; average is dashed violet.</desc>
    <g className="fill-none stroke-zinc-600" strokeWidth=".5">{[0, 25, 50, 75, 100].map((value) => <polygon key={value} points={data.axes.map((_, index) => point(value, index)).join(" ")} />)}</g>
    <polygon id={`${prefix}-player`} data-series="player" data-benchmark-mode={mode} points={data.axes.map((axis, index) => point(axis.playerScore, index)).join(" ")} className="fill-lime-300/20 stroke-lime-300" />
    <polygon id={`${prefix}-average`} data-series="average" data-benchmark-mode={mode} points={data.axes.map((axis, index) => point(axis.averageScore, index)).join(" ")} className="fill-violet-300/15 stroke-violet-300" strokeDasharray="4 3" />
  </svg>;
}

export function BenchmarkPresentation({ state, mode, playerName, onRetry }: { state: BenchmarkState; mode: Mode; playerName: string; onRetry(): void }) {
  const [selected, setSelected] = useState(0); const ready = state.kind === "ready" ? state.data : undefined;
  return <>
    {state.kind === "loading" && <div aria-busy="true" className="mt-3 h-48 animate-pulse rounded bg-white/10 motion-reduce:animate-none">Loading authoritative {mode} benchmark</div>}
    {state.kind === "disabled" && <p className="mt-3 text-sm text-zinc-400">{mode === "volume" ? "8-league benchmark is not enabled." : "Ratio benchmark is not enabled."}</p>}
    {state.kind === "error" && <div role="alert" className="mt-3 text-sm text-amber-100">Benchmark could not be loaded.<button type="button" onClick={onRetry} className="ml-2 min-h-11 rounded border px-3 focus-visible:ring-2 focus-visible:ring-lime-300">Retry</button></div>}
    {state.kind === "unavailable" && <p className="mt-3 text-sm text-zinc-400">8-league average benchmark is unavailable for this context.</p>}
    {ready && <><Radar mode={mode} data={ready} playerName={playerName}/><p className="text-xs"><span className="text-lime-200">Player — solid</span> · <span className="text-violet-200">8-league avg — dashed</span></p><div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
      {ready.axes.map((axis, index) => <button key={axis.id} type="button" onClick={() => setSelected(index)} onKeyDown={(event) => {
        if (event.key === "ArrowRight" || event.key === "ArrowLeft") { event.preventDefault(); setSelected((index + (event.key === "ArrowRight" ? 1 : ready.axes.length - 1)) % ready.axes.length); }
      }} aria-pressed={selected === index} className="min-h-11 rounded border border-white/10 p-2 text-left text-xs focus-visible:ring-2 focus-visible:ring-lime-300">
        <b className="block break-words">{axis.label}</b><span className="block">Player {axis.playerScore}/100 · avg {axis.averageScore}/100</span><span className="block">Raw {raw(axis.playerRawValue)} · avg {raw(axis.averageRawValue)}</span><span className="block">#{axis.playerRank ?? "unavailable"}/{axis.population} · {axis.tier}{axis.imputed ? " · source-imputed (source-incomplete)" : ""}</span>
      </button>)}
    </div></>}
  </>;
}

/** Retained as the directly testable Volume presentation while the compact dual-mode panel uses the same renderer. */
export function VolumeBenchmarkRadar({ state, playerName, onRetry }: { state: VolumeBenchmarkState; playerName: string; onRetry(): void }) {
  return <section className={panel} aria-labelledby="volume-benchmark-heading"><h2 id="volume-benchmark-heading" className="text-sm font-black">Volume benchmark radar</h2><BenchmarkPresentation state={state} mode="volume" playerName={playerName} onRetry={onRetry}/></section>;
}

export function BenchmarkPanel({ volume, ratio, playerName, onVolumeRetry, onRatioRetry }: { volume: VolumeBenchmarkState; ratio: RatioBenchmarkState; playerName: string; onVolumeRetry(): void; onRatioRetry(): void }) {
  const [mode, setMode] = useState<Mode>("volume"); const selected = mode === "volume" ? volume : ratio; const idPrefix = `benchmark-${useId().replace(/:/g, "")}`; const tabs = useRef<Record<Mode, HTMLButtonElement | null>>({ volume: null, ratio: null });
  const tabId = (item: Mode) => `${idPrefix}-tab-${item}`; const panelId = (item: Mode) => `${idPrefix}-panel-${item}`;
  const activate = (item: Mode, focus = false) => { setMode(item); if (focus) tabs.current[item]?.focus(); };
  return <section className={panel} aria-label={`${mode === "volume" ? "Volume" : "Ratio"} benchmark radar`}><div className="flex flex-wrap items-center justify-between gap-2"><h2 className="text-sm font-black">Benchmark</h2><div role="tablist" aria-label="Benchmark mode" className="flex rounded border border-white/15">
    {(["volume", "ratio"] as const).map((item) => <button key={item} ref={(node) => { tabs.current[item] = node; }} id={tabId(item)} type="button" role="tab" tabIndex={mode === item ? 0 : -1} aria-selected={mode === item} aria-controls={panelId(item)} onClick={() => activate(item)} onKeyDown={(event) => {
      if (event.key === "ArrowRight" || event.key === "ArrowLeft") { event.preventDefault(); activate(item === "volume" ? "ratio" : "volume", true); }
    }} className={`min-h-11 px-3 text-xs font-bold capitalize focus-visible:ring-2 focus-visible:ring-lime-300 ${mode === item ? "bg-lime-300 text-zinc-950" : "text-zinc-200"}`}>{item}</button>)}
  </div></div><div id={panelId(mode)} role="tabpanel" aria-labelledby={tabId(mode)}><BenchmarkPresentation state={selected} mode={mode} playerName={playerName} onRetry={mode === "volume" ? onVolumeRetry : onRatioRetry}/></div></section>;
}
