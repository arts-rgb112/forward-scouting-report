import { useEffect, useId, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

import type { PlayerAnalysis, ShotmapPoint } from "../dashboard/types";
import { LegacySpatialPitchFigure } from "./LegacySpatialPitch";
import { DISPLAY_HEATMAP_COLUMNS, DISPLAY_HEATMAP_ROWS, HEATMAP_COLUMNS, HEATMAP_OPACITY, HEATMAP_ROWS, displayDensityGrid, displayHeatmapColor, legacyDensityGrid, marchingSquares, normalizeDensity } from "./legacyHeatmap";
import { groupPitchShots, medianObservedXg, pitchMarkerRadius, PitchShotMarker, type PitchShotGroup } from "./PitchShotMarker";
import { DEFAULT_PITCH_LAYERS, type PitchLayerVisibility } from "./pitchLayers";
import { usePitchPenalty } from "./PitchPenaltyContext";
import { excludePenaltyShots } from "./pitchPenalties";
import { CCA_STYLE, PATH_STYLE, TACTICS_BOARD_CAMERA, goalFrame, orbitCamera, pitchMarkings, shotFlight, zone20Lines, type Projection as GeometryProjection, type Vec3 } from "./pitchGeometry";
import { formatShotMetric, outcomeOrder, outcomePresentation, outcomeSummary, OutcomeControls, shotIntegrity, shotMarkerLabel, type ShotOutcome, useShotOutcomeVisibility } from "./shotOutcomeVisibility";

const panel = "min-w-0 rounded-xl border border-white/10 bg-[#101415] p-4 shadow-sm";
const PITCH_VIEW_COPY = {
  perspective: "3D 회랑",
  plan: "2D 회랑",
  cameraAngleGroup: "카메라 각도 프리셋",
  cameraZoomGroup: "화면 배율 조절",
  resetCamera: "기본 시점",
  anglePresets: { left: "좌측", right: "우측", goalFront: "골대 정면", goalBack: "골대 뒤" },
  outsideShots: (count: number) => `화면 밖 ${count}발`,
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
type CameraAngle = "left" | "right" | "goalFront" | "goalBack";
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
const PERSPECTIVE_ZOOM = { minimum: 1, maximum: 3, step: .25 } as const;
const CAMERA_ANGLE_PRESETS: Record<CameraAngle, Pick<OrbitCamera, "azimuth" | "elevation">> = {
  left: { azimuth: 90, elevation: 30 }, right: { azimuth: 270, elevation: 30 }, goalFront: { azimuth: 180, elevation: 27 }, goalBack: { azimuth: 0, elevation: 27 },
};
const END_ON_ANGLES = new Set<CameraAngle>(["goalFront", "goalBack"]);

const clamp = (value: number) => Math.min(100, Math.max(0, value));
const clampPerspectiveZoom = (value: number) => Math.min(PERSPECTIVE_ZOOM.maximum, Math.max(PERSPECTIVE_ZOOM.minimum, value));

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

/** Server-provided positional-grid values only; this is a label layer, never a browser aggregation. */
type OccupancyCell = { depth: number; lane: number; occupancyPct: number };
type ZoneShotSummary = { shots: number; goals: number; xg: number; shotSharePct: number };
type HoveredZone = { cell: OccupancyCell; summary: ZoneShotSummary };

function zoneShotSummary(shots: readonly ShotmapPoint[], cell: OccupancyCell): ZoneShotSummary {
  const x0 = POSITIONAL_DEPTH_BOUNDARIES[cell.depth], x1 = POSITIONAL_DEPTH_BOUNDARIES[cell.depth + 1];
  const y0 = POSITIONAL_LANE_BOUNDARIES[cell.lane], y1 = POSITIONAL_LANE_BOUNDARIES[cell.lane + 1];
  const inCell = shots.filter((shot) => shot.x >= x0 && (cell.depth === POSITIONAL_DEPTH_BOUNDARIES.length - 2 ? shot.x <= x1 : shot.x < x1) && shot.y >= y0 && (cell.lane === POSITIONAL_LANE_BOUNDARIES.length - 2 ? shot.y <= y1 : shot.y < y1));
  return { shots: inCell.length, goals: inCell.filter((shot) => shot.outcome === "goal").length, xg: inCell.reduce((total, shot) => total + (typeof shot.xg === "number" && Number.isFinite(shot.xg) ? shot.xg : 0), 0), shotSharePct: shots.length ? inCell.length / shots.length * 100 : 0 };
}

function PositionalOccupancyLabels({ cells, shots, projection, onHover }: { cells: readonly OccupancyCell[]; shots: readonly ShotmapPoint[]; projection: GeometryProjection; onHover(zone: HoveredZone | null): void }) {
  const valid = cells.filter((cell) => Number.isInteger(cell.depth) && cell.depth >= 0 && cell.depth < 6 && Number.isInteger(cell.lane) && cell.lane >= 0 && cell.lane < 5 && Number.isFinite(cell.occupancyPct));
  if (!valid.length) return null;
  return <g data-layer="positional-occupancy-labels" fill="#F8FAFC" fontSize="14" fontWeight="800" textAnchor="middle">
    {valid.map((cell) => {
      const x = (POSITIONAL_DEPTH_BOUNDARIES[cell.depth] + POSITIONAL_DEPTH_BOUNDARIES[cell.depth + 1]) / 2;
      const y = (POSITIONAL_LANE_BOUNDARIES[cell.lane] + POSITIONAL_LANE_BOUNDARIES[cell.lane + 1]) / 2;
      const point = projection.pp(y, x);
      const summary = zoneShotSummary(shots, cell);
      if (summary.shots === 0) return null;
      return <text key={`${cell.depth}-${cell.lane}`} data-zone-shot-share={summary.shotSharePct.toFixed(2)} x={point[0]} y={point[1]} stroke="#0A1F10" strokeWidth="3" paintOrder="stroke" pointerEvents="all" onPointerEnter={() => onHover({ cell, summary })} onPointerLeave={() => onHover(null)}>{summary.shotSharePct.toFixed(2)}%</text>;
    })}
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

const outcomeLabel: Record<ShotmapPoint["outcome"], string> = { goal: "득점", on_target: "유효 슛", off_target: "빗나감", blocked: "블록" };

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

const zoomViewport = (zoom: number) => ({ width: BASE_VIEWPORT.width / zoom, height: BASE_VIEWPORT.height / zoom });
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

function ShotGlyph({ group, medianXg, projection, geometryProjection, perspective, showTrajectory, showMarker, pixelScale, id, active, tooltipId, registerRef, onActivate, onDeactivate, onNavigate }: {
  group: PitchShotGroup; medianXg: number | null; projection: Projection; geometryProjection: GeometryProjection; perspective: boolean; showTrajectory: boolean; showMarker: boolean; pixelScale: number; id: string; active: boolean; tooltipId: string;
  registerRef(element: SVGGElement | null): void; onActivate(id: string): void; onDeactivate(id: string): void; onNavigate(direction: 1 | -1): void;
}) {
  const { shot } = group;
  const anchor = projection(shot);
  const markerRadius = pitchMarkerRadius(shot.xg, medianXg);
  const markerY = anchor.y;
  // A blocked endpoint is not a goal-line trajectory and must never be drawn.
  const trajectory = perspective && showTrajectory && shot.trajectory?.endpointKind === "goal_mouth" ? shot.trajectory : null;
  const flight = trajectory ? shotFlight(geometryProjection, { x: shot.x, y: shot.y, endY: trajectory.endY, endZMeters: trajectory.endZMeters }) : null;
  const trajectoryStyle = {
    goal: { color: "#BEF264", opacity: .9, width: 2.6 },
    on_target: { color: "#38BDF8", opacity: .6, width: 1.9 },
    off_target: { color: "#E2E8F0", opacity: .16, width: 1.2 },
    blocked: { color: "#94A3B8", opacity: 0, width: 0 },
  }[group.outcome];
  return <g ref={registerRef} id={id} role={showMarker ? "img" : undefined} tabIndex={showMarker && active ? 0 : -1} aria-label={showMarker ? `${shotMarkerLabel(shot)}${group.count > 1 ? ` ${group.count} shots share this exact coordinate. Stack: ${group.outcomeCounts.goal} goals, ${group.outcomeCounts.on_target} on target, ${group.outcomeCounts.off_target} off target, ${group.outcomeCounts.blocked} blocked.` : ""}` : undefined} aria-describedby={showMarker ? tooltipId : undefined} data-shot-marker={showMarker ? "" : undefined} data-shot-index={showMarker ? group.sourceIndexes[0] : undefined} data-shot-indexes={showMarker ? group.sourceIndexes.join(",") : undefined} data-shot-outcome={group.outcome} data-marker-symbol={showMarker ? outcomePresentation[group.outcome].symbol : undefined} data-marker-size={showMarker ? markerRadius * 2 : undefined} data-marker-count={showMarker ? group.count : undefined} data-pitch-x={shot.x} data-pitch-y={shot.y} data-screen-x={anchor.x} data-screen-y={anchor.y} className={showMarker ? "cursor-help" : undefined} onFocus={() => showMarker && onActivate(id)} onPointerEnter={() => showMarker && onActivate(id)} onPointerLeave={(event) => { if (showMarker && document.activeElement !== event.currentTarget) onDeactivate(id); }} onKeyDown={(event) => { if (!showMarker) return; if (event.key === "ArrowRight" || event.key === "ArrowDown") { event.preventDefault(); onNavigate(1); } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") { event.preventDefault(); onNavigate(-1); } }}>
    <title>{shotMarkerLabel(shot)}</title>
    {trajectory && flight && <g data-shot-trajectory data-trajectory-kind={trajectory.endpointKind} data-trajectory-outcome={group.outcome} data-end-pitch-x={trajectory.endX} data-end-pitch-y={trajectory.endY} data-end-goal-mouth={trajectory.endY >= GOAL_POST_Y[0] && trajectory.endY <= GOAL_POST_Y[1] ? "inside" : "outside"} data-end-height-meters={trajectory.endZMeters ?? undefined} data-end-render-x={flight.landing[0]} data-end-render-y={flight.landing[1]} fill="none" pointerEvents="none">{flight.arc.map((d, index) => { const progress = (index + 1) / flight.arc.length; return <path key={index} d={d} stroke={trajectoryStyle.color} strokeOpacity={trajectoryStyle.opacity * (.95 - .5 * progress)} strokeWidth={trajectoryStyle.width * (1 - .5 * progress)} strokeLinecap="round" vectorEffect="non-scaling-stroke"/>; })}</g>}
    {showMarker && <g data-marker-visual data-pixel-scale={pixelScale} transform={`translate(${anchor.x} ${markerY}) scale(${pixelScale})`}><PitchShotMarker outcome={group.outcome} radius={markerRadius} count={group.count} outcomeCounts={group.outcomeCounts} expandedStack={tooltipId === id}/><circle data-marker-hit r="12" fill="transparent" pointerEvents="all" /></g>}
  </g>;
}

export function createOrbitProjection(camera: OrbitCamera, frameFromX = 0): Projection {
  const projection = orbitCamera({ ...TACTICS_BOARD_CAMERA, azimuth: camera.azimuth, elevation: camera.elevation, radius: camera.distance, frameFromX, width: BASE_VIEWPORT.width, height: BASE_VIEWPORT.height });
  return (point) => { const [x, y] = projection.pp(point.y, point.x); return { x, y }; };
}

function PitchSvg({ spatial, mode, filterId, visibleOutcomes, markerLayerId, contextIdentity, layers }: { spatial: PlayerAnalysis["spatial"] | undefined; mode: ViewMode; filterId: string; visibleOutcomes: ReadonlySet<ShotOutcome>; markerLayerId: string; contextIdentity: string; layers: PitchLayerVisibility }) {
  const perspective = mode === "perspective";
  const [camera, setCamera] = useState<OrbitCamera>(DEFAULT_ORBIT_CAMERA);
  const [cameraAngleState, setCameraAngle] = useState<CameraAngle | null>(null);
  const [perspectiveZoom, setPerspectiveZoom] = useState(1);
  const [hoveredZone, setHoveredZone] = useState<HoveredZone | null>(null);
  const heatValid = Boolean(spatial?.available && spatial.heatmapPointCount === spatial.heatmapPoints.length && spatial.heatmapPoints.every(({ x, y }) => Number.isFinite(x) && Number.isFinite(y) && x >= 0 && x <= 100 && y >= 0 && y <= 100));
  const heat = heatValid ? spatial!.heatmapPoints : EMPTY_HEAT;
  const shotsValid = shotIntegrity(spatial);
  const shots = shotsValid ? spatial!.shotmapPoints.map((shot, sourceIndex) => ({ shot, sourceIndex })).filter(({ shot }) => visibleOutcomes.has(shot.outcome)) : [];
  const endOnFrame = perspective && cameraAngleState != null && END_ON_ANGLES.has(cameraAngleState);
  const framedShots = endOnFrame ? shots.filter(({ shot }) => shot.x >= 50) : shots;
  const offscreenShotCount = shots.length - framedShots.length;
  const medianXg = shotsValid ? medianObservedXg(spatial!.shotmapPoints) : null;
  const markerGroups = groupPitchShots(framedShots);
  const heatState = !spatial?.available ? "활동 히트맵 사용 불가" : !heatValid ? "활동 히트맵 무결성 불일치" : heat.length ? `활동 좌표 ${heat.length}개` : "관측된 활동 좌표 0개";
  const shotState = !spatial?.shotmapSnapshotAvailable ? "슈팅 스냅샷 사용 불가" : !shotsValid ? "슈팅 스냅샷 무결성 불일치" : spatial.shotmapPoints.length ? `슛 ${spatial.shotmapPoints.length}개` : "관측된 슛 0개";
  const normalized = useMemo(() => normalizeDensity(legacyDensityGrid(heat)), [heat]);
  const orbitPivot = useMemo(() => deriveOrbitPivot(spatial, normalized), [normalized, spatial]);
  const containedFrame = cameraAngleState === "left" || cameraAngleState === "right" || cameraAngleState === "goalBack";
  const geometryProjection = useMemo(() => orbitCamera({ ...TACTICS_BOARD_CAMERA, pivot: orbitPivot, azimuth: camera.azimuth, elevation: camera.elevation, radius: camera.distance, frameFromX: endOnFrame ? 50 : 0, fit: containedFrame ? "contain" : "cover", width: BASE_VIEWPORT.width, height: BASE_VIEWPORT.height }), [camera, containedFrame, endOnFrame, orbitPivot]);
  const projection = useMemo(() => perspective ? ((point: PitchPoint) => { const [x, y] = geometryProjection.pp(point.y, point.x); return { x, y }; }) : projectPlan, [geometryProjection, perspective]);
  const displayDensity = useMemo(() => displayDensityGrid(normalized), [normalized]);
  const meshBuildCount = useRef(0);
  const densityMesh = useMemo(() => { meshBuildCount.current += 1; return prepareDensityMesh(displayDensity, projection); }, [displayDensity, projection]);
  const contour = heatValid && spatial?.continuousCore.available && spatial.continuousCore.gridColumns === HEATMAP_COLUMNS && spatial.continuousCore.gridRows === HEATMAP_ROWS && Number.isFinite(spatial.continuousCore.thresholdOfPeak) && spatial.continuousCore.thresholdOfPeak > 0 ? marchingSquares(normalized, spatial.continuousCore.thresholdOfPeak) : [];
  // Never crop terrain before projection: close/low camera views still retain
  // the whole turf, while the SVG viewport supplies ordinary screen zoom.
  const pitchShape = polygonPath(projection, [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }]);
  const markerRefs = useRef(new Map<string, SVGGElement>()), tooltipId = `${filterId}-shot-tooltip`;
  const rendered = usePerspectivePixelScale();
  const [zoom, setZoom] = useState<ZoomLevel>(1), [viewport, setViewport] = useState<Viewport>({ x: 0, y: 0 });
  const cameraAngle = cameraAngleState && Math.abs(camera.azimuth - CAMERA_ANGLE_PRESETS[cameraAngleState].azimuth) < .01 && Math.abs(camera.elevation - CAMERA_ANGLE_PRESETS[cameraAngleState].elevation) < .01 ? cameraAngleState : null;
  const pointerPan = useRef<{ pointerId: number; clientX: number; clientY: number; viewport: Viewport } | null>(null);
  const pointerOrbit = useRef<{ pointerId: number; clientX: number; clientY: number; camera: OrbitCamera } | null>(null);
  const touchPoints = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ gap: number; zoom: number } | null>(null);
  const resetViewport = () => { pointerPan.current = null; pointerOrbit.current = null; touchPoints.current.clear(); pinch.current = null; setZoom(1); setPerspectiveZoom(1); setViewport({ x: 0, y: 0 }); setCamera(DEFAULT_ORBIT_CAMERA); setCameraAngle(null); };
  useEffect(() => { resetViewport(); }, [contextIdentity]);
  const visibleViewport = zoomViewport(zoom);
  const perspectiveViewport = zoomViewport(perspectiveZoom);
  const perspectiveOrigin = { x: (BASE_VIEWPORT.width - perspectiveViewport.width) / 2, y: (BASE_VIEWPORT.height - perspectiveViewport.height) / 2 };
  const viewBox = perspective ? `${perspectiveOrigin.x} ${perspectiveOrigin.y} ${perspectiveViewport.width} ${perspectiveViewport.height}` : `${viewport.x} ${viewport.y} ${visibleViewport.width} ${visibleViewport.height}`;
  const pixelScale = rendered.scale / (perspective ? perspectiveZoom : zoom);
  const attackingGoalGround = [geometryProjection.pp(GOAL_POST_Y[0], 100), geometryProjection.pp(GOAL_POST_Y[1], 100)] as const;
  const attackingGoalTop = geometryProjection.pp(GOAL_POST_Y[0], 100, GOAL_CROSSBAR_HEIGHT_METERS);
  const attackingGoalWidthPct = Math.hypot(attackingGoalGround[1][0] - attackingGoalGround[0][0], attackingGoalGround[1][1] - attackingGoalGround[0][1]) / perspectiveViewport.width * 100;
  const attackingGoalHeightPct = Math.hypot(attackingGoalTop[0] - attackingGoalGround[0][0], attackingGoalTop[1] - attackingGoalGround[0][1]) / perspectiveViewport.height * 100;
  const setZoomLevel = (next: ZoomLevel) => { setViewport((current) => centeredViewport(current, zoom, next)); setZoom(next); };
  const panBy = (x: number, y: number) => setViewport((current) => clampViewport({ x: current.x + x, y: current.y + y }, zoom));
  const [activeId, setActiveId] = useState<string | null>(null), [tooltipIdState, setTooltipIdState] = useState<string | null>(null);
  // Paint order protects goals visually; keyboard order begins with the first source event.
  const firstGroup = framedShots.length ? markerGroups.find((group) => group.sourceIndexes.includes(framedShots[0].sourceIndex)) : undefined;
  const firstId = firstGroup ? `${filterId}-shot-${firstGroup.key}` : null;
  const activeVisibleId = markerGroups.some((group) => `${filterId}-shot-${group.key}` === activeId) ? activeId : firstId;
  const tooltipEntry = markerGroups.find((group) => `${filterId}-shot-${group.key}` === tooltipIdState);
  const navigate = (visibleIndex: number, direction: 1 | -1) => { if (!markerGroups.length) return; const next = markerGroups[(visibleIndex + direction + markerGroups.length) % markerGroups.length]; const id = `${filterId}-shot-${next.key}`; setActiveId(id); setTooltipIdState(id); markerRefs.current.get(id)?.focus(); };
  const visibleGroups = outcomeOrder.filter((outcome) => visibleOutcomes.has(outcome) && spatial?.shotmapPoints.some((shot) => shot.outcome === outcome));
  const endPointer = (event: ReactPointerEvent<SVGSVGElement>) => { touchPoints.current.delete(event.pointerId); pinch.current = null; if (pointerOrbit.current?.pointerId === event.pointerId) pointerOrbit.current = null; if (pointerPan.current?.pointerId === event.pointerId) pointerPan.current = null; if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture?.(event.pointerId); };
  useEffect(() => {
    const element = rendered.ref.current;
    if (!perspective || !element) return;
    const handleWheel = (event: WheelEvent) => { event.preventDefault(); setPerspectiveZoom((current) => clampPerspectiveZoom(current * Math.exp(-event.deltaY * .0015))); };
    element.addEventListener("wheel", handleWheel, { passive: false });
    return () => element.removeEventListener("wheel", handleWheel);
  }, [perspective, rendered.ref]);
  const chooseAngle = (angle: CameraAngle) => { const preset = CAMERA_ANGLE_PRESETS[angle]; setCameraAngle(angle); setPerspectiveZoom(1); setCamera((current) => ({ ...current, ...preset })); };
  return <><div className="space-y-2 border-b border-white/10 bg-black/25 px-2 py-2"><div role="group" aria-label={PITCH_VIEW_COPY.cameraAngleGroup} className="flex flex-wrap items-center gap-1">{(Object.keys(CAMERA_ANGLE_PRESETS) as CameraAngle[]).map((angle) => <button key={angle} type="button" data-camera-preset={angle} aria-pressed={cameraAngle === angle} onClick={() => chooseAngle(angle)} className="min-h-9 rounded border border-white/15 px-3 text-base font-bold aria-pressed:bg-lime-300 aria-pressed:text-slate-950">{PITCH_VIEW_COPY.anglePresets[angle]}</button>)}</div><div className="flex flex-wrap items-center gap-2"><div role="group" aria-label={PITCH_VIEW_COPY.cameraZoomGroup} className="flex items-center gap-1"><button type="button" aria-label="축소" disabled={perspective ? perspectiveZoom <= PERSPECTIVE_ZOOM.minimum : zoom === 1} onClick={() => perspective ? setPerspectiveZoom((current) => clampPerspectiveZoom(current - PERSPECTIVE_ZOOM.step)) : setZoomLevel((zoom - 1) as ZoomLevel)} className="min-h-9 min-w-9 rounded border border-white/15 px-2 font-bold disabled:opacity-40">−</button><button type="button" aria-label="확대" disabled={perspective ? perspectiveZoom >= PERSPECTIVE_ZOOM.maximum : zoom === 3} onClick={() => perspective ? setPerspectiveZoom((current) => clampPerspectiveZoom(current + PERSPECTIVE_ZOOM.step)) : setZoomLevel((zoom + 1) as ZoomLevel)} className="min-h-9 min-w-9 rounded border border-white/15 px-2 font-bold disabled:opacity-40">+</button><button type="button" aria-label={PITCH_VIEW_COPY.resetCamera} onClick={resetViewport} className="min-h-9 rounded border border-white/15 px-3 text-base font-bold">초기화</button></div><p aria-live="polite" className="text-base text-zinc-300">{perspective ? `${camera.azimuth.toFixed(0)}° · ${camera.elevation.toFixed(0)}° · ${perspectiveZoom.toFixed(2)}배` : `${zoom}배`}</p>{perspective && endOnFrame && <p data-offscreen-shot-count={offscreenShotCount} className="rounded border border-amber-300/35 bg-amber-300/10 px-2 py-1 text-base font-bold text-amber-100">{PITCH_VIEW_COPY.outsideShots(offscreenShotCount)}</p>}</div></div><svg ref={rendered.ref} viewBox={viewBox} preserveAspectRatio="xMidYMid meet" className="block h-auto w-full rounded-b-lg bg-[#050a08] touch-none" role="img" tabIndex={0} aria-label={`${perspective ? "3D" : "2D"} 회랑. ${heatState}. ${shotState}.`} data-camera-azimuth={perspective ? camera.azimuth : undefined} data-camera-elevation={perspective ? camera.elevation : undefined} data-camera-distance={perspective ? camera.distance : undefined} data-camera-zoom={perspective ? perspectiveZoom : undefined} data-camera-frame-from-x={perspective ? (endOnFrame ? 50 : 0) : undefined} data-visible-shot-count={perspective ? framedShots.length : undefined} data-total-shot-count={perspective ? shots.length : undefined} data-attacking-goal-width-pct={perspective ? attackingGoalWidthPct.toFixed(2) : undefined} data-attacking-goal-height-pct={perspective ? attackingGoalHeightPct.toFixed(2) : undefined} data-camera-pivot={perspective ? orbitPivot.join(",") : undefined} onPointerDown={(event) => { if (event.defaultPrevented || isInteractivePitchTarget(event.target)) return; if (perspective) { if (event.pointerType === "touch") { touchPoints.current.set(event.pointerId, { x: event.clientX, y: event.clientY }); if (touchPoints.current.size === 2) { const points = [...touchPoints.current.values()]; pinch.current = { gap: Math.hypot(points[1].x - points[0].x, points[1].y - points[0].y), zoom: perspectiveZoom }; pointerOrbit.current = null; } else pointerOrbit.current = { pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY, camera }; } else pointerOrbit.current = { pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY, camera }; event.currentTarget.setPointerCapture?.(event.pointerId); return; } if (zoom === 1) return; pointerPan.current = { pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY, viewport }; event.currentTarget.setPointerCapture?.(event.pointerId); }} onPointerMove={(event) => { if (perspective && event.pointerType === "touch" && touchPoints.current.has(event.pointerId)) { touchPoints.current.set(event.pointerId, { x: event.clientX, y: event.clientY }); if (touchPoints.current.size === 2 && pinch.current) { const points = [...touchPoints.current.values()]; const gap = Math.hypot(points[1].x - points[0].x, points[1].y - points[0].y); if (gap > 0) setPerspectiveZoom(clampPerspectiveZoom(pinch.current.zoom * gap / pinch.current.gap)); return; } } const orbit = pointerOrbit.current; if (orbit?.pointerId === event.pointerId) { setCameraAngle(null); setCamera({ azimuth: orbit.camera.azimuth - (event.clientX - orbit.clientX) * .22, elevation: Math.max(12, Math.min(65, orbit.camera.elevation + (event.clientY - orbit.clientY) * .18)), distance: orbit.camera.distance }); return; } const start = pointerPan.current; if (!start || start.pointerId !== event.pointerId) return; const bounds = event.currentTarget.getBoundingClientRect(); if (!bounds.width || !bounds.height) return; setViewport(clampViewport({ x: start.viewport.x - (event.clientX - start.clientX) * visibleViewport.width / bounds.width, y: start.viewport.y - (event.clientY - start.clientY) * visibleViewport.height / bounds.height }, zoom)); }} onPointerUp={endPointer} onPointerCancel={endPointer} onLostPointerCapture={() => { pointerPan.current = null; pointerOrbit.current = null; touchPoints.current.clear(); pinch.current = null; }} onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); resetViewport(); return; } if (event.defaultPrevented || event.target !== event.currentTarget || perspective || zoom === 1) return; const step = Math.min(48, visibleViewport.width / 5); if (event.key === "ArrowLeft") { event.preventDefault(); panBy(-step, 0); } else if (event.key === "ArrowRight") { event.preventDefault(); panBy(step, 0); } else if (event.key === "ArrowUp") { event.preventDefault(); panBy(0, -step); } else if (event.key === "ArrowDown") { event.preventDefault(); panBy(0, step); } }}>
    <defs><clipPath id={`${filterId}-pitch-clip`}><rect x="0" y="0" width={BASE_VIEWPORT.width} height={BASE_VIEWPORT.height}/></clipPath><filter id={`${filterId}-display-heat-blur`} x="-12%" y="-18%" width="124%" height="136%" colorInterpolationFilters="sRGB"><feGaussianBlur stdDeviation="9"/></filter><linearGradient id={`${filterId}-grass`} x1="0" y1="0" x2="0" y2="1"><stop stopColor="#123A20"/><stop offset="1" stopColor="#081F15"/></linearGradient></defs>
    <rect data-full-turf-matte x="0" y="0" width={BASE_VIEWPORT.width} height={BASE_VIEWPORT.height} fill={`url(#${filterId}-grass)`} />
    <path data-terrain-full="true" d={pitchShape} fill={`url(#${filterId}-grass)`} stroke="#143d2f" strokeWidth="9" />
    <GoalFrames projection={geometryProjection}/>
    {layers.heatmap && <HeatLayer mesh={densityMesh} clipId={`${filterId}-pitch-clip`} filterId={`${filterId}-display-heat-blur`} buildCount={meshBuildCount.current}/>}
    <PitchMarkings projection={geometryProjection}/>
    <PositionalGrid projection={geometryProjection}/>
    {perspective && (() => { const start = geometryProjection.pp(50, 84.29), end = geometryProjection.pp(50, 100); return <path data-layer="corridor-box-split" d={`M${start[0]} ${start[1]}L${end[0]} ${end[1]}`} fill="none" stroke={PATH_STYLE["zone-grid"].stroke} strokeOpacity={PATH_STYLE["zone-grid"].opacity} strokeWidth={PATH_STYLE["zone-grid"].width} vectorEffect="non-scaling-stroke"/>; })()}
    {perspective && <PositionalOccupancyLabels cells={spatial?.positionalGrid ?? []} shots={shotsValid ? spatial!.shotmapPoints : []} projection={geometryProjection} onHover={setHoveredZone}/>}
    {perspective && (() => { const zone = hoveredZone; if (!zone) return null; const { cell, summary } = zone; const x = (POSITIONAL_DEPTH_BOUNDARIES[cell.depth] + POSITIONAL_DEPTH_BOUNDARIES[cell.depth + 1]) / 2, y = (POSITIONAL_LANE_BOUNDARIES[cell.lane] + POSITIONAL_LANE_BOUNDARIES[cell.lane + 1]) / 2; const anchor = geometryProjection.pp(y, x); const label = cell.depth * 5 + cell.lane + 1; return <g data-zone-tooltip role="tooltip" pointerEvents="none" transform={`translate(${Math.max(12, anchor[0] - 78)} ${Math.max(12, anchor[1] - 72)})`}><rect width="178" height="84" rx="7" fill="#0b0e0f" fillOpacity=".96" stroke="#ffffff" strokeOpacity=".25"/><text x="10" y="18" fill="#f8fafc" fontSize="14" fontWeight="800">구역 {label} · 깊이 {cell.depth + 1}, 레인 {cell.lane + 1}</text><text x="10" y="37" fill="#e4e4e7" fontSize="12">슈팅 비중 {summary.shotSharePct.toFixed(2)}% · 활동 {cell.occupancyPct.toFixed(2)}%</text><text x="10" y="56" fill="#e4e4e7" fontSize="12">슛 {summary.shots} · 득점 {summary.goals} · xG {summary.xg.toFixed(2)}</text><text x="10" y="74" fill="#a1a1aa" fontSize="12">숫자는 전체 슛 중 비중</text></g>; })()}
    {layers.cca && contour.length > 0 && <g data-layer="cca-contour" fill="none" stroke={CCA_STYLE.stroke} strokeOpacity={CCA_STYLE.opacity} strokeWidth={CCA_STYLE.width} strokeDasharray={CCA_STYLE.dash} vectorEffect="non-scaling-stroke">{contour.map(([x1, y1, x2, y2], index) => <path key={index} d={pathBetween(projection, { x: x1, y: 100 - y1 }, { x: x2, y: 100 - y2 })}/>)}</g>}
    {(layers.markers || layers.trajectories) && <g id={markerLayerId} data-layer="shots">{markerGroups.map((group, visibleIndex) => { const id = `${filterId}-shot-${group.key}`; return <ShotGlyph key={id} group={group} medianXg={medianXg} projection={projection} geometryProjection={geometryProjection} perspective={perspective} showTrajectory={layers.trajectories} showMarker={layers.markers} pixelScale={pixelScale} id={id} active={id === activeVisibleId} tooltipId={tooltipId} registerRef={(element) => { if (element) markerRefs.current.set(id, element); else markerRefs.current.delete(id); }} onActivate={(markerId) => { setActiveId(markerId); setTooltipIdState(markerId); }} onDeactivate={(markerId) => { if (tooltipIdState === markerId) setTooltipIdState(null); }} onNavigate={(direction) => navigate(visibleIndex, direction)}/>; })}</g>}
    {layers.markers && tooltipEntry && (() => { const anchor = projection(tooltipEntry.shot), tooltipWidth = 150, tooltipHeight = 62; const maxX = Math.max(0, BASE_VIEWPORT.width - tooltipWidth * pixelScale), maxY = Math.max(0, BASE_VIEWPORT.height - tooltipHeight * pixelScale); const x = Math.min(maxX, Math.max(0, anchor.x - 70 * pixelScale)), y = Math.min(maxY, Math.max(0, anchor.y - 82 * pixelScale)); return <g id={tooltipId} role="tooltip" pointerEvents="none" data-tooltip-width={tooltipWidth} data-tooltip-height={tooltipHeight} data-pixel-scale={pixelScale} transform={`translate(${x} ${y}) scale(${pixelScale})`}><rect width={tooltipWidth} height={tooltipHeight} rx="7" fill="#0b0e0f" fillOpacity=".96" stroke="#ffffff" strokeOpacity=".25"/><text x="10" y="18" fill="#f4f4f5" fontSize="12" fontWeight="700">{outcomePresentation[tooltipEntry.shot.outcome].label}</text><text x="10" y="37" fill="#e4e4e7" fontSize="12">xG {formatShotMetric(tooltipEntry.shot.xg)}</text><text x="10" y="53" fill="#e4e4e7" fontSize="12">xGOT {formatShotMetric(tooltipEntry.shot.xgot)}</text></g>; })()}
    <g fill="#e4e4e7" fontSize="14" fontWeight="700" aria-hidden="true"><text x="36" y="610">숫자는 슈팅 비중</text><text x="36" y="630">공격 방향 0 → 100</text><text x="835" y="584">오른쪽 외곽</text><text x="194" y="73">왼쪽 외곽</text></g>
  </svg></>;
}

export function SpatialPitch({ analysis, contextIdentity = "", forcedMode, embedded = false, layers = DEFAULT_PITCH_LAYERS }: { analysis?: PlayerAnalysis; contextIdentity?: string; forcedMode?: ViewMode; embedded?: boolean; layers?: PitchLayerVisibility }) {
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
  const heatState = !spatial?.available ? "활동 히트맵 사용 불가" : !heatValid ? "활동 히트맵 무결성 불일치" : spatial.heatmapPoints.length ? `활동 좌표 ${spatial.heatmapPoints.length}개` : "관측된 활동 좌표 0개";
  const shotState = !displaySpatial?.shotmapSnapshotAvailable ? "슈팅 스냅샷 사용 불가" : !controller.integrity ? "슈팅 스냅샷 무결성 불일치" : displaySpatial.shotmapPoints.length ? `슛 ${displaySpatial.shotmapPoints.length}개` : "관측된 슛 0개";
  const rawId = useId().replace(/:/g, "");
  const markerLayerId = `spatial-shot-markers-${rawId}`;
  return <section className={embedded ? "min-w-0" : panel} aria-labelledby={embedded ? undefined : `spatial-pitch-${rawId}`} aria-label={embedded ? PITCH_VIEW_COPY[mode] : undefined}>
    {!embedded && <div className="flex flex-wrap items-start justify-between gap-3"><div><h2 id={`spatial-pitch-${rawId}`} className="text-sm font-black">{PITCH_VIEW_COPY[mode]}</h2><p className="mt-1 type-caption text-zinc-400">공격 방향 왼쪽 → 오른쪽 · 오른쪽 외곽이 가까운 터치라인 · 동일 6레인 좌표계</p></div>{!forcedMode && <div role="group" aria-label="피치 보기" className="flex rounded-lg border border-white/15 bg-black/30 p-1"><button type="button" aria-pressed={mode === "perspective"} onClick={() => setManualMode("perspective")} className="min-h-9 rounded px-3 text-base font-bold aria-pressed:bg-orange-400 aria-pressed:text-zinc-950 focus-visible:ring-2 focus-visible:ring-orange-200">{PITCH_VIEW_COPY.perspective}</button><button type="button" aria-pressed={mode === "plan"} onClick={() => setManualMode("plan")} className="min-h-9 rounded px-3 text-base font-bold aria-pressed:bg-orange-400 aria-pressed:text-zinc-950 focus-visible:ring-2 focus-visible:ring-orange-200">{PITCH_VIEW_COPY.plan}</button></div>}</div>}
    {reducedMotion && manualMode === null && <p className="mt-2 text-base text-zinc-400">Reduced-motion preference detected; the 2D plan fallback is active.</p>}
    {layers.markers && controller.integrity && controller.presentOutcomes.length > 0 && <OutcomeControls outcomes={controller.presentOutcomes} counts={controller.counts} visible={controller.visibleOutcomes} markerLayerId={markerLayerId} onClick={controller.onClick} onDoubleClick={controller.onDoubleClick} showCounts={false}/>}<p role="status" aria-live="polite" className="sr-only">표시 중인 슈팅 결과: {outcomeSummary(controller.presentOutcomes.filter((outcome) => controller.visibleOutcomes.has(outcome)))}.</p>
    <div className="mt-3 min-w-0 overflow-hidden rounded-lg border border-white/10">{mode === "plan" ? <LegacySpatialPitchFigure analysis={displayAnalysis} visibleOutcomes={controller.visibleOutcomes} markerLayerId={markerLayerId} showCounts={false} layers={layers} corridors/> : <figure><PitchSvg spatial={displaySpatial} mode={mode} filterId={`spatial-heat-${rawId}`} visibleOutcomes={controller.visibleOutcomes} markerLayerId={markerLayerId} contextIdentity={contextIdentity} layers={layers}/><figcaption className="border-t border-white/10 bg-black/25 px-3 py-2 text-base text-zinc-300">{heatState} · {shotState} · 원본 32×22 밀도에서 계산한 CCA와 96×66 표시 히트맵을 같은 서버 좌표계에 겹쳐 표시합니다.</figcaption></figure>}</div>
    <p className="mt-3 text-base leading-5 text-zinc-400" aria-live="polite">{heatState} · {shotState} · 전술 구획은 시각 안내선이며 브라우저에서 점수나 구역 값을 새로 계산하지 않습니다. 데이터 없음과 관측된 0은 구분합니다.</p>
    <details className="mt-3 rounded-lg border border-white/10 bg-black/20 text-base text-zinc-300"><summary className="min-h-11 cursor-pointer px-3 py-3 font-bold focus-visible:ring-2 focus-visible:ring-orange-200">피치와 슈팅 상세</summary><div className="border-t border-white/10 p-3"><p>3D와 2D 회랑은 동일한 서버 좌표계와 레인 경계를 사용합니다.</p>{!controller.integrity ? <p className="mt-3">슈팅 이벤트 상세를 제공할 수 없습니다.</p> : displaySpatial!.shotmapPoints.length === 0 ? <p className="mt-3">관측된 슈팅 이벤트가 0건입니다.</p> : <ol aria-label="서버 슈팅 이벤트" className="mt-3 max-h-48 space-y-1 overflow-y-auto pr-1">{displaySpatial!.shotmapPoints.map((shot, index) => <li key={index} className="rounded bg-white/5 px-2 py-1">{index + 1}. {outcomeLabel[shot.outcome]} · xG {shot.xg == null ? "미상" : shot.xg.toFixed(2)} · xGOT {shot.xgot == null ? "미상" : shot.xgot.toFixed(2)} · ({shot.x.toFixed(1)}, {shot.y.toFixed(1)})</li>)}</ol>}</div></details>
  </section>;
}
