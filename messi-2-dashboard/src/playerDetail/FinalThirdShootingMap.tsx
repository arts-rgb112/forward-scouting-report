import { useId, useRef, useState, type KeyboardEvent } from "react";
import type { FinalThirdRenderableData } from "../api/finalThirdShotMapV2Contracts";
import type { FinalThirdShotMapV3Data } from "../api/finalThirdShotMapV3Contracts";
import type { MessiApiConfig } from "../api/env";
import type { DatasetRouteState } from "../dashboard/types";
import { FinalThirdPitchView } from "./FinalThirdPitchView";
import { GoalMouthView } from "./GoalMouthView";
import { useFinalThirdShotMap } from "./useFinalThirdShotMap";

const panel = "min-w-0 rounded-xl border border-white/10 bg-[#101415] p-4 shadow-sm";
function ChartViews({ data, resourceKey, id, config }: { data: FinalThirdRenderableData | FinalThirdShotMapV3Data; resourceKey: string; id: string; config?: MessiApiConfig }) {
  const [view, setView] = useState<"pitch" | "goal-mouth">("pitch"), tabs = useRef<Array<HTMLButtonElement | null>>([]);
  const select = (next: "pitch" | "goal-mouth", focus = false) => { setView(next); if (focus) requestAnimationFrame(() => tabs.current[next === "pitch" ? 0 : 1]?.focus()); };
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => { const nextIndex = event.key === "ArrowLeft" ? (index + 1) % 2 : event.key === "ArrowRight" ? (index + 1) % 2 : event.key === "Home" ? 0 : event.key === "End" ? 1 : null; if (nextIndex === null) return; event.preventDefault(); select(nextIndex === 0 ? "pitch" : "goal-mouth", true); };
  return <><div role="tablist" aria-label="Final-third chart view" className="mt-3 flex flex-wrap gap-2">{(["pitch", "goal-mouth"] as const).map((item, index) => <button key={item} ref={(element) => { tabs.current[index] = element; }} id={`${item}-${id}`} role="tab" tabIndex={view === item ? 0 : -1} aria-selected={view === item} aria-controls={`panel-${id}`} type="button" onClick={() => select(item)} onKeyDown={(event) => onKeyDown(event, index)} className="min-h-11 rounded border border-white/20 px-4 text-sm font-bold aria-selected:bg-lime-300 aria-selected:text-zinc-950 focus-visible:ring-2 focus-visible:ring-lime-300">{item === "pitch" ? "Pitch" : "Goal-Mouth"}</button>)}</div><div id={`panel-${id}`} data-resource-key={resourceKey} role="tabpanel" aria-labelledby={`${view}-${id}`} className="mt-3">{view === "pitch" ? <FinalThirdPitchView data={data}/> : <GoalMouthView data={data} config={config}/>}</div></>;
}
export function FinalThirdShootingMap({ config, playerId, dataset }: { config?: MessiApiConfig; playerId: number; dataset: DatasetRouteState }) {
  const { state, resourceKey, retry } = useFinalThirdShotMap(config, playerId, dataset), id = useId().replace(/:/g, "");
  if (state.kind === "disabled" && state.key === resourceKey) return null;
  const current = state.key === resourceKey; const data = current && (state.kind === "ready" || state.kind === "partial" || state.kind === "observed-zero" || state.kind === "unavailable") ? state.data.data : undefined;
  const loading = !current || state.kind === "loading";
  return <section data-layout="final-third-shot-chart" className={`${panel} mt-4 w-full`} aria-labelledby={`final-third-${id}`}><div className="flex flex-wrap items-start justify-between gap-3"><div><h2 id={`final-third-${id}`} className="text-sm font-black">Final Third Shot Chart</h2><p className="mt-1 text-base text-zinc-400">Authoritative front-two-depth positional zones and goal-mouth endpoints only.</p></div>{data && <p role="status" aria-live="polite" className="text-base text-zinc-300">{state.kind === "partial" ? "Partial coverage" : state.kind === "observed-zero" ? "Observed zero attempts" : state.kind === "unavailable" ? "Unavailable" : "Ready"}</p>}</div>
    {loading && <div role="status" aria-live="polite" aria-busy="true" className="mt-3 h-64 animate-pulse rounded bg-white/10 motion-reduce:animate-none">Loading final-third shot chart…</div>}
    {current && state.kind === "error" && <p role="alert" className="mt-3 rounded border border-rose-300/40 bg-rose-300/10 p-3 text-sm text-rose-100">Final-third shot chart could not be loaded.<button type="button" onClick={retry} className="ml-2 min-h-11 rounded border border-rose-200/60 px-3 font-semibold focus-visible:ring-2 focus-visible:ring-lime-300">Retry</button></p>}
    {current && state.kind === "unavailable" && <p className="mt-3 rounded border border-amber-300/30 bg-amber-300/10 p-3 text-sm text-amber-100">Authoritative final-third shot data is unavailable for this context{data?.reason ? `: ${data.reason}` : "."}</p>}
    {data && state.kind !== "unavailable" && <><ChartViews key={resourceKey} data={data} resourceKey={resourceKey} id={id} config={config}/>{state.kind === "partial" && <p className="mt-3 text-base text-amber-100">Partial coverage: {data.partialCoverage.map((issue) => `${issue.zoneId ?? issue.shotId}: ${issue.reason}`).join("; ")}</p>}<p className="mt-3 text-base text-zinc-400">Context: {data.gridVersion}; {data.attackDirection.replaceAll("_", " ")}; depths {data.includedDepths.join(", ")}. No browser-derived shot, endpoint, quality, or fallback data is used.</p></>}
  </section>;
}
