import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent } from "react";
import type { FinalThirdShot } from "../api/finalThirdShotMapContracts";
import type { FinalThirdRenderableData } from "../api/finalThirdShotMapV2Contracts";
import type { FinalThirdShotMapV3Data } from "../api/finalThirdShotMapV3Contracts";

type RenderableData = FinalThirdRenderableData | FinalThirdShotMapV3Data;
type ShotStatus = Exclude<FinalThirdShot["status"], "blocked">;
type VisibleStatus = "all" | ShotStatus;
const statuses = ["goal", "on_target", "off_target"] as const satisfies readonly ShotStatus[];
const statusStyle = { goal: { color: "#22c55e", text: "G", label: "Goal" }, on_target: { color: "#38bdf8", text: "T", label: "On target" }, off_target: { color: "#fbbf24", text: "X", label: "Off target" }, blocked: { color: "#EAB308", text: "B", label: "Blocked" } } as const;
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
const vanishingPoint = { x: (frame.left + frame.right) / 2, y: frame.top - 142 } as const;
const REAR_PROJECTION = .82;
const projectTowardVanishingPoint = (point: { x: number; y: number }) => ({
  x: vanishingPoint.x + (point.x - vanishingPoint.x) * REAR_PROJECTION,
  y: vanishingPoint.y + (point.y - vanishingPoint.y) * REAR_PROJECTION,
});
/** Compact rear guide, derived by projecting each front-frame corner to one VP. */
const rearFrame = {
  left: projectTowardVanishingPoint({ x: frame.left, y: frame.top }).x,
  right: projectTowardVanishingPoint({ x: frame.right, y: frame.top }).x,
  top: projectTowardVanishingPoint({ x: frame.left, y: frame.top }).y,
  bottom: projectTowardVanishingPoint({ x: frame.left, y: frame.bottom }).y,
} as const;
/** Fixed 1× framing; source endpoints never enlarge the regulation goal. */
const compactBaseViewBox = {
  minX: frame.left - 140,
  minY: rearFrame.top - 96,
  width: (frame.right - frame.left) + 280,
  height: (frame.bottom - (rearFrame.top - 96)) + 135,
} as const;
const edgeMarkerBounds = {
  left: frame.left - 108,
  right: frame.right + 108,
  top: frame.top - 82,
  bottom: frame.bottom + 82,
} as const;
type ZoomLevel = 1 | 2 | 3;
type Viewport = { x: number; y: number };

const zoomViewport = (base: { width: number; height: number }, zoom: ZoomLevel) => ({ width: base.width / zoom, height: base.height / zoom });
const clampViewport = (viewport: Viewport, base: { width: number; height: number }, zoom: ZoomLevel): Viewport => {
  const visible = zoomViewport(base, zoom);
  return {
    x: Math.min(Math.max(0, base.width - visible.width), Math.max(0, viewport.x)),
    y: Math.min(Math.max(0, base.height - visible.height), Math.max(0, viewport.y)),
  };
};
const centeredViewport = (from: Viewport, base: { width: number; height: number }, fromZoom: ZoomLevel, toZoom: ZoomLevel): Viewport => {
  const previous = zoomViewport(base, fromZoom), next = zoomViewport(base, toZoom);
  return clampViewport({ x: from.x + previous.width / 2 - next.width / 2, y: from.y + previous.height / 2 - next.height / 2 }, base, toZoom);
};

function zoomedViewBox(base: { minX: number; minY: number; width: number; height: number }, zoom: ZoomLevel) {
  if (zoom === 1) return `${base.minX} ${base.minY} ${base.width} ${base.height}`;
  // Keep the real goal as the focal point; off-frame source endpoints use
  // explicit edge indicators instead of expanding the compact 1× viewport.
  const centerX = (frame.left + frame.right) / 2;
  const centerY = (frame.top + frame.bottom) / 2;
  const width = base.width / zoom;
  const height = base.height / zoom;
  return `${centerX - width / 2} ${centerY - height / 2} ${width} ${height}`;
}

function Shape({ shot, size, color }: { shot: FinalThirdShot; size: number; color: string }) {
  const faded = shot.status === "on_target";
  return <g data-marker-shape="football" data-shot-status={shot.status} opacity={faded ? .72 : 1}>
    <circle data-ball-color={color} r={size} fill={color} stroke="#111827" strokeWidth="2"/>
    <circle r={size * .76} fill="#f8fafc"/>
    <path d={`M 0 ${-size * .47} L ${size * .44} ${-size * .16} L ${size * .27} ${size * .37} H ${-size * .27} L ${-size * .44} ${-size * .16} Z`} fill="#111827" opacity=".94"/>
    {size >= 10 && <path d={`M ${-size * .72} ${-size * .22} L ${-size * .42} ${-size * .16} M ${size * .72} ${-size * .22} L ${size * .42} ${-size * .16} M ${-size * .53} ${size * .55} L ${-size * .27} ${size * .37} M ${size * .53} ${size * .55} L ${size * .27} ${size * .37}`} fill="none" stroke="#111827" strokeWidth={Math.max(1.2, size * .12)} strokeLinecap="round"/>}
    {shot.status === "off_target" && <path data-off-target-x d={`M ${-size * .63} ${-size * .63} L ${size * .63} ${size * .63} M ${size * .63} ${-size * .63} L ${-size * .63} ${size * .63}`} fill="none" stroke="#0f172a" strokeWidth={Math.max(2, size * .2)} strokeLinecap="round"/>}
  </g>;
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

function offFrameDescription(shot: FinalThirdShot) {
  const y = shot.goalMouthY!, z = shot.goalMouthZ!;
  const labels: string[] = [];
  if (y < 0) labels.push(`왼쪽 포스트 밖 ${(Math.abs(y) * GOAL_WIDTH_METERS).toFixed(1)}m`);
  if (y > 1) labels.push(`오른쪽 포스트 밖 ${((y - 1) * GOAL_WIDTH_METERS).toFixed(1)}m`);
  if (z > 1) labels.push(`크로스바 위 ${((z - 1) * GOAL_HEIGHT_METERS).toFixed(1)}m`);
  if (z < 0) labels.push(`골대 아래 ${(Math.abs(z) * GOAL_HEIGHT_METERS).toFixed(1)}m`);
  return labels;
}

function isOffFrame(shot: FinalThirdShot) {
  return shot.goalMouthY! < 0 || shot.goalMouthY! > 1 || shot.goalMouthZ! < 0 || shot.goalMouthZ! > 1;
}

function proportionalMarginOffset(distance: number, maximumDistance: number, margin: number) {
  if (distance <= 0) return 0;
  const progress = Math.log1p(distance) / Math.log1p(Math.max(distance, maximumDistance));
  return 14 + progress * Math.max(0, margin - 14);
}

function compressedEdgePoint(shot: FinalThirdShot, endpointShots: FinalThirdShot[], fanOffset: number) {
  const y = shot.goalMouthY!, z = shot.goalMouthZ!;
  const maximum = (axis: "left" | "right" | "top" | "bottom") => Math.max(0.0001, ...endpointShots.map((candidate) => {
    const candidateY = candidate.goalMouthY!, candidateZ = candidate.goalMouthZ!;
    if (axis === "left") return Math.max(0, -candidateY);
    if (axis === "right") return Math.max(0, candidateY - 1);
    if (axis === "top") return Math.max(0, candidateZ - 1);
    return Math.max(0, -candidateZ);
  }));
  const horizontalMargin = frame.left - edgeMarkerBounds.left;
  const verticalMargin = frame.top - edgeMarkerBounds.top;
  const x = y < 0
    ? frame.left - proportionalMarginOffset(-y, maximum("left"), horizontalMargin)
    : y > 1 ? frame.right + proportionalMarginOffset(y - 1, maximum("right"), horizontalMargin)
      : frame.left + y * (frame.right - frame.left);
  const yPosition = z > 1
    ? frame.top - proportionalMarginOffset(z - 1, maximum("top"), verticalMargin)
    : z < 0 ? frame.bottom + proportionalMarginOffset(-z, maximum("bottom"), edgeMarkerBounds.bottom - frame.bottom)
      : frame.bottom - z * (frame.bottom - frame.top);
  // A fan is used only for exact duplicate source coordinates; all other
  // locations retain their order through the proportional mapping above.
  const fanned = fanOffset * 11;
  return { x: x + (z < 0 || z > 1 ? fanned : 0), y: yPosition + (y < 0 || y > 1 ? fanned : 0) };
}

function EdgeMarker({ shot, data, endpointShots, fanOffset, fanCount, active, onActivate, onDeactivate }: { shot: FinalThirdShot; data: RenderableData; endpointShots: FinalThirdShot[]; fanOffset: number; fanCount: number; active: boolean; onActivate: () => void; onDeactivate: () => void }) {
  const point = compressedEdgePoint(shot, endpointShots, fanOffset);
  const description = offFrameDescription(shot).join(" · ");
  const rawCoordinates = `원본 좌표 Y ${shot.goalMouthY}, Z ${shot.goalMouthZ}`;
  const style = statusStyle[shot.status], size = Math.max(5, markerSize(shot, data) * .7), xgUnavailable = shot.xg === null;
  return <g data-goal-mouth-shot={shot.shotId} data-goal-mouth-off-frame-shot={shot.shotId} data-xg-size={xgUnavailable ? "unavailable" : "observed"} data-marker-footprint={size} transform={`translate(${point.x} ${point.y})`} tabIndex={0} role="img" aria-label={`${style.label}, ${description}. ${rawCoordinates}`} onMouseEnter={onActivate} onMouseLeave={onDeactivate} onFocus={onActivate} onBlur={onDeactivate}>
    <title>{`${description}. ${rawCoordinates}`}</title>
    <Shape shot={shot} size={size} color={xgUnavailable ? "#a1a1aa" : style.color}/>
    {fanCount > 1 && <g data-off-frame-duplicate-count><circle cx={size * .72} cy={-size * .72} r="8" fill="#111827" stroke="#fbbf24" strokeWidth="1.5"/><text x={size * .72} y={-size * .72 + 3.5} textAnchor="middle" fill="#fde68a" fontSize="8" fontWeight="900">×{fanCount}</text></g>}
    {active && <g data-off-frame-tooltip transform={`translate(${size + 12} ${-size - 12})`} pointerEvents="none"><rect x="0" y="0" width="242" height="44" rx="6" fill="#111827" stroke="#fbbf24"/><text x="9" y="17" fill="#fde68a" fontSize="11" fontWeight="800">{description}</text><text x="9" y="34" fill="#cbd5e1" fontSize="10">{rawCoordinates}</text></g>}
  </g>;
}

function Marker({ shot, data, endpointShots, fanOffset, fanCount, active, onActivate, onDeactivate }: { shot: FinalThirdShot; data: RenderableData; endpointShots: FinalThirdShot[]; fanOffset: number; fanCount: number; active: boolean; onActivate: () => void; onDeactivate: () => void }) {
  if (!shot.endpointAvailable || shot.goalMouthY === null || shot.goalMouthZ === null || shot.status === "blocked") return null;
  if (isOffFrame(shot)) return <EdgeMarker shot={shot} data={data} endpointShots={endpointShots} fanOffset={fanOffset} fanCount={fanCount} active={active} onActivate={onActivate} onDeactivate={onDeactivate}/>;
  const style = statusStyle[shot.status], xgUnavailable = shot.xg === null, xgLabel = shot.xg === null ? "unavailable, size unavailable" : shot.xg.toFixed(2), size = markerSize(shot, data), point = endpointPoint(shot);
  return <g data-goal-mouth-shot={shot.shotId} data-xg-size={xgUnavailable ? "unavailable" : "observed"} data-marker-footprint={size} transform={`translate(${point.x} ${point.y})`} aria-label={`${style.label}; xG ${xgLabel}`}><title>{`${style.label}; xG ${xgLabel}`}</title><rect data-marker-footprint-box x={-size} y={-size} width={size * 2} height={size * 2} fill="none" stroke="none" pointerEvents="none"/><Shape shot={shot} size={size} color={xgUnavailable ? "#a1a1aa" : style.color}/>{xgUnavailable && <text data-size-unavailable y="4" textAnchor="middle" fill="#111827" fontSize="10" fontWeight="900">?</text>}<text y={size + 13} textAnchor="middle" fill="#f4f4f5" fontSize="10" fontWeight="800">{style.text}</text></g>;
}

function GoalNet() {
  const frontWidth = frame.right - frame.left;
  const frontHeight = frame.bottom - frame.top;
  return <g data-goal-net-3d data-goal-net-vanishing-point={`${vanishingPoint.x} ${vanishingPoint.y}`} data-goal-frame-width-meters={GOAL_WIDTH_METERS} data-goal-frame-height-meters={GOAL_HEIGHT_METERS} data-goal-frame-aspect-ratio={GOAL_WIDTH_METERS / GOAL_HEIGHT_METERS} data-goal-depth-meters={GOAL_DEPTH_METERS} aria-hidden="true">
    <defs><linearGradient id="goal-pipe" x1="0" y1="0" x2="0" y2="1"><stop stopColor="#ffffff"/><stop offset=".25" stopColor="#f8fafc"/><stop offset=".5" stopColor="#cbd5e1"/><stop offset=".75" stopColor="#64748b"/><stop offset="1" stopColor="#1e293b"/></linearGradient><filter id="goal-shadow"><feGaussianBlur stdDeviation="10"/></filter></defs>
    <ellipse cx={(frame.left + frame.right) / 2} cy={frame.bottom + 18} rx={frontWidth * .46} ry="18" fill="#020617" opacity=".76" filter="url(#goal-shadow)"/>
    {/* low-contrast rear frame is deliberately secondary to the front regulation opening */}
    <path d={`M ${frame.left} ${frame.top} L ${rearFrame.left} ${rearFrame.top} L ${rearFrame.left} ${rearFrame.bottom} L ${frame.left} ${frame.bottom} Z`} fill="#0f1d2c" fillOpacity=".46"/>
    <path d={`M ${frame.right} ${frame.top} L ${rearFrame.right} ${rearFrame.top} L ${rearFrame.right} ${rearFrame.bottom} L ${frame.right} ${frame.bottom} Z`} fill="#0f1d2c" fillOpacity=".46"/>
    <path d={`M ${rearFrame.left} ${rearFrame.top} H ${rearFrame.right} V ${rearFrame.bottom} H ${rearFrame.left} Z`} fill="#0f1d2c" fillOpacity=".42" stroke="#475569" strokeOpacity=".46" strokeWidth="2.5"/>
    <path d={`M ${frame.left} ${frame.top} L ${rearFrame.left} ${rearFrame.top} M ${frame.right} ${frame.top} L ${rearFrame.right} ${rearFrame.top} M ${frame.left} ${frame.bottom} L ${rearFrame.left} ${rearFrame.bottom} M ${frame.right} ${frame.bottom} L ${rearFrame.right} ${rearFrame.bottom}`} stroke="#475569" strokeOpacity=".46" strokeWidth="2.5"/>
    <g data-goal-net-mesh stroke="#64748b" strokeOpacity=".72" strokeWidth="1.65" fill="none">
      {Array.from({ length: 9 }, (_, index) => { const ratio = index / 8, frontX = frame.left + ratio * frontWidth, rearTop = projectTowardVanishingPoint({ x: frontX, y: frame.top }), rearBottom = projectTowardVanishingPoint({ x: frontX, y: frame.bottom }); return <path key={`mesh-v${index}`} d={`M ${frontX} ${frame.top} Q ${frontX + (vanishingPoint.x - frontX) * .34} ${(frame.top + rearTop.y) / 2} ${rearTop.x} ${rearTop.y} M ${frontX} ${frame.bottom} Q ${frontX + (vanishingPoint.x - frontX) * .38} ${frame.bottom + 10 + ratio * 8} ${rearBottom.x} ${rearBottom.y}`}/>; })}
      {Array.from({ length: 8 }, (_, index) => { const ratio = index / 7, frontY = frame.top + ratio * frontHeight, rearLeft = projectTowardVanishingPoint({ x: frame.left, y: frontY }), rearRight = projectTowardVanishingPoint({ x: frame.right, y: frontY }), sag = 2 + ratio * ratio * 15; return <path key={`mesh-h${index}`} d={`M ${frame.left} ${frontY} Q ${(frame.left + frame.right) / 2} ${frontY + sag} ${frame.right} ${frontY} M ${rearLeft.x} ${rearLeft.y} Q ${(rearLeft.x + rearRight.x) / 2} ${rearLeft.y + sag * .45} ${rearRight.x} ${rearRight.y}`}/>; })}
      {Array.from({ length: 8 }, (_, index) => { const ratio = index / 7, frontY = frame.top + ratio * frontHeight, rearLeft = projectTowardVanishingPoint({ x: frame.left, y: frontY }), rearRight = projectTowardVanishingPoint({ x: frame.right, y: frontY }), sag = 3 + ratio * ratio * 18; return <path key={`mesh-side-${index}`} d={`M ${frame.left} ${frontY} Q ${rearLeft.x - 8} ${frontY + sag} ${rearLeft.x} ${rearLeft.y} M ${frame.right} ${frontY} Q ${rearRight.x + 8} ${frontY + sag} ${rearRight.x} ${rearRight.y}`}/>; })}
    </g>
    {/* layered stroke creates a pipe with bright highlight and shaded underside */}
    <path d={`M ${frame.left} ${frame.top} H ${frame.right} V ${frame.bottom} H ${frame.left} Z`} fill="#0b1520" fillOpacity=".74" stroke="#020617" strokeWidth="19" strokeLinejoin="round"/>
    <path d={`M ${frame.left} ${frame.top} H ${frame.right} V ${frame.bottom} H ${frame.left} Z`} fill="none" stroke="url(#goal-pipe)" strokeWidth="13" strokeLinejoin="round"/>
    <path d={`M ${frame.left + 6} ${frame.top + 5} H ${frame.right - 6} M ${frame.left + 5} ${frame.top + 6} V ${frame.bottom - 8}`} fill="none" stroke="#ffffff" strokeOpacity=".94" strokeWidth="2.5" strokeLinecap="round"/>
    <path d={`M ${frame.left + 5} ${frame.bottom} H ${frame.right - 5}`} fill="none" stroke="#0f172a" strokeWidth="3.5"/>
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
  const [viewport, setViewport] = useState<Viewport>({ x: 0, y: 0 });
  const [activeOffFrameShotId, setActiveOffFrameShotId] = useState<string | null>(null);
  const pointerPan = useRef<{ pointerId: number; clientX: number; clientY: number; viewport: Viewport } | null>(null);
  const endpointShots = data.shots.filter((shot) => shot.endpointAvailable && shot.goalMouthY !== null && shot.goalMouthZ !== null && shot.status !== "blocked");
  const unplotted = data.shots.filter((shot) => !shot.endpointAvailable);
  // Never fit the viewport to provider endpoint coordinates: valid far-wide
  // misses must not shrink the measured goal opening at 1×.
  const baseViewBox = compactBaseViewBox;
  const visibleViewport = zoomViewport(baseViewBox, zoom);
  const safeViewport = clampViewport(viewport, baseViewBox, zoom);
  const viewBox = zoom === 1
    ? zoomedViewBox(baseViewBox, zoom)
    : `${baseViewBox.minX + safeViewport.x} ${baseViewBox.minY + safeViewport.y} ${visibleViewport.width} ${visibleViewport.height}`;
  const visibleShots = useMemo(() => visibleStatus === "all" ? endpointShots : endpointShots.filter((shot) => shot.status === visibleStatus), [endpointShots, visibleStatus]);
  const offFrameGroups = useMemo(() => {
    const groups = new Map<string, FinalThirdShot[]>();
    endpointShots.filter(isOffFrame).forEach((shot) => {
      const key = `${shot.goalMouthY}:${shot.goalMouthZ}`;
      groups.set(key, [...(groups.get(key) ?? []), shot]);
    });
    return groups;
  }, [endpointShots]);
  const counts = { all: data.shots.length, goal: data.shots.filter((shot) => shot.status === "goal").length, on_target: data.shots.filter((shot) => shot.status === "on_target").length, off_target: data.shots.filter((shot) => shot.status === "off_target").length };
  const summary = qualitySummary(data);
  useEffect(() => { setViewport({ x: 0, y: 0 }); setZoom(1); setActiveOffFrameShotId(null); pointerPan.current = null; }, [data]);
  const setZoomLevel = (next: ZoomLevel) => { setViewport((current) => centeredViewport(current, baseViewBox, zoom, next)); setZoom(next); };
  const resetViewport = () => { pointerPan.current = null; setZoom(1); setViewport({ x: 0, y: 0 }); };
  const panBy = (x: number, y: number) => setViewport((current) => clampViewport({ x: current.x + x, y: current.y + y }, baseViewBox, zoom));
  const onPointerDown = (event: PointerEvent<SVGSVGElement>) => {
    if (zoom === 1 || event.defaultPrevented) return;
    pointerPan.current = { pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY, viewport: safeViewport };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };
  const onPointerMove = (event: PointerEvent<SVGSVGElement>) => {
    const start = pointerPan.current;
    if (!start || start.pointerId !== event.pointerId) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return;
    setViewport(clampViewport({
      x: start.viewport.x - (event.clientX - start.clientX) * visibleViewport.width / bounds.width,
      y: start.viewport.y - (event.clientY - start.clientY) * visibleViewport.height / bounds.height,
    }, baseViewBox, zoom));
  };
  const endPointerPan = (event: PointerEvent<SVGSVGElement>) => {
    if (pointerPan.current?.pointerId !== event.pointerId) return;
    pointerPan.current = null;
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture?.(event.pointerId);
  };
  const onKeyDown = (event: KeyboardEvent<SVGSVGElement>) => {
    if (event.key === "Escape") { event.preventDefault(); resetViewport(); return; }
    if (zoom === 1) return;
    const step = Math.min(48, visibleViewport.width / 5);
    if (event.key === "ArrowLeft") { event.preventDefault(); panBy(-step, 0); }
    else if (event.key === "ArrowRight") { event.preventDefault(); panBy(step, 0); }
    else if (event.key === "ArrowUp") { event.preventDefault(); panBy(0, -step); }
    else if (event.key === "ArrowDown") { event.preventDefault(); panBy(0, step); }
  };
  return <div className="min-w-0 overflow-hidden rounded-lg border border-white/10 bg-[#081018]"><div className="flex flex-wrap items-center gap-2 border-b border-white/10 p-3"><div role="group" aria-label="Goal-Mouth shot visibility" className="flex flex-wrap items-center gap-2">{(["all", ...statuses] as const).map((status) => <button key={status} type="button" aria-pressed={visibleStatus === status} onClick={() => setVisibleStatus(status)} className="min-h-10 rounded border border-white/20 px-3 text-xs font-bold aria-pressed:border-lime-300 aria-pressed:bg-lime-300 aria-pressed:text-zinc-950 focus-visible:ring-2 focus-visible:ring-lime-300">{status === "all" ? "All" : statusStyle[status].label} {counts[status]}</button>)}</div><div role="group" aria-label="Goal-Mouth zoom controls" className="ml-auto flex items-center gap-1"><button type="button" aria-label="Zoom out" disabled={zoom === 1} onClick={() => setZoomLevel((zoom - 1) as ZoomLevel)} className="min-h-10 min-w-10 rounded border border-white/20 px-2 text-sm font-bold disabled:cursor-not-allowed disabled:opacity-40 focus-visible:ring-2 focus-visible:ring-lime-300">−</button><button type="button" aria-label="Zoom in" disabled={zoom === 3} onClick={() => setZoomLevel((zoom + 1) as ZoomLevel)} className="min-h-10 min-w-10 rounded border border-white/20 px-2 text-sm font-bold disabled:cursor-not-allowed disabled:opacity-40 focus-visible:ring-2 focus-visible:ring-lime-300">+</button><button type="button" aria-label="Reset zoom and pan" disabled={zoom === 1 && safeViewport.x === 0 && safeViewport.y === 0} onClick={resetViewport} className="min-h-10 rounded border border-white/20 px-3 text-xs font-bold disabled:cursor-not-allowed disabled:opacity-40 focus-visible:ring-2 focus-visible:ring-lime-300">Reset</button><span aria-live="polite" data-goal-mouth-zoom className="ml-1 min-w-20 text-right text-xs text-zinc-400">Zoom {zoom}×</span></div><span className="w-full text-xs text-zinc-400 sm:w-auto sm:ml-2">Blocked {unplotted.length} · audit only</span></div><svg data-goal-mouth-viewbox={viewBox} viewBox={viewBox} className="block h-auto w-full touch-none cursor-grab active:cursor-grabbing" role="img" tabIndex={0} aria-label={`Three-dimensional goal-mouth plot with ${visibleShots.length} visible authoritative endpoints and ${unplotted.length} unplotted endpoints. Zoom ${zoom}x. Drag to pan when zoomed.`} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={endPointerPan} onPointerCancel={endPointerPan} onLostPointerCapture={() => { pointerPan.current = null; }} onKeyDown={onKeyDown}><GoalNet/>{visibleShots.map((shot) => { const group = offFrameGroups.get(`${shot.goalMouthY}:${shot.goalMouthZ}`) ?? [shot]; const groupIndex = group.findIndex((candidate) => candidate.shotId === shot.shotId); return <Marker key={shot.shotId} shot={shot} data={data} endpointShots={endpointShots} fanOffset={group.length > 1 ? groupIndex - (group.length - 1) / 2 : 0} fanCount={group.length} active={activeOffFrameShotId === shot.shotId} onActivate={() => setActiveOffFrameShotId(shot.shotId)} onDeactivate={() => setActiveOffFrameShotId((current) => current === shot.shotId ? null : current)}/>; })}</svg><div className="border-t border-white/10 px-3 py-2 text-xs text-zinc-300"><p>축구공: Goal 초록 · On target 하늘색 · Off target 호박색 + X. Marker size uses the shared source xG scale; gray ? means xG unavailable.</p>{summary && <p data-shooting-quality className="mt-1 text-cyan-100">{summary}</p>}{unplotted.length > 0 && <section aria-labelledby="unplotted-endpoints" className="mt-2"><h3 id="unplotted-endpoints" className="font-semibold">{unplotted.length} endpoint{unplotted.length === 1 ? "" : "s"} not plotted</h3><ul aria-label="Unplotted endpoint audit list" className="mt-1 max-h-32 space-y-1 overflow-y-auto pr-1">{unplotted.map((shot) => <li key={shot.shotId}><code>{shot.shotId}</code> — {shot.status}, {shot.endpointReason}</li>)}</ul></section>}</div></div>;
}
