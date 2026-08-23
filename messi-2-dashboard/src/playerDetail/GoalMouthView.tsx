import { useMemo, useState } from "react";
import type { FinalThirdShot } from "../api/finalThirdShotMapContracts";
import type { FinalThirdRenderableData } from "../api/finalThirdShotMapV2Contracts";
import type { FinalThirdShotMapV3Data } from "../api/finalThirdShotMapV3Contracts";

type RenderableData = FinalThirdRenderableData | FinalThirdShotMapV3Data;
type ShotStatus = Exclude<FinalThirdShot["status"], "blocked">;
type VisibleStatus = "all" | ShotStatus;
const statuses = ["goal", "on_target", "off_target"] as const satisfies readonly ShotStatus[];
const statusStyle = { goal: { color: "#a3e635", text: "G", label: "Goal" }, on_target: { color: "#38bdf8", text: "T", label: "On target" }, off_target: { color: "#fbbf24", text: "X", label: "Off target" }, blocked: { color: "#f472b6", text: "B", label: "Blocked" } } as const;
/** Project normalized provider coordinates onto a regulation 7.32m × 2.44m goal. */
const GOAL_WIDTH_METERS = 7.32;
const GOAL_HEIGHT_METERS = 2.44;
const SVG_UNITS_PER_METER = 100;
const GOAL_DEPTH_METERS = 2;
const frame = {
  left: 180,
  right: 180 + GOAL_WIDTH_METERS * SVG_UNITS_PER_METER,
  top: 220,
  bottom: 220 + GOAL_HEIGHT_METERS * SVG_UNITS_PER_METER,
} as const;
const rearFrame = {
  left: frame.left + GOAL_DEPTH_METERS * SVG_UNITS_PER_METER * 0.6,
  right: frame.right + GOAL_DEPTH_METERS * SVG_UNITS_PER_METER * 0.6,
  top: frame.top - GOAL_DEPTH_METERS * SVG_UNITS_PER_METER * 0.36,
  bottom: frame.bottom - GOAL_DEPTH_METERS * SVG_UNITS_PER_METER * 0.36,
} as const;
type ZoomLevel = 1 | 2 | 3;

function zoomedViewBox(base: { minX: number; minY: number; width: number; height: number }, zoom: ZoomLevel) {
  if (zoom === 1) return `${base.minX} ${base.minY} ${base.width} ${base.height}`;
  // Keep the real goal as the focal point while the fit-to-data view (1x)
  // remains the authoritative view that contains every source endpoint.
  const centerX = (frame.left + frame.right) / 2;
  const centerY = (frame.top + frame.bottom) / 2;
  const width = base.width / zoom;
  const height = base.height / zoom;
  return `${centerX - width / 2} ${centerY - height / 2} ${width} ${height}`;
}

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
  const frontWidth = frame.right - frame.left;
  const frontHeight = frame.bottom - frame.top;
  const rearWidth = rearFrame.right - rearFrame.left;
  const rearHeight = rearFrame.bottom - rearFrame.top;
  return <g data-goal-net-3d data-goal-frame-width-meters={GOAL_WIDTH_METERS} data-goal-frame-height-meters={GOAL_HEIGHT_METERS} data-goal-frame-aspect-ratio={GOAL_WIDTH_METERS / GOAL_HEIGHT_METERS} data-goal-depth-meters={GOAL_DEPTH_METERS} aria-hidden="true">
    <path d={`M ${frame.left} ${frame.top} H ${frame.right} V ${frame.bottom} H ${frame.left} Z`} fill="#0b1520" fillOpacity=".96" stroke="#e4e4e7" strokeWidth="7"/>
    <path d={`M ${rearFrame.left} ${rearFrame.top} H ${rearFrame.right} V ${rearFrame.bottom} H ${rearFrame.left} Z`} fill="none" stroke="#64748b" strokeOpacity=".8" strokeWidth="4"/>
    <path d={`M ${frame.left} ${frame.top} L ${rearFrame.left} ${rearFrame.top} M ${frame.right} ${frame.top} L ${rearFrame.right} ${rearFrame.top} M ${frame.left} ${frame.bottom} L ${rearFrame.left} ${rearFrame.bottom} M ${frame.right} ${frame.bottom} L ${rearFrame.right} ${rearFrame.bottom}`} stroke="#94a3b8" strokeOpacity=".9" strokeWidth="4"/>
    <g stroke="#64748b" strokeOpacity=".42" strokeWidth="1.5">
      {Array.from({ length: 7 }, (_, index) => <path key={`front-v${index}`} d={`M ${frame.left + index * (frontWidth / 6)} ${frame.top} V ${frame.bottom}`}/>)}
      {Array.from({ length: 5 }, (_, index) => <path key={`front-h${index}`} d={`M ${frame.left} ${frame.top + index * (frontHeight / 4)} H ${frame.right}`}/>)}
      {Array.from({ length: 7 }, (_, index) => <path key={`back-v${index}`} d={`M ${rearFrame.left + index * (rearWidth / 6)} ${rearFrame.top} V ${rearFrame.bottom}`}/>)}
      {Array.from({ length: 5 }, (_, index) => <path key={`back-h${index}`} d={`M ${rearFrame.left} ${rearFrame.top + index * (rearHeight / 4)} H ${rearFrame.right}`}/>)}
      {Array.from({ length: 7 }, (_, index) => <path key={`top-v${index}`} d={`M ${frame.left + index * (frontWidth / 6)} ${frame.top} L ${rearFrame.left + index * (rearWidth / 6)} ${rearFrame.top}`}/>)}
      {Array.from({ length: 7 }, (_, index) => <path key={`bottom-v${index}`} d={`M ${frame.left + index * (frontWidth / 6)} ${frame.bottom} L ${rearFrame.left + index * (rearWidth / 6)} ${rearFrame.bottom}`}/>)}
      {Array.from({ length: 5 }, (_, index) => <path key={`left-h${index}`} d={`M ${frame.left} ${frame.top + index * (frontHeight / 4)} L ${rearFrame.left} ${rearFrame.top + index * (rearHeight / 4)}`}/>)}
      {Array.from({ length: 5 }, (_, index) => <path key={`right-h${index}`} d={`M ${frame.right} ${frame.top + index * (frontHeight / 4)} L ${rearFrame.right} ${rearFrame.top + index * (rearHeight / 4)}`}/>)}
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
  const [zoom, setZoom] = useState<ZoomLevel>(1);
  const endpointShots = data.shots.filter((shot) => shot.endpointAvailable && shot.goalMouthY !== null && shot.goalMouthZ !== null && shot.status !== "blocked");
  const unplotted = data.shots.filter((shot) => !shot.endpointAvailable);
  const points = endpointShots.map(endpointPoint), padding = 52;
  const minX = Math.min(frame.left, ...points.map((point) => point.x)) - padding, maxX = Math.max(frame.right, ...points.map((point) => point.x)) + padding;
  const minY = Math.min(frame.top, ...points.map((point) => point.y)) - padding, maxY = Math.max(frame.bottom, ...points.map((point) => point.y)) + padding;
  const baseViewBox = { minX, minY, width: maxX - minX, height: maxY - minY };
  const viewBox = zoomedViewBox(baseViewBox, zoom);
  const visibleShots = useMemo(() => visibleStatus === "all" ? endpointShots : endpointShots.filter((shot) => shot.status === visibleStatus), [endpointShots, visibleStatus]);
  const counts = { all: data.shots.length, goal: data.shots.filter((shot) => shot.status === "goal").length, on_target: data.shots.filter((shot) => shot.status === "on_target").length, off_target: data.shots.filter((shot) => shot.status === "off_target").length };
  const summary = qualitySummary(data);
  return <div className="min-w-0 overflow-hidden rounded-lg border border-white/10 bg-[#081018]"><div className="flex flex-wrap items-center gap-2 border-b border-white/10 p-3"><div role="group" aria-label="Goal-Mouth shot visibility" className="flex flex-wrap items-center gap-2">{(["all", ...statuses] as const).map((status) => <button key={status} type="button" aria-pressed={visibleStatus === status} onClick={() => setVisibleStatus(status)} className="min-h-10 rounded border border-white/20 px-3 text-xs font-bold aria-pressed:border-lime-300 aria-pressed:bg-lime-300 aria-pressed:text-zinc-950 focus-visible:ring-2 focus-visible:ring-lime-300">{status === "all" ? "All" : statusStyle[status].label} {counts[status]}</button>)}</div><div role="group" aria-label="Goal-Mouth zoom controls" className="ml-auto flex items-center gap-1"><button type="button" aria-label="Zoom out" disabled={zoom === 1} onClick={() => setZoom((current) => (current - 1) as ZoomLevel)} className="min-h-10 min-w-10 rounded border border-white/20 px-2 text-sm font-bold disabled:cursor-not-allowed disabled:opacity-40 focus-visible:ring-2 focus-visible:ring-lime-300">−</button><button type="button" aria-label="Zoom in" disabled={zoom === 3} onClick={() => setZoom((current) => (current + 1) as ZoomLevel)} className="min-h-10 min-w-10 rounded border border-white/20 px-2 text-sm font-bold disabled:cursor-not-allowed disabled:opacity-40 focus-visible:ring-2 focus-visible:ring-lime-300">+</button><button type="button" aria-label="Reset zoom" disabled={zoom === 1} onClick={() => setZoom(1)} className="min-h-10 rounded border border-white/20 px-3 text-xs font-bold disabled:cursor-not-allowed disabled:opacity-40 focus-visible:ring-2 focus-visible:ring-lime-300">Reset</button><span aria-live="polite" data-goal-mouth-zoom className="ml-1 min-w-20 text-right text-xs text-zinc-400">Zoom {zoom}×</span></div><span className="w-full text-xs text-zinc-400 sm:w-auto sm:ml-2">Blocked {unplotted.length} · audit only</span></div><svg data-goal-mouth-viewbox={viewBox} viewBox={viewBox} className="block h-auto w-full" role="img" aria-label={`Three-dimensional goal-mouth plot with ${visibleShots.length} visible authoritative endpoints and ${unplotted.length} unplotted endpoints. Zoom ${zoom}x.`}><GoalNet/>{visibleShots.map((shot) => <Marker key={shot.shotId} shot={shot} data={data}/>)}</svg><div className="border-t border-white/10 px-3 py-2 text-xs text-zinc-300"><p>G goal · T on target · X off target. Marker size uses the shared source xG scale; gray ? means xG unavailable.</p>{summary && <p data-shooting-quality className="mt-1 text-cyan-100">{summary}</p>}{unplotted.length > 0 && <section aria-labelledby="unplotted-endpoints" className="mt-2"><h3 id="unplotted-endpoints" className="font-semibold">{unplotted.length} endpoint{unplotted.length === 1 ? "" : "s"} not plotted</h3><ul aria-label="Unplotted endpoint audit list" className="mt-1 max-h-32 space-y-1 overflow-y-auto pr-1">{unplotted.map((shot) => <li key={shot.shotId}><code>{shot.shotId}</code> — {shot.status}, {shot.endpointReason}</li>)}</ul></section>}</div></div>;
}
