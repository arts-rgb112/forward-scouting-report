import { useMemo, useState } from "react";
import type { FinalThirdShot } from "../api/finalThirdShotMapContracts";
import type { FinalThirdRenderableData } from "../api/finalThirdShotMapV2Contracts";
import type { FinalThirdShotMapV3Data } from "../api/finalThirdShotMapV3Contracts";

type RenderableData = FinalThirdRenderableData | FinalThirdShotMapV3Data;
type ShotStatus = Exclude<FinalThirdShot["status"], "blocked">;
type VisibleStatus = "all" | ShotStatus;
const statuses = ["goal", "on_target", "off_target"] as const satisfies readonly ShotStatus[];
const statusStyle = { goal: { color: "#a3e635", text: "G", label: "Goal" }, on_target: { color: "#38bdf8", text: "T", label: "On target" }, off_target: { color: "#fbbf24", text: "X", label: "Off target" }, blocked: { color: "#f472b6", text: "B", label: "Blocked" } } as const;
const frame = { left: 160, right: 540, top: 100, bottom: 360 } as const;

function Shape({ shot, size, color }: { shot: FinalThirdShot; size: number; color: string }) {
  if (shot.status === "goal") return <path data-marker-shape="diamond" d={`M 0 ${-size} L ${size} 0 L 0 ${size} L ${-size} 0 Z`} fill={color} stroke="#111827" strokeWidth="2"/>;
  if (shot.status === "on_target") return <circle data-marker-shape="circle" r={size} fill={color} stroke="#111827" strokeWidth="2"/>;
  return <path data-marker-shape="cross" d={`M ${-size} ${-size} L ${size} ${size} M ${size} ${-size} L ${-size} ${size}`} fill="none" stroke={color} strokeWidth="3" strokeLinecap="round"/>;
}

function markerSize(shot: FinalThirdShot, data: RenderableData) {
  if (shot.xg === null) return 8;
  const range = data.markerSizeScale.max - data.markerSizeScale.min;
  const normalized = range > 0 ? Math.max(0, Math.min(1, (shot.xg - data.markerSizeScale.min) / range)) : 0;
  return 7 + normalized * 13;
}

function endpointPoint(shot: FinalThirdShot) {
  return { x: frame.left + (shot.goalMouthY ?? 0) * (frame.right - frame.left), y: frame.bottom - (shot.goalMouthZ ?? 0) * (frame.bottom - frame.top) };
}

function Marker({ shot, data }: { shot: FinalThirdShot; data: RenderableData }) {
  if (!shot.endpointAvailable || shot.goalMouthY === null || shot.goalMouthZ === null || shot.status === "blocked") return null;
  const style = statusStyle[shot.status], xgUnavailable = shot.xg === null, xgLabel = shot.xg === null ? "unavailable, size unavailable" : shot.xg.toFixed(2), size = markerSize(shot, data), point = endpointPoint(shot);
  return <g data-goal-mouth-shot={shot.shotId} data-xg-size={xgUnavailable ? "unavailable" : "observed"} data-marker-footprint={size} transform={`translate(${point.x} ${point.y})`} aria-label={`${style.label}; xG ${xgLabel}`}><title>{`${style.label}; xG ${xgLabel}`}</title><rect data-marker-footprint-box x={-size} y={-size} width={size * 2} height={size * 2} fill="none" stroke="none" pointerEvents="none"/><Shape shot={shot} size={size} color={xgUnavailable ? "#a1a1aa" : style.color}/>{xgUnavailable && <text data-size-unavailable y="4" textAnchor="middle" fill="#111827" fontSize="10" fontWeight="900">?</text>}<text y={size + 13} textAnchor="middle" fill="#f4f4f5" fontSize="10" fontWeight="800">{style.text}</text></g>;
}

function GoalNet() {
  return <g data-goal-net-3d aria-hidden="true">
    <path d="M 160 100 H 540 V 360 H 160 Z" fill="#0b1520" fillOpacity=".96" stroke="#e4e4e7" strokeWidth="7"/>
    <path d="M 190 78 H 510 V 338 H 190 Z" fill="none" stroke="#64748b" strokeOpacity=".8" strokeWidth="4"/>
    <path d="M 160 100 L 190 78 M 540 100 L 510 78 M 160 360 L 190 338 M 540 360 L 510 338" stroke="#94a3b8" strokeOpacity=".9" strokeWidth="4"/>
    <g stroke="#64748b" strokeOpacity=".42" strokeWidth="1.5">
      {Array.from({ length: 7 }, (_, index) => <path key={`front-v${index}`} d={`M ${160 + index * 63.33} 100 V 360`}/>)}
      {Array.from({ length: 5 }, (_, index) => <path key={`front-h${index}`} d={`M 160 ${100 + index * 65} H 540`}/>)}
      {Array.from({ length: 7 }, (_, index) => <path key={`back-v${index}`} d={`M ${190 + index * 53.33} 78 V 338`}/>)}
      {Array.from({ length: 5 }, (_, index) => <path key={`back-h${index}`} d={`M 190 ${78 + index * 65} H 510`}/>)}
      {Array.from({ length: 7 }, (_, index) => <path key={`top-v${index}`} d={`M ${160 + index * 63.33} 100 L ${190 + index * 53.33} 78`}/>)}
      {Array.from({ length: 7 }, (_, index) => <path key={`bottom-v${index}`} d={`M ${160 + index * 63.33} 360 L ${190 + index * 53.33} 338`}/>)}
      {Array.from({ length: 5 }, (_, index) => <path key={`left-h${index}`} d={`M 160 ${100 + index * 65} L 190 ${78 + index * 65}`}/>)}
      {Array.from({ length: 5 }, (_, index) => <path key={`right-h${index}`} d={`M 540 ${100 + index * 65} L 510 ${78 + index * 65}`}/>)}
    </g>
  </g>;
}

function qualitySummary(data: RenderableData) {
  if (!("shootingQuality" in data)) return null;
  const quality = data.shootingQuality;
  if (quality.state === "unavailable") return `Shooting quality unavailable: ${quality.reason ?? "source unavailable"}`;
  const delta = quality.xgotMinusXg === null ? "unavailable" : quality.xgotMinusXg.toFixed(2);
  const prefix = quality.state === "partial" ? "Shooting quality partial" : "Shooting quality";
  return `${prefix}: xGOT − xG ${delta} · ${quality.eligibleShotCount ?? "—"}/${quality.totalShotCount ?? "—"} eligible shots`;
}

export function GoalMouthView({ data }: { data: RenderableData }) {
  const [visibleStatus, setVisibleStatus] = useState<VisibleStatus>("all");
  const endpointShots = data.shots.filter((shot) => shot.endpointAvailable && shot.goalMouthY !== null && shot.goalMouthZ !== null && shot.status !== "blocked");
  const unplotted = data.shots.filter((shot) => !shot.endpointAvailable);
  const points = endpointShots.map(endpointPoint), padding = 52;
  const minX = Math.min(frame.left, ...points.map((point) => point.x)) - padding, maxX = Math.max(frame.right, ...points.map((point) => point.x)) + padding;
  const minY = Math.min(frame.top, ...points.map((point) => point.y)) - padding, maxY = Math.max(frame.bottom, ...points.map((point) => point.y)) + padding;
  const viewBox = `${minX} ${minY} ${maxX - minX} ${maxY - minY}`;
  const visibleShots = useMemo(() => visibleStatus === "all" ? endpointShots : endpointShots.filter((shot) => shot.status === visibleStatus), [endpointShots, visibleStatus]);
  const counts = { all: data.shots.length, goal: data.shots.filter((shot) => shot.status === "goal").length, on_target: data.shots.filter((shot) => shot.status === "on_target").length, off_target: data.shots.filter((shot) => shot.status === "off_target").length };
  const summary = qualitySummary(data);
  return <div className="min-w-0 overflow-hidden rounded-lg border border-white/10 bg-[#081018]"><div role="group" aria-label="Goal-Mouth shot visibility" className="flex flex-wrap items-center gap-2 border-b border-white/10 p-3">{(["all", ...statuses] as const).map((status) => <button key={status} type="button" aria-pressed={visibleStatus === status} onClick={() => setVisibleStatus(status)} className="min-h-10 rounded border border-white/20 px-3 text-xs font-bold aria-pressed:border-lime-300 aria-pressed:bg-lime-300 aria-pressed:text-zinc-950 focus-visible:ring-2 focus-visible:ring-lime-300">{status === "all" ? "All" : statusStyle[status].label} {counts[status]}</button>)}<span className="ml-auto text-xs text-zinc-400">Blocked {unplotted.length} · audit only</span></div><svg data-goal-mouth-viewbox={viewBox} viewBox={viewBox} className="block h-auto w-full" role="img" aria-label={`Three-dimensional goal-mouth plot with ${visibleShots.length} visible authoritative endpoints and ${unplotted.length} unplotted endpoints.`}><GoalNet/>{visibleShots.map((shot) => <Marker key={shot.shotId} shot={shot} data={data}/>)}</svg><div className="border-t border-white/10 px-3 py-2 text-xs text-zinc-300"><p>G goal · T on target · X off target. Marker size uses the shared source xG scale; gray ? means xG unavailable.</p>{summary && <p data-shooting-quality className="mt-1 text-cyan-100">{summary}</p>}{unplotted.length > 0 && <section aria-labelledby="unplotted-endpoints" className="mt-2"><h3 id="unplotted-endpoints" className="font-semibold">{unplotted.length} endpoint{unplotted.length === 1 ? "" : "s"} not plotted</h3><ul aria-label="Unplotted endpoint audit list" className="mt-1 max-h-32 space-y-1 overflow-y-auto pr-1">{unplotted.map((shot) => <li key={shot.shotId}><code>{shot.shotId}</code> — {shot.status}, {shot.endpointReason}</li>)}</ul></section>}</div></div>;
}
