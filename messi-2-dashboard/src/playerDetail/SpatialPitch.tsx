import { useEffect, useId, useMemo, useRef, useState } from "react";

import type { PlayerAnalysis, ShotmapPoint } from "../dashboard/types";
import { LegacyShotShape, LegacySpatialPitchFigure } from "./LegacySpatialPitch";
import { HEATMAP_COLUMNS, HEATMAP_OPACITY, HEATMAP_ROWS, legacyDensityGrid, legacyHeatmapColor, marchingSquares, normalizeDensity } from "./legacyHeatmap";
import { formatShotMetric, outcomeOrder, outcomePresentation, outcomeSummary, OutcomeControls, shotIntegrity, shotMarkerLabel, type ShotOutcome, useShotOutcomeVisibility } from "./shotOutcomeVisibility";

const panel = "min-w-0 rounded-xl border border-white/10 bg-[#101415] p-4 shadow-sm";

export const POSITIONAL_DEPTH_BOUNDARIES = [0, 16.67, 33.33, 50, 66.67, 83.33, 100] as const;
export const POSITIONAL_LANE_BOUNDARIES = [0, 21.82, 37, 63, 78.18, 100] as const;
export const PITCH_WIDTH_METERS = 68;
export const GOAL_WIDTH_METERS = 7.32;
export const GOAL_CROSSBAR_HEIGHT_METERS = 2.44;
export const SIX_YARD_BOX_EXTENSION_METERS = 5.5;
export const GOAL_POST_Y = [
  ((PITCH_WIDTH_METERS / 2 - GOAL_WIDTH_METERS / 2) / PITCH_WIDTH_METERS) * 100,
  ((PITCH_WIDTH_METERS / 2 + GOAL_WIDTH_METERS / 2) / PITCH_WIDTH_METERS) * 100,
] as const;
export const SIX_YARD_BOX_Y = [
  ((PITCH_WIDTH_METERS / 2 - GOAL_WIDTH_METERS / 2 - SIX_YARD_BOX_EXTENSION_METERS) / PITCH_WIDTH_METERS) * 100,
  ((PITCH_WIDTH_METERS / 2 + GOAL_WIDTH_METERS / 2 + SIX_YARD_BOX_EXTENSION_METERS) / PITCH_WIDTH_METERS) * 100,
] as const;
/** The attacking goal's viewBox lift; trajectory heights are tied directly to it. */
export const ATTACKING_GOAL_FRAME_LIFT = 20;

/** Visual segments traced from the legacy positional-grid-pitch asset. */
export const LEGACY_POSITIONAL_SEGMENTS = [
  { axis: "depth", boundary: 0, start: { x: 0, y: 0 }, end: { x: 0, y: 100 } },
  { axis: "depth", boundary: 16.67, start: { x: 16.67, y: 0 }, end: { x: 16.67, y: 100 } },
  { axis: "depth", boundary: 33.33, start: { x: 33.33, y: 0 }, end: { x: 33.33, y: 21.82 } },
  { axis: "depth", boundary: 33.33, start: { x: 33.33, y: 78.18 }, end: { x: 33.33, y: 100 } },
  { axis: "depth", boundary: 50, start: { x: 50, y: 0 }, end: { x: 50, y: 100 } },
  { axis: "depth", boundary: 66.67, start: { x: 66.67, y: 0 }, end: { x: 66.67, y: 21.82 } },
  { axis: "depth", boundary: 66.67, start: { x: 66.67, y: 78.18 }, end: { x: 66.67, y: 100 } },
  { axis: "depth", boundary: 83.33, start: { x: 83.33, y: 0 }, end: { x: 83.33, y: 100 } },
  { axis: "depth", boundary: 100, start: { x: 100, y: 0 }, end: { x: 100, y: 100 } },
  { axis: "lane", boundary: 0, start: { x: 0, y: 0 }, end: { x: 100, y: 0 } },
  { axis: "lane", boundary: 21.82, start: { x: 0, y: 21.82 }, end: { x: 100, y: 21.82 } },
  { axis: "lane", boundary: 37, start: { x: 16.67, y: 37 }, end: { x: 83.33, y: 37 } },
  { axis: "lane", boundary: 63, start: { x: 16.67, y: 63 }, end: { x: 83.33, y: 63 } },
  { axis: "lane", boundary: 78.18, start: { x: 0, y: 78.18 }, end: { x: 100, y: 78.18 } },
  { axis: "lane", boundary: 100, start: { x: 0, y: 100 }, end: { x: 100, y: 100 } },
] as const;

type PitchPoint = { x: number; y: number };
type ScreenPoint = { x: number; y: number };
type Projection = (point: PitchPoint) => ScreenPoint;
type ViewMode = "perspective" | "plan";
type ZoomLevel = 1 | 2 | 3;
type Viewport = { x: number; y: number };

const BASE_VIEWPORT = { width: 1000, height: 650 } as const;
const EMPTY_HEAT: PitchPoint[] = [];

const clamp = (value: number) => Math.min(100, Math.max(0, value));

/**
 * Provider coordinates are attack-relative: x grows left-to-right and y=0 is
 * the player's right touchline. The near edge is therefore the right lane.
 */
export function projectPerspective(point: PitchPoint): ScreenPoint {
  const x = clamp(point.x) / 100;
  const y = clamp(point.y) / 100;
  const left = 20 + (205 - 20) * y;
  const right = 980 + (795 - 980) * y;
  return { x: left + (right - left) * x, y: 585 + (235 - 585) * y };
}

export function projectPlan(point: PitchPoint): ScreenPoint {
  return { x: 30 + clamp(point.x) * 9.4, y: 610 - clamp(point.y) * 5.6 };
}

function usePrefersReducedMotion() {
  const query = "(prefers-reduced-motion: reduce)";
  const read = () => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(query).matches;
  const [reduced, setReduced] = useState(read);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const media = window.matchMedia(query);
    const update = () => setReduced(media.matches);
    update();
    media.addEventListener?.("change", update);
    return () => media.removeEventListener?.("change", update);
  }, []);
  return reduced;
}

const pathBetween = (projection: Projection, start: PitchPoint, end: PitchPoint) => {
  const a = projection(start); const b = projection(end);
  return `M ${a.x} ${a.y} L ${b.x} ${b.y}`;
};

const polygonPath = (projection: Projection, points: PitchPoint[]) => {
  const projected = points.map(projection);
  return `${projected.map((point, index) => `${index ? "L" : "M"} ${point.x} ${point.y}`).join(" ")} Z`;
};

function projectedCircle(projection: Projection, center: PitchPoint, radiusX: number, radiusY = radiusX) {
  const points = Array.from({ length: 49 }, (_, index) => {
    const angle = (Math.PI * 2 * index) / 48;
    return { x: center.x + Math.cos(angle) * radiusX, y: center.y + Math.sin(angle) * radiusY };
  });
  return polygonPath(projection, points);
}

function PitchMarkings({ projection }: { projection: Projection }) {
  const sixYardBoxes = [
    [{ x: 0, y: SIX_YARD_BOX_Y[0] }, { x: 5.5, y: SIX_YARD_BOX_Y[0] }, { x: 5.5, y: SIX_YARD_BOX_Y[1] }, { x: 0, y: SIX_YARD_BOX_Y[1] }],
    [{ x: 94.5, y: SIX_YARD_BOX_Y[0] }, { x: 100, y: SIX_YARD_BOX_Y[0] }, { x: 100, y: SIX_YARD_BOX_Y[1] }, { x: 94.5, y: SIX_YARD_BOX_Y[1] }],
  ];
  return <g data-layer="pitch-markings" fill="none" stroke="#fb923c" strokeWidth="1.5" vectorEffect="non-scaling-stroke">
    <path d={projectedCircle(projection, { x: 50, y: 50 }, 9.15, 13.45)} />
    {sixYardBoxes.map((box, index) => <path key={index} d={polygonPath(projection, box)} />)}
    {[{ x: 11, y: 50 }, { x: 50, y: 50 }, { x: 89, y: 50 }].map((spot, index) => { const point = projection(spot); return <circle key={index} cx={point.x} cy={point.y} r="2" fill="#fb923c" stroke="none"/>; })}
  </g>;
}

function PositionalGrid({ projection }: { projection: Projection }) {
  return <g data-layer="positional-grid">
    <g fill="none" stroke="#fb923c" strokeOpacity=".92" strokeWidth="1.35" vectorEffect="non-scaling-stroke">
      {LEGACY_POSITIONAL_SEGMENTS.map((segment, index) => <path key={`${segment.axis}-${segment.boundary}-${index}`} data-grid-segment={index} data-grid-axis={segment.axis} data-boundary={segment.boundary} data-start={`${segment.start.x},${segment.start.y}`} data-end={`${segment.end.x},${segment.end.y}`} d={pathBetween(projection, segment.start, segment.end)} />)}
    </g>
  </g>;
}

function GoalFrames({ projection }: { projection: Projection }) {
  return <g data-layer="goals" fill="none" stroke="#f8fafc" strokeWidth="2" strokeLinejoin="round" vectorEffect="non-scaling-stroke">
    {([0, 100] as const).map((end) => {
      const near = projection({ x: end, y: GOAL_POST_Y[0] });
      const far = projection({ x: end, y: GOAL_POST_Y[1] });
      const outward = end === 0 ? -24 : 24;
      const lift = end === 0 ? 24 : ATTACKING_GOAL_FRAME_LIFT;
      const backNear = { x: near.x + outward, y: near.y + 4 };
      const backFar = { x: far.x + outward, y: far.y + 4 };
      return <g key={end} data-goal={end === 0 ? "defending" : "attacking"} data-goal-post-near-y={GOAL_POST_Y[0]} data-goal-post-far-y={GOAL_POST_Y[1]} data-goal-frame-lift={lift} data-goal-crossbar-height-meters={GOAL_CROSSBAR_HEIGHT_METERS}>
        <path data-goal-frame d={`M ${near.x} ${near.y} L ${near.x} ${near.y - lift} L ${far.x} ${far.y - lift} L ${far.x} ${far.y}`} />
        <path data-goal-net d={`M ${near.x} ${near.y - lift} L ${backNear.x} ${backNear.y - lift * .75} L ${backFar.x} ${backFar.y - lift * .75} L ${far.x} ${far.y - lift} M ${backNear.x} ${backNear.y - lift * .75} L ${backNear.x} ${backNear.y} L ${backFar.x} ${backFar.y} L ${backFar.x} ${backFar.y - lift * .75} M ${near.x} ${near.y} L ${backNear.x} ${backNear.y} M ${far.x} ${far.y} L ${backFar.x} ${backFar.y}`} strokeOpacity=".72" />
      </g>;
    })}
  </g>;
}

function HeatLayer({ normalized, projection, clipId }: { normalized: Float64Array; projection: Projection; clipId: string }) {
  return <g data-layer="heat" clipPath={`url(#${clipId})`} style={{ mixBlendMode: "screen" }} aria-hidden="true">
    {Array.from({ length: HEATMAP_ROWS * HEATMAP_COLUMNS }, (_, index) => {
      const row = Math.floor(index / HEATMAP_COLUMNS), column = index % HEATMAP_COLUMNS;
      const value = normalized[index] ?? 0;
      const [red, green, blue, alpha] = legacyHeatmapColor(value);
      const x0 = column * 100 / HEATMAP_COLUMNS, x1 = (column + 1) * 100 / HEATMAP_COLUMNS;
      const y0 = row * 100 / HEATMAP_ROWS, y1 = (row + 1) * 100 / HEATMAP_ROWS;
      return <path key={index} data-density-cell={index} data-density-row={row} data-density-column={column} data-density-normalized={value} d={polygonPath(projection, [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }])} fill={`rgb(${red} ${green} ${blue})`} fillOpacity={alpha * HEATMAP_OPACITY} />;
    })}
  </g>;
}

const outcomeLabel: Record<ShotmapPoint["outcome"], string> = { goal: "Goal", on_target: "On target", off_target: "Off target", blocked: "Blocked" };

function usePerspectivePixelScale() {
  const ref = useRef<SVGSVGElement>(null);
  const [scale, setScale] = useState(1);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => {
      const rect = element.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const renderedScale = Math.min(rect.width / 1000, rect.height / 650);
      if (renderedScale > 0) setScale((current) => { const next = 1 / renderedScale; return Math.abs(current - next) < .0001 ? current : next; });
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(measure);
    observer?.observe(element); window.addEventListener("resize", measure);
    return () => { observer?.disconnect(); window.removeEventListener("resize", measure); };
  }, []);
  return { ref, scale };
}

const zoomViewport = (zoom: ZoomLevel) => ({ width: BASE_VIEWPORT.width / zoom, height: BASE_VIEWPORT.height / zoom });
const clampViewport = (viewport: Viewport, zoom: ZoomLevel): Viewport => {
  const visible = zoomViewport(zoom);
  return { x: Math.min(BASE_VIEWPORT.width - visible.width, Math.max(0, viewport.x)), y: Math.min(BASE_VIEWPORT.height - visible.height, Math.max(0, viewport.y)) };
};
const centeredViewport = (from: Viewport, fromZoom: ZoomLevel, toZoom: ZoomLevel): Viewport => {
  const previous = zoomViewport(fromZoom), next = zoomViewport(toZoom);
  return clampViewport({ x: from.x + previous.width / 2 - next.width / 2, y: from.y + previous.height / 2 - next.height / 2 }, toZoom);
};

function ShotGlyph({ shot, sourceIndex, projection, perspective, pixelScale, id, active, tooltipId, registerRef, onActivate, onDeactivate, onNavigate }: {
  shot: ShotmapPoint; sourceIndex: number; projection: Projection; perspective: boolean; pixelScale: number; id: string; active: boolean; tooltipId: string;
  registerRef(element: SVGGElement | null): void; onActivate(id: string): void; onDeactivate(id: string): void; onNavigate(direction: 1 | -1): void;
}) {
  const anchor = projection(shot);
  const markerSize = outcomePresentation[shot.outcome].size;
  const markerY = perspective ? anchor.y - (8 + markerSize * .55) * pixelScale : anchor.y;
  const trajectory = perspective ? shot.trajectory : null;
  const endpointGround = trajectory ? projection({ x: trajectory.endX, y: trajectory.endY }) : null;
  // Height is source data in metres. It shares the attacking frame's own
  // viewBox lift, so the crossbar is always exactly 2.44m above the ground.
  const heightLift = trajectory?.endpointKind === "goal_mouth" && trajectory.endZMeters != null
    ? ATTACKING_GOAL_FRAME_LIFT * trajectory.endZMeters / GOAL_CROSSBAR_HEIGHT_METERS
    : 0;
  const endpoint = endpointGround ? { x: endpointGround.x, y: endpointGround.y - heightLift } : null;
  const control = endpoint && trajectory ? { x: (anchor.x + endpoint.x) / 2, y: Math.min(anchor.y, endpoint.y) - (trajectory.endpointKind === "goal_mouth" ? Math.max(10 * pixelScale, heightLift * .55) : 4 * pixelScale) } : null;
  return <g ref={registerRef} id={id} role="img" tabIndex={active ? 0 : -1} aria-label={shotMarkerLabel(shot)} aria-describedby={tooltipId} data-shot-marker data-shot-index={sourceIndex} data-shot-outcome={shot.outcome} data-marker-symbol={outcomePresentation[shot.outcome].symbol} data-marker-size={markerSize} data-pitch-x={shot.x} data-pitch-y={shot.y} data-screen-x={anchor.x} data-screen-y={anchor.y} className="cursor-help" onFocus={() => onActivate(id)} onPointerEnter={() => onActivate(id)} onPointerLeave={(event) => { if (document.activeElement !== event.currentTarget) onDeactivate(id); }} onKeyDown={(event) => { if (event.key === "ArrowRight" || event.key === "ArrowDown") { event.preventDefault(); onNavigate(1); } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") { event.preventDefault(); onNavigate(-1); } }}>
    <title>{shotMarkerLabel(shot)}</title>
    {trajectory && endpointGround && endpoint && control && <path data-shot-trajectory data-trajectory-kind={trajectory.endpointKind} data-end-pitch-x={trajectory.endX} data-end-pitch-y={trajectory.endY} data-end-goal-mouth={trajectory.endpointKind === "goal_mouth" ? trajectory.endY >= GOAL_POST_Y[0] && trajectory.endY <= GOAL_POST_Y[1] ? "inside" : "outside" : undefined} data-end-height-meters={trajectory.endZMeters ?? undefined} data-end-height-lift={heightLift} data-end-ground-x={endpointGround.x} data-end-ground-y={endpointGround.y} data-end-render-x={endpoint.x} data-end-render-y={endpoint.y} d={`M ${anchor.x} ${anchor.y} Q ${control.x} ${control.y} ${endpoint.x} ${endpoint.y}`} fill="none" stroke={outcomePresentation[shot.outcome].color} strokeOpacity={trajectory.endpointKind === "blocked" ? ".62" : ".82"} strokeWidth={trajectory.endpointKind === "blocked" ? "1.4" : "1.8"} strokeDasharray={trajectory.endpointKind === "blocked" ? "4 4" : undefined} vectorEffect="non-scaling-stroke" pointerEvents="none"/>}
    {perspective && <><line data-shot-anchor x1={anchor.x} y1={anchor.y} x2={anchor.x} y2={markerY} stroke={outcomePresentation[shot.outcome].color} strokeOpacity=".7" strokeWidth="1.5" strokeDasharray="3 3" vectorEffect="non-scaling-stroke"/><ellipse data-shot-shadow cx={anchor.x} cy={anchor.y} rx={markerSize * .9 * pixelScale} ry={markerSize * .28 * pixelScale} fill="#020617" fillOpacity=".55"/></>}
    <g data-marker-visual data-pixel-scale={pixelScale} transform={`translate(${anchor.x} ${markerY}) scale(${pixelScale})`}><LegacyShotShape shot={shot}/><circle data-marker-hit r="12" fill="transparent" pointerEvents="all" /></g>
  </g>;
}

function PitchSvg({ spatial, mode, filterId, visibleOutcomes, markerLayerId, contextIdentity }: { spatial: PlayerAnalysis["spatial"] | undefined; mode: ViewMode; filterId: string; visibleOutcomes: ReadonlySet<ShotOutcome>; markerLayerId: string; contextIdentity: string }) {
  const perspective = mode === "perspective";
  const projection = perspective ? projectPerspective : projectPlan;
  const heatValid = Boolean(spatial?.available && spatial.heatmapPointCount === spatial.heatmapPoints.length && spatial.heatmapPoints.every(({ x, y }) => Number.isFinite(x) && Number.isFinite(y) && x >= 0 && x <= 100 && y >= 0 && y <= 100));
  const heat = heatValid ? spatial!.heatmapPoints : EMPTY_HEAT;
  const shotsValid = shotIntegrity(spatial);
  const shots = shotsValid ? spatial!.shotmapPoints.map((shot, sourceIndex) => ({ shot, sourceIndex })).filter(({ shot }) => visibleOutcomes.has(shot.outcome)) : [];
  const heatState = !spatial?.available ? "Activity heatmap unavailable" : !heatValid ? "Activity heatmap integrity mismatch" : heat.length ? `${heat.length} activity points` : "Verified zero activity points";
  const shotState = !spatial?.shotmapSnapshotAvailable ? "Shot snapshot unavailable" : !shotsValid ? "Shot snapshot integrity mismatch" : spatial.shotmapPoints.length ? `${spatial.shotmapPoints.length} shots` : "Verified zero shots";
  const normalized = useMemo(() => normalizeDensity(legacyDensityGrid(heat)), [heat]);
  const contour = heatValid && spatial?.continuousCore.available && spatial.continuousCore.gridColumns === HEATMAP_COLUMNS && spatial.continuousCore.gridRows === HEATMAP_ROWS && Number.isFinite(spatial.continuousCore.thresholdOfPeak) && spatial.continuousCore.thresholdOfPeak > 0 ? marchingSquares(normalized, spatial.continuousCore.thresholdOfPeak) : [];
  const pitchShape = polygonPath(projection, [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }]);
  const markerRefs = useRef(new Map<string, SVGGElement>()), tooltipId = `${filterId}-shot-tooltip`;
  const rendered = usePerspectivePixelScale();
  const [zoom, setZoom] = useState<ZoomLevel>(1), [viewport, setViewport] = useState<Viewport>({ x: 0, y: 0 });
  const pointerPan = useRef<{ pointerId: number; clientX: number; clientY: number; viewport: Viewport } | null>(null);
  const resetViewport = () => { pointerPan.current = null; setZoom(1); setViewport({ x: 0, y: 0 }); };
  useEffect(() => { resetViewport(); }, [contextIdentity]);
  const visibleViewport = zoomViewport(zoom);
  const viewBox = `${viewport.x} ${viewport.y} ${visibleViewport.width} ${visibleViewport.height}`;
  const pixelScale = rendered.scale / zoom;
  const setZoomLevel = (next: ZoomLevel) => { setViewport((current) => centeredViewport(current, zoom, next)); setZoom(next); };
  const panBy = (x: number, y: number) => setViewport((current) => clampViewport({ x: current.x + x, y: current.y + y }, zoom));
  const [activeId, setActiveId] = useState<string | null>(null), [tooltipIdState, setTooltipIdState] = useState<string | null>(null);
  const firstId = shots.length ? `${filterId}-shot-${shots[0].sourceIndex}` : null;
  const activeVisibleId = shots.some(({ sourceIndex }) => `${filterId}-shot-${sourceIndex}` === activeId) ? activeId : firstId;
  const tooltipEntry = shots.find(({ sourceIndex }) => `${filterId}-shot-${sourceIndex}` === tooltipIdState);
  const navigate = (visibleIndex: number, direction: 1 | -1) => { if (!shots.length) return; const next = shots[(visibleIndex + direction + shots.length) % shots.length]; const id = `${filterId}-shot-${next.sourceIndex}`; setActiveId(id); setTooltipIdState(id); markerRefs.current.get(id)?.focus(); };
  const visibleGroups = outcomeOrder.filter((outcome) => visibleOutcomes.has(outcome) && spatial?.shotmapPoints.some((shot) => shot.outcome === outcome));
  return <><div className="flex flex-wrap items-center gap-2 border-b border-white/10 bg-black/25 px-2 py-2"><div role="group" aria-label="Perspective zoom controls" className="flex flex-wrap items-center gap-1"><button type="button" aria-label="Zoom out" disabled={zoom === 1} onClick={() => setZoomLevel((zoom - 1) as ZoomLevel)} className="min-h-11 min-w-11 rounded border border-white/15 px-2 text-sm font-bold disabled:cursor-not-allowed disabled:opacity-40 focus-visible:ring-2 focus-visible:ring-orange-200">−</button><button type="button" aria-label="Zoom in" disabled={zoom === 3} onClick={() => setZoomLevel((zoom + 1) as ZoomLevel)} className="min-h-11 min-w-11 rounded border border-white/15 px-2 text-sm font-bold disabled:cursor-not-allowed disabled:opacity-40 focus-visible:ring-2 focus-visible:ring-orange-200">+</button><button type="button" aria-label="Reset zoom and pan" disabled={zoom === 1 && viewport.x === 0 && viewport.y === 0} onClick={resetViewport} className="min-h-11 min-w-11 rounded border border-white/15 px-3 text-xs font-bold disabled:cursor-not-allowed disabled:opacity-40 focus-visible:ring-2 focus-visible:ring-orange-200">Reset</button></div><p aria-live="polite" className="text-xs text-zinc-300">Perspective zoom {zoom}×</p></div><svg ref={rendered.ref} viewBox={viewBox} preserveAspectRatio="xMidYMid meet" className="block h-auto w-full rounded-b-lg bg-[#070b0d] touch-pan-y" role="img" tabIndex={0} aria-label={`${perspective ? "Perspective" : "Two-dimensional"} attacking pitch with exact 6-depth by 5-lane positional grid. ${heatState}. ${shotState}. Visible shot outcomes: ${outcomeSummary(visibleGroups)}. Outcome controls change markers only.`} onPointerDown={(event) => { if (zoom === 1 || event.defaultPrevented || event.target !== event.currentTarget) return; pointerPan.current = { pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY, viewport }; event.currentTarget.setPointerCapture?.(event.pointerId); }} onPointerMove={(event) => { const start = pointerPan.current; if (!start || start.pointerId !== event.pointerId) return; const bounds = event.currentTarget.getBoundingClientRect(); if (!bounds.width || !bounds.height) return; setViewport(clampViewport({ x: start.viewport.x - (event.clientX - start.clientX) * visibleViewport.width / bounds.width, y: start.viewport.y - (event.clientY - start.clientY) * visibleViewport.height / bounds.height }, zoom)); }} onPointerUp={(event) => { if (pointerPan.current?.pointerId !== event.pointerId) return; pointerPan.current = null; if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture?.(event.pointerId); }} onPointerCancel={() => { pointerPan.current = null; }} onLostPointerCapture={() => { pointerPan.current = null; }} onKeyDown={(event) => { if (event.defaultPrevented || event.target !== event.currentTarget) return; if (event.key === "Escape") { event.preventDefault(); resetViewport(); return; } if (zoom === 1) return; const step = Math.min(48, visibleViewport.width / 5); if (event.key === "ArrowLeft") { event.preventDefault(); panBy(-step, 0); } else if (event.key === "ArrowRight") { event.preventDefault(); panBy(step, 0); } else if (event.key === "ArrowUp") { event.preventDefault(); panBy(0, -step); } else if (event.key === "ArrowDown") { event.preventDefault(); panBy(0, step); } }}>
    <defs><clipPath id={`${filterId}-pitch-clip`}><path d={pitchShape}/></clipPath><linearGradient id={`${filterId}-grass`} x1="0" y1="0" x2="0" y2="1"><stop stopColor="#0f6f42"/><stop offset="1" stopColor="#06432e"/></linearGradient></defs>
    <path d={pitchShape} fill={`url(#${filterId}-grass)`} stroke="#143d2f" strokeWidth="9" />
    <GoalFrames projection={projection}/>
    <HeatLayer normalized={normalized} projection={projection} clipId={`${filterId}-pitch-clip`}/>
    <PitchMarkings projection={projection}/>
    <PositionalGrid projection={projection}/>
    {contour.length > 0 && <g data-layer="cca-contour" fill="none" stroke="#c044ff" strokeWidth="3" vectorEffect="non-scaling-stroke">{contour.map(([x1, y1, x2, y2], index) => <path key={index} d={pathBetween(projection, { x: x1, y: 100 - y1 }, { x: x2, y: 100 - y2 })}/>)}</g>}
    <g id={markerLayerId} data-layer="shots">{shots.map(({ shot, sourceIndex }, visibleIndex) => { const id = `${filterId}-shot-${sourceIndex}`; return <ShotGlyph key={id} shot={shot} sourceIndex={sourceIndex} projection={projection} perspective={perspective} pixelScale={pixelScale} id={id} active={id === activeVisibleId} tooltipId={tooltipId} registerRef={(element) => { if (element) markerRefs.current.set(id, element); else markerRefs.current.delete(id); }} onActivate={(markerId) => { setActiveId(markerId); setTooltipIdState(markerId); }} onDeactivate={(markerId) => { if (tooltipIdState === markerId) setTooltipIdState(null); }} onNavigate={(direction) => navigate(visibleIndex, direction)}/>; })}</g>
    {tooltipEntry && (() => { const anchor = projection(tooltipEntry.shot), tooltipWidth = 150, tooltipHeight = 62; const maxX = Math.max(0, BASE_VIEWPORT.width - tooltipWidth * pixelScale), maxY = Math.max(0, BASE_VIEWPORT.height - tooltipHeight * pixelScale); const x = Math.min(maxX, Math.max(0, anchor.x - 70 * pixelScale)), y = Math.min(maxY, Math.max(0, anchor.y - 82 * pixelScale)); return <g id={tooltipId} role="tooltip" pointerEvents="none" data-tooltip-width={tooltipWidth} data-tooltip-height={tooltipHeight} data-pixel-scale={pixelScale} transform={`translate(${x} ${y}) scale(${pixelScale})`}><rect width={tooltipWidth} height={tooltipHeight} rx="7" fill="#0b0e0f" fillOpacity=".96" stroke="#ffffff" strokeOpacity=".25"/><text x="10" y="18" fill="#f4f4f5" fontSize="12" fontWeight="700">{outcomePresentation[tooltipEntry.shot.outcome].label}</text><text x="10" y="37" fill="#e4e4e7" fontSize="11">xG {formatShotMetric(tooltipEntry.shot.xg)}</text><text x="10" y="53" fill="#e4e4e7" fontSize="11">xGOT {formatShotMetric(tooltipEntry.shot.xgot)}</text></g>; })()}
    <g fill="#e4e4e7" fontSize="13" fontWeight="700" aria-hidden="true"><text x="36" y="630">Attack direction 0 → 100</text><text x="835" y="584">Lane 1 · right</text><text x="194" y="73">Lane 5 · left</text></g>
  </svg></>;
}

export function SpatialPitch({ analysis, contextIdentity = "" }: { analysis?: PlayerAnalysis; contextIdentity?: string }) {
  const reducedMotion = usePrefersReducedMotion();
  const [manualMode, setManualMode] = useState<ViewMode | null>(null);
  const mode = manualMode ?? (reducedMotion ? "plan" : "perspective");
  const spatial = analysis?.spatial;
  const controller = useShotOutcomeVisibility(spatial, contextIdentity);
  const heatValid = Boolean(spatial?.available && spatial.heatmapPointCount === spatial.heatmapPoints.length && spatial.heatmapPoints.every(({ x, y }) => Number.isFinite(x) && Number.isFinite(y) && x >= 0 && x <= 100 && y >= 0 && y <= 100));
  const heatState = !spatial?.available ? "Activity heatmap unavailable" : !heatValid ? "Activity heatmap integrity mismatch" : spatial.heatmapPoints.length ? `${spatial.heatmapPoints.length} activity points` : "Verified zero activity points";
  const shotState = !spatial?.shotmapSnapshotAvailable ? "Shot snapshot unavailable" : !controller.integrity ? "Shot snapshot integrity mismatch" : spatial.shotmapPoints.length ? `${spatial.shotmapPoints.length} shots` : "Verified zero shots";
  const counts = controller.counts;
  const rawId = useId().replace(/:/g, "");
  const markerLayerId = `spatial-shot-markers-${rawId}`;
  return <section className={panel} aria-labelledby={`spatial-pitch-${rawId}`}>
    <div className="flex flex-wrap items-start justify-between gap-3"><div><h2 id={`spatial-pitch-${rawId}`} className="text-sm font-black">Spatial pitch</h2><p className="mt-1 text-[11px] text-zinc-400">Attack left → right · Lane 1 is the near/right touchline · exact positional-6×5 grid</p></div><div role="group" aria-label="Pitch view" className="flex rounded-lg border border-white/15 bg-black/30 p-1"><button type="button" aria-pressed={mode === "perspective"} onClick={() => setManualMode("perspective")} className="min-h-9 rounded px-3 text-xs font-bold aria-pressed:bg-orange-400 aria-pressed:text-zinc-950 focus-visible:ring-2 focus-visible:ring-orange-200">Perspective</button><button type="button" aria-pressed={mode === "plan"} onClick={() => setManualMode("plan")} className="min-h-9 rounded px-3 text-xs font-bold aria-pressed:bg-orange-400 aria-pressed:text-zinc-950 focus-visible:ring-2 focus-visible:ring-orange-200">2D plan</button></div></div>
    {reducedMotion && manualMode === null && <p className="mt-2 text-xs text-zinc-400">Reduced-motion preference detected; the 2D plan fallback is active.</p>}
    {controller.integrity && controller.presentOutcomes.length > 0 && <OutcomeControls outcomes={controller.presentOutcomes} counts={controller.counts} visible={controller.visibleOutcomes} markerLayerId={markerLayerId} onClick={controller.onClick} onDoubleClick={controller.onDoubleClick}/>}<p role="status" aria-live="polite" className="sr-only">Visible shot outcomes: {outcomeSummary(controller.presentOutcomes.filter((outcome) => controller.visibleOutcomes.has(outcome)))}.</p>
    <div className="mt-3 min-w-0 overflow-hidden rounded-lg border border-white/10">{mode === "plan" ? <LegacySpatialPitchFigure analysis={analysis} visibleOutcomes={controller.visibleOutcomes} markerLayerId={markerLayerId} showCounts={false}/> : <figure><PitchSvg spatial={spatial} mode={mode} filterId={`spatial-heat-${rawId}`} visibleOutcomes={controller.visibleOutcomes} markerLayerId={markerLayerId} contextIdentity={contextIdentity}/><figcaption className="border-t border-white/10 bg-black/25 px-3 py-2 text-xs text-zinc-300">{heatState}. {shotState}. The exact legacy density mesh, the authoritative CCA contour, and shot anchors share the server 0–100 coordinate transform; outcome controls affect markers only.</figcaption></figure>}</div>
    <div className="mt-3 grid gap-2 text-xs text-zinc-400 sm:grid-cols-2"><p aria-live="polite">{heatState}. Thirty tactical cells are visual guides; no browser-side score or zone value is calculated.</p><p aria-live="polite">{shotState}. Unavailable and available-with-zero are kept distinct.</p></div>
    {controller.integrity ? <ul aria-label="Shot outcome legend" className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-zinc-300"><li>◇ Goals {counts.goal}</li><li>● On target {counts.on_target}</li><li>× Off target {counts.off_target}</li><li>■ Blocked {counts.blocked}</li></ul> : <p className="mt-2 text-xs text-zinc-500">Outcome totals are unavailable because no valid shot snapshot exists for this context.</p>}
    <details className="mt-3 rounded-lg border border-white/10 bg-black/20 text-xs text-zinc-300"><summary className="min-h-11 cursor-pointer px-3 py-3 font-bold focus-visible:ring-2 focus-visible:ring-orange-200">Pitch and shot details</summary><div className="border-t border-white/10 p-3"><p>The perspective view uses the same segmented positional-play grid and source-coordinate direction as the 2D legacy pitch.</p>{!controller.integrity ? <p className="mt-3">Shot event details unavailable.</p> : spatial!.shotmapPoints.length === 0 ? <p className="mt-3">Verified zero shot events.</p> : <ol aria-label="Authoritative shot events" className="mt-3 max-h-48 space-y-1 overflow-y-auto pr-1">{spatial!.shotmapPoints.map((shot, index) => <li key={index} className="rounded bg-white/5 px-2 py-1">{index + 1}. {outcomeLabel[shot.outcome]} · xG {shot.xg == null ? "unavailable" : shot.xg.toFixed(2)} · xGOT {shot.xgot == null ? "unavailable" : shot.xgot.toFixed(2)} · ({shot.x.toFixed(1)}, {shot.y.toFixed(1)}){shot.trajectory ? ` · ${shot.trajectory.endpointKind === "goal_mouth" ? "goal-mouth" : "blocked"} trajectory to (${shot.trajectory.endX.toFixed(1)}, ${shot.trajectory.endY.toFixed(1)})${shot.trajectory.endpointKind === "goal_mouth" ? ` at ${shot.trajectory.endZMeters == null ? "unknown height" : `${shot.trajectory.endZMeters.toFixed(2)} m`}` : ""}` : " · trajectory unavailable"}</li>)}</ol>}</div></details>
  </section>;
}
