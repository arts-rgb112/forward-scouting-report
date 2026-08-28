import { useEffect, useId, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

import type { PlayerAnalysis, ShotmapPoint } from "../dashboard/types";
import { LegacySpatialPitchFigure } from "./LegacySpatialPitch";
import { DISPLAY_HEATMAP_COLUMNS, DISPLAY_HEATMAP_ROWS, HEATMAP_COLUMNS, HEATMAP_OPACITY, HEATMAP_ROWS, displayDensityGrid, displayHeatmapColor, legacyDensityGrid, marchingSquares, normalizeDensity } from "./legacyHeatmap";
import { groupPitchShots, medianObservedXg, pitchMarkerRadius, PitchShotMarker, type PitchShotGroup } from "./PitchShotMarker";
import { usePitchPenalty } from "./PitchPenaltyContext";
import { excludePenaltyShots, penaltyStateLabel, summarizeShots } from "./pitchPenalties";
import { CCA_STYLE, PATH_STYLE, TACTICS_BOARD_CAMERA, goalFrame, orbitCamera, pitchMarkings, shotFlight, zone20Lines, type Projection as GeometryProjection, type Vec3 } from "./pitchGeometry";
import { formatShotMetric, outcomeOrder, outcomePresentation, outcomeSummary, OutcomeControls, shotIntegrity, shotMarkerLabel, type ShotOutcome, useShotOutcomeVisibility } from "./shotOutcomeVisibility";

const panel = "min-w-0 rounded-xl border border-white/10 bg-[#101415] p-4 shadow-sm";
const PITCH_VIEW_COPY = {
  perspective: "어디서 쏘고 어디로 꽂나",
  plan: "어떻게 움직이나",
  cameraFrames: {
    full: "Full field",
    attacking: "Attacking half",
    box: "Box",
  },
  cameraFrameGroup: "Perspective camera frames",
  cameraZoomGroup: "Perspective zoom controls",
  resetCamera: "Reset camera",
} as const;

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

export type PitchPoint = { x: number; y: number };
export type ScreenPoint = { x: number; y: number };
type Projection = (point: PitchPoint) => ScreenPoint;
export type ViewMode = "perspective" | "plan";
type ZoomLevel = 1 | 2 | 3;
type Viewport = { x: number; y: number };
type OrbitCamera = { azimuth: number; elevation: number; distance: number };
type CameraFrame = "full" | "attacking" | "box";
type DensityMeshCell = { index: number; row: number; column: number; normalized: number; fill: string; fillOpacity: number; d: string };

/** Shared native SVG plan dimensions for player-detail companion charts. */
export const SPATIAL_PITCH_VIEWBOX = { width: 1000, height: 650 } as const;
/** Shared matrix translation and crop bounds for vertical companion views of the plan pitch. */
export const PLAN_VERTICAL_TRANSFORM_Y = 1000;
export const finalThirdPlanCrop = () => {
  const opponentEnd = projectPlan({ x: 100, y: 50 }).x;
  const depth5Boundary = projectPlan({ x: POSITIONAL_DEPTH_BOUNDARIES[4], y: 50 }).x;
  const laneNear = projectPlan({ x: 50, y: 0 }).y, laneFar = projectPlan({ x: 50, y: 100 }).y;
  return { x: Math.min(laneNear, laneFar), y: PLAN_VERTICAL_TRANSFORM_Y - opponentEnd, width: Math.abs(laneFar - laneNear), height: opponentEnd - depth5Boundary };
};
const BASE_VIEWPORT = SPATIAL_PITCH_VIEWBOX;
const EMPTY_HEAT: PitchPoint[] = [];
const DEFAULT_ORBIT_CAMERA: OrbitCamera = { azimuth: TACTICS_BOARD_CAMERA.azimuth, elevation: TACTICS_BOARD_CAMERA.elevation, distance: TACTICS_BOARD_CAMERA.radius };
const ORBIT_DISTANCE = { minimum: 48, maximum: 132, step: 12 } as const;
const ORBIT_FRAME_FROM_X: Record<CameraFrame, number> = { full: 0, attacking: 50, box: 80 };

const clamp = (value: number) => Math.min(100, Math.max(0, value));
const clampDistance = (value: number) => Math.min(ORBIT_DISTANCE.maximum, Math.max(ORBIT_DISTANCE.minimum, value));

const median = (values: readonly number[]) => {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

/** Stable per-context orbit centre: shot median, then heat-density peak, then the approved fallback. */
export function deriveOrbitPivot(spatial: PlayerAnalysis["spatial"] | undefined, normalized: Float64Array): Vec3 {
  if (shotIntegrity(spatial)) {
    const validShots = spatial!.shotmapPoints.filter((shot) => Number.isFinite(shot.x) && Number.isFinite(shot.y) && shot.x >= 0 && shot.x <= 100 && shot.y >= 0 && shot.y <= 100);
    const x = median(validShots.map((shot) => shot.x));
    const y = median(validShots.map((shot) => shot.y));
    if (x != null && y != null) return [x * 1.05, y * .68, 0];
  }
  let peak = 0, peakIndex = -1;
  normalized.forEach((value, index) => { if (value > peak) { peak = value; peakIndex = index; } });
  if (peakIndex >= 0) {
    const row = Math.floor(peakIndex / HEATMAP_COLUMNS), column = peakIndex % HEATMAP_COLUMNS;
    return [((column + .5) / HEATMAP_COLUMNS) * 105, ((row + .5) / HEATMAP_ROWS) * 68, 0];
  }
  return TACTICS_BOARD_CAMERA.pivot;
}

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

const asGeometryProjection = (projectPoint: Projection): GeometryProjection => ({
  project: ([worldX, worldY]) => { const point = projectPoint({ x: worldX / 1.05, y: worldY / .68 }); return [point.x, point.y]; },
  pp: (yPct, xPct) => { const point = projectPoint({ x: xPct, y: yPct }); return [point.x, point.y]; },
  cameraPosition: [0, 0, 0],
  scale: 1,
});

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

export function PitchMarkings({ projection }: { projection: GeometryProjection }) {
  return <g data-layer="pitch-markings" fill="none" vectorEffect="non-scaling-stroke">
    {pitchMarkings(projection).map((path, index) => { const style = PATH_STYLE[path.role]; return <path key={index} d={path.d} stroke={style.stroke} strokeOpacity={style.opacity} strokeWidth={style.width} strokeDasharray={style.dash} />; })}
  </g>;
}

export function PositionalGrid({ projection }: { projection: GeometryProjection }) {
  const style = PATH_STYLE["zone-grid"];
  return <g data-layer="positional-grid" fill="none" stroke={style.stroke} strokeOpacity={style.opacity} strokeWidth={style.width} strokeDasharray={style.dash} vectorEffect="non-scaling-stroke">
    {zone20Lines(projection).map((path, index) => <path key={index} data-grid-segment={index} d={path.d} />)}
  </g>;
}

export function GoalFrames({ projection }: { projection: GeometryProjection }) {
  return <g data-layer="goals" fill="none" strokeLinejoin="round" vectorEffect="non-scaling-stroke">
    {(["defending", "attacking"] as const).map((end) => {
      const goal = goalFrame(projection, end);
      const ground = projection.pp(GOAL_POST_Y[0], end === "attacking" ? 100 : 0);
      const crossbar = projection.pp(GOAL_POST_Y[0], end === "attacking" ? 100 : 0, GOAL_CROSSBAR_HEIGHT_METERS);
      return <g key={end} data-goal={end} data-goal-post-near-y={GOAL_POST_Y[0]} data-goal-post-far-y={GOAL_POST_Y[1]} data-goal-frame-lift={Math.abs(ground[1] - crossbar[1])} data-goal-crossbar-height-meters={GOAL_CROSSBAR_HEIGHT_METERS}>
        <path data-goal-frame d={goal.frame} stroke={PATH_STYLE["goal-frame"].stroke} strokeOpacity={PATH_STYLE["goal-frame"].opacity} strokeWidth={PATH_STYLE["goal-frame"].width}/>
        {goal.net.map((d, index) => <path key={index} data-goal-net d={d} stroke={PATH_STYLE["goal-net"].stroke} strokeOpacity={PATH_STYLE["goal-net"].opacity} strokeWidth={PATH_STYLE["goal-net"].width}/>) }
      </g>;
    })}
  </g>;
}

/** Shared, unmodified 1000×650 plan primitives. Companion charts may crop/transform this group only. */
export function PlanPitchGeometry({ geometryId = "shared-plan-pitch" }: { geometryId?: string }) {
  const projection = projectPlan;
  const geometryProjection = asGeometryProjection(projection);
  const pitchShape = polygonPath(projection, [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }]);
  return <g data-shared-plan-pitch={geometryId}><defs><linearGradient id={`${geometryId}-grass`} x1="0" y1="0" x2="0" y2="1"><stop stopColor="#0f6f42"/><stop offset="1" stopColor="#06432e"/></linearGradient></defs><path data-shared-plan-boundary d={pitchShape} fill={`url(#${geometryId}-grass)`} stroke="#143d2f" strokeWidth="9"/><GoalFrames projection={geometryProjection}/><PitchMarkings projection={geometryProjection}/><PositionalGrid projection={geometryProjection}/></g>;
}

function prepareDensityMesh(displayDensity: Float64Array, projection: Projection): DensityMeshCell[] {
  return Array.from({ length: DISPLAY_HEATMAP_ROWS * DISPLAY_HEATMAP_COLUMNS }, (_, index) => {
      const row = Math.floor(index / DISPLAY_HEATMAP_COLUMNS), column = index % DISPLAY_HEATMAP_COLUMNS;
      const value = displayDensity[index] ?? 0;
      const [red, green, blue, alpha] = displayHeatmapColor(value);
      const x0 = column * 100 / DISPLAY_HEATMAP_COLUMNS, x1 = (column + 1) * 100 / DISPLAY_HEATMAP_COLUMNS;
      const y0 = row * 100 / DISPLAY_HEATMAP_ROWS, y1 = (row + 1) * 100 / DISPLAY_HEATMAP_ROWS;
      return { index, row, column, normalized: value, fill: `rgb(${red} ${green} ${blue})`, fillOpacity: alpha * HEATMAP_OPACITY, d: polygonPath(projection, [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }]) };
    });
}

function HeatLayer({ mesh, clipId, filterId, buildCount }: { mesh: readonly DensityMeshCell[]; clipId: string; filterId: string; buildCount: number }) {
  return <g data-layer="heat" data-density-source="display-96x66" data-density-mesh-builds={buildCount} clipPath={`url(#${clipId})`} filter={`url(#${filterId})`} aria-hidden="true">
    {mesh.map((cell) => <path key={cell.index} data-density-cell={cell.index} data-density-row={cell.row} data-density-column={cell.column} data-density-normalized={cell.normalized} d={cell.d} fill={cell.fill} fillOpacity={cell.fillOpacity} />)}
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

function isInteractivePitchTarget(target: EventTarget | null) {
  if (!(target instanceof Element)) return false;
  if (target.closest("[data-shot-trajectory]")) return false;
  return Boolean(target.closest("[data-shot-marker], [data-marker-hit], [role=tooltip], button, a, input, select, textarea"));
}

function ShotGlyph({ group, medianXg, projection, geometryProjection, perspective, pixelScale, id, active, tooltipId, registerRef, onActivate, onDeactivate, onNavigate }: {
  group: PitchShotGroup; medianXg: number | null; projection: Projection; geometryProjection: GeometryProjection; perspective: boolean; pixelScale: number; id: string; active: boolean; tooltipId: string;
  registerRef(element: SVGGElement | null): void; onActivate(id: string): void; onDeactivate(id: string): void; onNavigate(direction: 1 | -1): void;
}) {
  const { shot } = group;
  const anchor = projection(shot);
  const markerRadius = pitchMarkerRadius(shot.xg, medianXg);
  const markerY = anchor.y;
  // A blocked endpoint is not a goal-line trajectory and must never be drawn.
  const trajectory = perspective && shot.trajectory?.endpointKind === "goal_mouth" ? shot.trajectory : null;
  const flight = trajectory ? shotFlight(geometryProjection, { x: shot.x, y: shot.y, endY: trajectory.endY, endZMeters: trajectory.endZMeters }) : null;
  const trajectoryStyle = {
    goal: { color: "#BEF264", opacity: .9, width: 2.6 },
    on_target: { color: "#38BDF8", opacity: .6, width: 1.9 },
    off_target: { color: "#E2E8F0", opacity: .16, width: 1.2 },
    blocked: { color: "#94A3B8", opacity: 0, width: 0 },
  }[group.outcome];
  return <g ref={registerRef} id={id} role="img" tabIndex={active ? 0 : -1} aria-label={`${shotMarkerLabel(shot)}${group.count > 1 ? ` ${group.count} shots share this exact coordinate. Stack: ${group.outcomeCounts.goal} goals, ${group.outcomeCounts.on_target} on target, ${group.outcomeCounts.off_target} off target, ${group.outcomeCounts.blocked} blocked.` : ""}`} aria-describedby={tooltipId} data-shot-marker data-shot-index={group.sourceIndexes[0]} data-shot-indexes={group.sourceIndexes.join(",")} data-shot-outcome={group.outcome} data-marker-symbol={outcomePresentation[group.outcome].symbol} data-marker-size={markerRadius * 2} data-marker-count={group.count} data-pitch-x={shot.x} data-pitch-y={shot.y} data-screen-x={anchor.x} data-screen-y={anchor.y} className="cursor-help" onFocus={() => onActivate(id)} onPointerEnter={() => onActivate(id)} onPointerLeave={(event) => { if (document.activeElement !== event.currentTarget) onDeactivate(id); }} onKeyDown={(event) => { if (event.key === "ArrowRight" || event.key === "ArrowDown") { event.preventDefault(); onNavigate(1); } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") { event.preventDefault(); onNavigate(-1); } }}>
    <title>{shotMarkerLabel(shot)}</title>
    {trajectory && flight && <g data-shot-trajectory data-trajectory-kind={trajectory.endpointKind} data-trajectory-outcome={group.outcome} data-end-pitch-x={trajectory.endX} data-end-pitch-y={trajectory.endY} data-end-goal-mouth={trajectory.endY >= GOAL_POST_Y[0] && trajectory.endY <= GOAL_POST_Y[1] ? "inside" : "outside"} data-end-height-meters={trajectory.endZMeters ?? undefined} data-end-render-x={flight.landing[0]} data-end-render-y={flight.landing[1]} fill="none" pointerEvents="none">{flight.arc.map((d, index) => { const progress = (index + 1) / flight.arc.length; return <path key={index} d={d} stroke={trajectoryStyle.color} strokeOpacity={trajectoryStyle.opacity * (.95 - .5 * progress)} strokeWidth={trajectoryStyle.width * (1 - .5 * progress)} strokeLinecap="round" vectorEffect="non-scaling-stroke"/>; })}</g>}
    <g data-marker-visual data-pixel-scale={pixelScale} transform={`translate(${anchor.x} ${markerY}) scale(${pixelScale})`}><PitchShotMarker outcome={group.outcome} radius={markerRadius} count={group.count} outcomeCounts={group.outcomeCounts} expandedStack={tooltipId === id}/><circle data-marker-hit r="12" fill="transparent" pointerEvents="all" /></g>
  </g>;
}

export function createOrbitProjection(camera: OrbitCamera, frame: CameraFrame): Projection {
  const projection = orbitCamera({ ...TACTICS_BOARD_CAMERA, azimuth: camera.azimuth, elevation: camera.elevation, radius: camera.distance, frameFromX: ORBIT_FRAME_FROM_X[frame], width: BASE_VIEWPORT.width, height: BASE_VIEWPORT.height });
  return (point) => { const [x, y] = projection.pp(point.y, point.x); return { x, y }; };
}

function PitchSvg({ spatial, mode, filterId, visibleOutcomes, markerLayerId, contextIdentity }: { spatial: PlayerAnalysis["spatial"] | undefined; mode: ViewMode; filterId: string; visibleOutcomes: ReadonlySet<ShotOutcome>; markerLayerId: string; contextIdentity: string }) {
  const perspective = mode === "perspective";
  const [camera, setCamera] = useState<OrbitCamera>(DEFAULT_ORBIT_CAMERA);
  const [cameraFrame, setCameraFrame] = useState<CameraFrame>("attacking");
  const heatValid = Boolean(spatial?.available && spatial.heatmapPointCount === spatial.heatmapPoints.length && spatial.heatmapPoints.every(({ x, y }) => Number.isFinite(x) && Number.isFinite(y) && x >= 0 && x <= 100 && y >= 0 && y <= 100));
  const heat = heatValid ? spatial!.heatmapPoints : EMPTY_HEAT;
  const shotsValid = shotIntegrity(spatial);
  const shots = shotsValid ? spatial!.shotmapPoints.map((shot, sourceIndex) => ({ shot, sourceIndex })).filter(({ shot }) => visibleOutcomes.has(shot.outcome)) : [];
  const medianXg = shotsValid ? medianObservedXg(spatial!.shotmapPoints) : null;
  const markerGroups = groupPitchShots(shots);
  const heatState = !spatial?.available ? "Activity heatmap unavailable" : !heatValid ? "Activity heatmap integrity mismatch" : heat.length ? `${heat.length} activity points` : "Verified zero activity points";
  const shotState = !spatial?.shotmapSnapshotAvailable ? "Shot snapshot unavailable" : !shotsValid ? "Shot snapshot integrity mismatch" : spatial.shotmapPoints.length ? `${spatial.shotmapPoints.length} shots` : "Verified zero shots";
  const normalized = useMemo(() => normalizeDensity(legacyDensityGrid(heat)), [heat]);
  const orbitPivot = useMemo(() => deriveOrbitPivot(spatial, normalized), [normalized, spatial]);
  const geometryProjection = useMemo(() => orbitCamera({ ...TACTICS_BOARD_CAMERA, pivot: orbitPivot, azimuth: camera.azimuth, elevation: camera.elevation, radius: camera.distance, frameFromX: ORBIT_FRAME_FROM_X[cameraFrame], width: BASE_VIEWPORT.width, height: BASE_VIEWPORT.height }), [camera, cameraFrame, orbitPivot]);
  const projection = useMemo(() => perspective ? ((point: PitchPoint) => { const [x, y] = geometryProjection.pp(point.y, point.x); return { x, y }; }) : projectPlan, [geometryProjection, perspective]);
  const displayDensity = useMemo(() => displayDensityGrid(normalized), [normalized]);
  const meshBuildCount = useRef(0);
  const densityMesh = useMemo(() => { meshBuildCount.current += 1; return prepareDensityMesh(displayDensity, projection); }, [displayDensity, projection]);
  const contour = heatValid && spatial?.continuousCore.available && spatial.continuousCore.gridColumns === HEATMAP_COLUMNS && spatial.continuousCore.gridRows === HEATMAP_ROWS && Number.isFinite(spatial.continuousCore.thresholdOfPeak) && spatial.continuousCore.thresholdOfPeak > 0 ? marchingSquares(normalized, spatial.continuousCore.thresholdOfPeak) : [];
  const pitchShape = polygonPath(projection, [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }]);
  const markerRefs = useRef(new Map<string, SVGGElement>()), tooltipId = `${filterId}-shot-tooltip`;
  const rendered = usePerspectivePixelScale();
  const [zoom, setZoom] = useState<ZoomLevel>(1), [viewport, setViewport] = useState<Viewport>({ x: 0, y: 0 });
  const pointerPan = useRef<{ pointerId: number; clientX: number; clientY: number; viewport: Viewport } | null>(null);
  const pointerOrbit = useRef<{ pointerId: number; clientX: number; clientY: number; camera: OrbitCamera } | null>(null);
  const touchPoints = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ gap: number; distance: number } | null>(null);
  const resetViewport = () => { pointerPan.current = null; pointerOrbit.current = null; touchPoints.current.clear(); pinch.current = null; setZoom(1); setViewport({ x: 0, y: 0 }); setCamera(DEFAULT_ORBIT_CAMERA); setCameraFrame("attacking"); };
  useEffect(() => { resetViewport(); }, [contextIdentity]);
  const visibleViewport = zoomViewport(zoom);
  const viewBox = perspective ? `0 0 ${BASE_VIEWPORT.width} ${BASE_VIEWPORT.height}` : `${viewport.x} ${viewport.y} ${visibleViewport.width} ${visibleViewport.height}`;
  const pixelScale = rendered.scale / (perspective ? 1 : zoom);
  const setZoomLevel = (next: ZoomLevel) => { setViewport((current) => centeredViewport(current, zoom, next)); setZoom(next); };
  const panBy = (x: number, y: number) => setViewport((current) => clampViewport({ x: current.x + x, y: current.y + y }, zoom));
  const [activeId, setActiveId] = useState<string | null>(null), [tooltipIdState, setTooltipIdState] = useState<string | null>(null);
  // Paint order protects goals visually; keyboard order begins with the first source event.
  const firstGroup = shots.length ? markerGroups.find((group) => group.sourceIndexes.includes(shots[0].sourceIndex)) : undefined;
  const firstId = firstGroup ? `${filterId}-shot-${firstGroup.key}` : null;
  const activeVisibleId = markerGroups.some((group) => `${filterId}-shot-${group.key}` === activeId) ? activeId : firstId;
  const tooltipEntry = markerGroups.find((group) => `${filterId}-shot-${group.key}` === tooltipIdState);
  const navigate = (visibleIndex: number, direction: 1 | -1) => { if (!markerGroups.length) return; const next = markerGroups[(visibleIndex + direction + markerGroups.length) % markerGroups.length]; const id = `${filterId}-shot-${next.key}`; setActiveId(id); setTooltipIdState(id); markerRefs.current.get(id)?.focus(); };
  const visibleGroups = outcomeOrder.filter((outcome) => visibleOutcomes.has(outcome) && spatial?.shotmapPoints.some((shot) => shot.outcome === outcome));
  const endPointer = (event: ReactPointerEvent<SVGSVGElement>) => { touchPoints.current.delete(event.pointerId); pinch.current = null; if (pointerOrbit.current?.pointerId === event.pointerId) pointerOrbit.current = null; if (pointerPan.current?.pointerId === event.pointerId) pointerPan.current = null; if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture?.(event.pointerId); };
  return <><div className="flex flex-wrap items-center gap-2 border-b border-white/10 bg-black/25 px-2 py-2"><div role="group" aria-label={PITCH_VIEW_COPY.cameraFrameGroup} className="flex flex-wrap items-center gap-1">{(["full", "attacking", "box"] as const).map((frame) => <button key={frame} type="button" aria-pressed={cameraFrame === frame} onClick={() => setCameraFrame(frame)} className="min-h-9 rounded border border-white/15 px-2 text-xs font-bold aria-pressed:bg-sky-200 aria-pressed:text-slate-950">{PITCH_VIEW_COPY.cameraFrames[frame]}</button>)}</div><div role="group" aria-label={PITCH_VIEW_COPY.cameraZoomGroup} className="flex items-center gap-1"><button type="button" aria-label="Zoom out" disabled={perspective ? camera.distance >= ORBIT_DISTANCE.maximum : zoom === 1} onClick={() => perspective ? setCamera((current) => ({ ...current, distance: clampDistance(current.distance + ORBIT_DISTANCE.step) })) : setZoomLevel((zoom - 1) as ZoomLevel)} className="min-h-9 min-w-9 rounded border border-white/15 px-2 text-sm font-bold disabled:cursor-not-allowed disabled:opacity-40">−</button><button type="button" aria-label="Zoom in" disabled={perspective ? camera.distance <= ORBIT_DISTANCE.minimum : zoom === 3} onClick={() => perspective ? setCamera((current) => ({ ...current, distance: clampDistance(current.distance - ORBIT_DISTANCE.step) })) : setZoomLevel((zoom + 1) as ZoomLevel)} className="min-h-9 min-w-9 rounded border border-white/15 px-2 text-sm font-bold disabled:cursor-not-allowed disabled:opacity-40">+</button><button type="button" aria-label={PITCH_VIEW_COPY.resetCamera} onClick={resetViewport} className="min-h-9 rounded border border-white/15 px-3 text-xs font-bold">Reset</button></div><p aria-live="polite" className="text-xs text-zinc-300">{perspective ? `Orbit ${camera.azimuth.toFixed(0)}° / ${camera.elevation.toFixed(0)}° / ${camera.distance.toFixed(0)}m` : `Perspective zoom ${zoom}×`}</p></div><svg ref={rendered.ref} viewBox={viewBox} preserveAspectRatio="xMidYMid meet" className="block h-auto w-full rounded-b-lg bg-[#050a08] touch-none" role="img" tabIndex={0} aria-label={`${perspective ? "Perspective" : "Two-dimensional"} attacking pitch with exact 6-depth by 5-lane positional grid. ${heatState}. ${shotState}. Visible shot outcomes: ${outcomeSummary(visibleGroups)}. Outcome controls change markers only.`} data-camera-azimuth={perspective ? camera.azimuth : undefined} data-camera-elevation={perspective ? camera.elevation : undefined} data-camera-distance={perspective ? camera.distance : undefined} data-camera-pivot={perspective ? orbitPivot.join(",") : undefined} data-camera-frame={perspective ? cameraFrame : undefined} onWheel={(event) => { if (!perspective) return; event.preventDefault(); setCamera((current) => ({ ...current, distance: clampDistance(current.distance + event.deltaY * .04) })); }} onPointerDown={(event) => { if (event.defaultPrevented || isInteractivePitchTarget(event.target)) return; if (perspective) { if (event.pointerType === "touch") { touchPoints.current.set(event.pointerId, { x: event.clientX, y: event.clientY }); if (touchPoints.current.size === 2) { const points = [...touchPoints.current.values()]; pinch.current = { gap: Math.hypot(points[1].x - points[0].x, points[1].y - points[0].y), distance: camera.distance }; pointerOrbit.current = null; } else pointerOrbit.current = { pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY, camera }; } else pointerOrbit.current = { pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY, camera }; event.currentTarget.setPointerCapture?.(event.pointerId); return; } if (zoom === 1) return; pointerPan.current = { pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY, viewport }; event.currentTarget.setPointerCapture?.(event.pointerId); }} onPointerMove={(event) => { if (perspective && event.pointerType === "touch" && touchPoints.current.has(event.pointerId)) { touchPoints.current.set(event.pointerId, { x: event.clientX, y: event.clientY }); if (touchPoints.current.size === 2 && pinch.current) { const points = [...touchPoints.current.values()]; const gap = Math.hypot(points[1].x - points[0].x, points[1].y - points[0].y); if (gap > 0) setCamera((current) => ({ ...current, distance: clampDistance(pinch.current!.distance * pinch.current!.gap / gap) })); return; } } const orbit = pointerOrbit.current; if (orbit?.pointerId === event.pointerId) { setCamera({ azimuth: orbit.camera.azimuth - (event.clientX - orbit.clientX) * .22, elevation: Math.max(12, Math.min(65, orbit.camera.elevation + (event.clientY - orbit.clientY) * .18)), distance: orbit.camera.distance }); return; } const start = pointerPan.current; if (!start || start.pointerId !== event.pointerId) return; const bounds = event.currentTarget.getBoundingClientRect(); if (!bounds.width || !bounds.height) return; setViewport(clampViewport({ x: start.viewport.x - (event.clientX - start.clientX) * visibleViewport.width / bounds.width, y: start.viewport.y - (event.clientY - start.clientY) * visibleViewport.height / bounds.height }, zoom)); }} onPointerUp={endPointer} onPointerCancel={endPointer} onLostPointerCapture={() => { pointerPan.current = null; pointerOrbit.current = null; touchPoints.current.clear(); pinch.current = null; }} onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); resetViewport(); return; } if (event.defaultPrevented || event.target !== event.currentTarget || perspective || zoom === 1) return; const step = Math.min(48, visibleViewport.width / 5); if (event.key === "ArrowLeft") { event.preventDefault(); panBy(-step, 0); } else if (event.key === "ArrowRight") { event.preventDefault(); panBy(step, 0); } else if (event.key === "ArrowUp") { event.preventDefault(); panBy(0, -step); } else if (event.key === "ArrowDown") { event.preventDefault(); panBy(0, step); } }}>
    <defs><clipPath id={`${filterId}-pitch-clip`}><path d={pitchShape}/></clipPath><filter id={`${filterId}-display-heat-blur`} x="-12%" y="-18%" width="124%" height="136%" colorInterpolationFilters="sRGB"><feGaussianBlur stdDeviation="9"/></filter><linearGradient id={`${filterId}-grass`} x1="0" y1="0" x2="0" y2="1"><stop stopColor="#123A20"/><stop offset="1" stopColor="#081F15"/></linearGradient></defs>
    <path d={pitchShape} fill={`url(#${filterId}-grass)`} stroke="#143d2f" strokeWidth="9" />
    <GoalFrames projection={geometryProjection}/>
    <HeatLayer mesh={densityMesh} clipId={`${filterId}-pitch-clip`} filterId={`${filterId}-display-heat-blur`} buildCount={meshBuildCount.current}/>
    <PitchMarkings projection={geometryProjection}/>
    <PositionalGrid projection={geometryProjection}/>
    {contour.length > 0 && <g data-layer="cca-contour" fill="none" stroke={CCA_STYLE.stroke} strokeOpacity={CCA_STYLE.opacity} strokeWidth={CCA_STYLE.width} strokeDasharray={CCA_STYLE.dash} vectorEffect="non-scaling-stroke">{contour.map(([x1, y1, x2, y2], index) => <path key={index} d={pathBetween(projection, { x: x1, y: 100 - y1 }, { x: x2, y: 100 - y2 })}/>)}</g>}
    <g id={markerLayerId} data-layer="shots">{markerGroups.map((group, visibleIndex) => { const id = `${filterId}-shot-${group.key}`; return <ShotGlyph key={id} group={group} medianXg={medianXg} projection={projection} geometryProjection={geometryProjection} perspective={perspective} pixelScale={pixelScale} id={id} active={id === activeVisibleId} tooltipId={tooltipId} registerRef={(element) => { if (element) markerRefs.current.set(id, element); else markerRefs.current.delete(id); }} onActivate={(markerId) => { setActiveId(markerId); setTooltipIdState(markerId); }} onDeactivate={(markerId) => { if (tooltipIdState === markerId) setTooltipIdState(null); }} onNavigate={(direction) => navigate(visibleIndex, direction)}/>; })}</g>
    {tooltipEntry && (() => { const anchor = projection(tooltipEntry.shot), tooltipWidth = 150, tooltipHeight = 62; const maxX = Math.max(0, BASE_VIEWPORT.width - tooltipWidth * pixelScale), maxY = Math.max(0, BASE_VIEWPORT.height - tooltipHeight * pixelScale); const x = Math.min(maxX, Math.max(0, anchor.x - 70 * pixelScale)), y = Math.min(maxY, Math.max(0, anchor.y - 82 * pixelScale)); return <g id={tooltipId} role="tooltip" pointerEvents="none" data-tooltip-width={tooltipWidth} data-tooltip-height={tooltipHeight} data-pixel-scale={pixelScale} transform={`translate(${x} ${y}) scale(${pixelScale})`}><rect width={tooltipWidth} height={tooltipHeight} rx="7" fill="#0b0e0f" fillOpacity=".96" stroke="#ffffff" strokeOpacity=".25"/><text x="10" y="18" fill="#f4f4f5" fontSize="12" fontWeight="700">{outcomePresentation[tooltipEntry.shot.outcome].label}</text><text x="10" y="37" fill="#e4e4e7" fontSize="11">xG {formatShotMetric(tooltipEntry.shot.xg)}</text><text x="10" y="53" fill="#e4e4e7" fontSize="11">xGOT {formatShotMetric(tooltipEntry.shot.xgot)}</text></g>; })()}
    <g fill="#e4e4e7" fontSize="13" fontWeight="700" aria-hidden="true"><text x="36" y="630">Attack direction 0 → 100</text><text x="835" y="584">Lane 1 · right</text><text x="194" y="73">Lane 5 · left</text></g>
  </svg></>;
}

export function SpatialPitch({ analysis, contextIdentity = "", forcedMode, embedded = false }: { analysis?: PlayerAnalysis; contextIdentity?: string; forcedMode?: ViewMode; embedded?: boolean }) {
  const reducedMotion = usePrefersReducedMotion();
  const { includePenalties } = usePitchPenalty();
  const [manualMode, setManualMode] = useState<ViewMode | null>(null);
  const mode = forcedMode ?? manualMode ?? (reducedMotion ? "plan" : "perspective");
  const spatial = analysis?.spatial;
  const displaySpatial = useMemo(() => {
    if (!spatial || includePenalties) return spatial;
    const shotmapPoints = [...excludePenaltyShots(spatial.shotmapPoints, false)];
    return { ...spatial, shotmapPoints, shotmapPointCount: shotmapPoints.length };
  }, [includePenalties, spatial]);
  const displayAnalysis = useMemo(() => !analysis || !displaySpatial ? analysis : { ...analysis, spatial: displaySpatial }, [analysis, displaySpatial]);
  const controller = useShotOutcomeVisibility(displaySpatial, contextIdentity);
  const heatValid = Boolean(spatial?.available && spatial.heatmapPointCount === spatial.heatmapPoints.length && spatial.heatmapPoints.every(({ x, y }) => Number.isFinite(x) && Number.isFinite(y) && x >= 0 && x <= 100 && y >= 0 && y <= 100));
  const heatState = !spatial?.available ? "Activity heatmap unavailable" : !heatValid ? "Activity heatmap integrity mismatch" : spatial.heatmapPoints.length ? `${spatial.heatmapPoints.length} activity points` : "Verified zero activity points";
  const shotState = !displaySpatial?.shotmapSnapshotAvailable ? "Shot snapshot unavailable" : !controller.integrity ? "Shot snapshot integrity mismatch" : displaySpatial.shotmapPoints.length ? `${displaySpatial.shotmapPoints.length} shots` : "Verified zero shots";
  const shotSummary = controller.integrity ? summarizeShots(displaySpatial!.shotmapPoints) : null;
  const counts = controller.counts;
  const rawId = useId().replace(/:/g, "");
  const markerLayerId = `spatial-shot-markers-${rawId}`;
  return <section className={embedded ? "min-w-0" : panel} aria-labelledby={embedded ? undefined : `spatial-pitch-${rawId}`} aria-label={embedded ? PITCH_VIEW_COPY[mode] : undefined}>
    {!embedded && <div className="flex flex-wrap items-start justify-between gap-3"><div><h2 id={`spatial-pitch-${rawId}`} className="text-sm font-black">{PITCH_VIEW_COPY[mode]}</h2><p className="mt-1 text-[11px] text-zinc-400">Attack left → right · Lane 1 is the near/right touchline · exact positional-6×5 grid</p></div>{!forcedMode && <div role="group" aria-label="Pitch view" className="flex rounded-lg border border-white/15 bg-black/30 p-1"><button type="button" aria-pressed={mode === "perspective"} onClick={() => setManualMode("perspective")} className="min-h-9 rounded px-3 text-xs font-bold aria-pressed:bg-orange-400 aria-pressed:text-zinc-950 focus-visible:ring-2 focus-visible:ring-orange-200">{PITCH_VIEW_COPY.perspective}</button><button type="button" aria-pressed={mode === "plan"} onClick={() => setManualMode("plan")} className="min-h-9 rounded px-3 text-xs font-bold aria-pressed:bg-orange-400 aria-pressed:text-zinc-950 focus-visible:ring-2 focus-visible:ring-orange-200">{PITCH_VIEW_COPY.plan}</button></div>}</div>}
    {reducedMotion && manualMode === null && <p className="mt-2 text-xs text-zinc-400">Reduced-motion preference detected; the 2D plan fallback is active.</p>}
    {controller.integrity && controller.presentOutcomes.length > 0 && <OutcomeControls outcomes={controller.presentOutcomes} counts={controller.counts} visible={controller.visibleOutcomes} markerLayerId={markerLayerId} onClick={controller.onClick} onDoubleClick={controller.onDoubleClick}/>}<p role="status" aria-live="polite" className="sr-only">Visible shot outcomes: {outcomeSummary(controller.presentOutcomes.filter((outcome) => controller.visibleOutcomes.has(outcome)))}.</p>
    <div className="mt-3 min-w-0 overflow-hidden rounded-lg border border-white/10">{mode === "plan" ? <LegacySpatialPitchFigure analysis={displayAnalysis} visibleOutcomes={controller.visibleOutcomes} markerLayerId={markerLayerId} showCounts={false}/> : <figure><PitchSvg spatial={displaySpatial} mode={mode} filterId={`spatial-heat-${rawId}`} visibleOutcomes={controller.visibleOutcomes} markerLayerId={markerLayerId} contextIdentity={contextIdentity}/><figcaption className="border-t border-white/10 bg-black/25 px-3 py-2 text-xs text-zinc-300">{heatState}. {shotState}. The exact legacy density mesh, the authoritative CCA contour, and shot anchors share the server 0–100 coordinate transform; outcome controls affect markers only.</figcaption></figure>}</div>
    <div className="mt-3 grid gap-2 text-xs text-zinc-400 sm:grid-cols-2"><p aria-live="polite">{heatState}. Thirty tactical cells are visual guides; no browser-side score or zone value is calculated.</p><p aria-live="polite">{shotState}. Unavailable and available-with-zero are kept distinct.</p></div>
    {controller.integrity ? <><p data-pitch-shot-summary className="mt-2 text-xs text-zinc-300">{penaltyStateLabel(includePenalties)} · 슛 {shotSummary!.shots} · 득점 {shotSummary!.goals} · xG {shotSummary!.xg.toFixed(2)} · 전환율 {shotSummary!.conversionRatePct?.toFixed(1) ?? "—"}%</p><ul aria-label="Shot outcome legend" className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-zinc-300"><li>◇ Goals {counts.goal}</li><li>● On target {counts.on_target}</li><li>× Off target {counts.off_target}</li><li>■ Blocked {counts.blocked}</li></ul></> : <p className="mt-2 text-xs text-zinc-500">Outcome totals are unavailable because no valid shot snapshot exists for this context.</p>}
    <details className="mt-3 rounded-lg border border-white/10 bg-black/20 text-xs text-zinc-300"><summary className="min-h-11 cursor-pointer px-3 py-3 font-bold focus-visible:ring-2 focus-visible:ring-orange-200">Pitch and shot details</summary><div className="border-t border-white/10 p-3"><p>The perspective view uses the same segmented positional-play grid and source-coordinate direction as the 2D legacy pitch.</p>{!controller.integrity ? <p className="mt-3">Shot event details unavailable.</p> : displaySpatial!.shotmapPoints.length === 0 ? <p className="mt-3">Verified zero shot events.</p> : <ol aria-label="Authoritative shot events" className="mt-3 max-h-48 space-y-1 overflow-y-auto pr-1">{displaySpatial!.shotmapPoints.map((shot, index) => <li key={index} className="rounded bg-white/5 px-2 py-1">{index + 1}. {outcomeLabel[shot.outcome]} · xG {shot.xg == null ? "unavailable" : shot.xg.toFixed(2)} · xGOT {shot.xgot == null ? "unavailable" : shot.xgot.toFixed(2)} · ({shot.x.toFixed(1)}, {shot.y.toFixed(1)}){shot.trajectory ? ` · ${shot.trajectory.endpointKind === "goal_mouth" ? "goal-mouth" : "blocked"} trajectory to (${shot.trajectory.endX.toFixed(1)}, ${shot.trajectory.endY.toFixed(1)})${shot.trajectory.endpointKind === "goal_mouth" ? ` at ${shot.trajectory.endZMeters == null ? "unknown height" : `${shot.trajectory.endZMeters.toFixed(2)} m`}` : ""}` : " · trajectory unavailable"}</li>)}</ol>}</div></details>
  </section>;
}
