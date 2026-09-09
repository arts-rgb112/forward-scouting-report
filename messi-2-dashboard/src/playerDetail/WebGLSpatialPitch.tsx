import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { DAYLIGHT_BACKGROUND, repairPitchUV, stylePitchMaterial } from "./pitchPresentation";
import { loadPitchSurfaceAssets, PITCH_SURFACE_VERSION } from './pitchSurfaceAssets';
import { loadPitchModelBytes } from "./loadPitchModel";
import { buildGroundDensityDots, createGroundHeatmap, createContinuousGroundHeatmap, highDensityAccents } from "./groundHeatmap";
import { canReplayGoal, cloneReplayBall, replayPosition, REPLAY_DURATION_MS, styleShotBall, SHOT_BALL_COLORS } from "./shotReplay";
import { buildNativeReplayGeometry, nativePosePlacement, nativeReplayPoint, nativeReplayPolyline } from "./nativePitchReplayGeometry";
import { BodyPartShootingPanel } from "./BodyPartShootingPanel";
import { shotSilhouetteYawRadians, styleShotSilhouette } from "./shotSilhouetteStyle";
import { BoxSubregionPanel } from "./BoxSubregionPanel";
import type { BoxSubregionStatsState } from "./useBoxSubregionStats";
import { BOX_SUBREGION_BOUNDS, BOX_SUBREGION_ORDER, BOX_SUBREGION_X_MIN_INCLUSIVE, resolveBoxSubregionId, type BoxSubregionRegion } from "../api/boxSubregionContracts";
import type { NativePitchEventsV2State as NativePitchEventsState } from "./useNativePitchEventsV2";
import type { NativePitchEventV2 as NativePitchEvent } from "../api/nativePitchEventsV2Contracts";
import { NativePitchSelectionCard } from "./NativePitchSelectionCard";

import type { FullActivityHeatmapData } from "../api/fullActivityHeatmapContracts";
import type { FullActivityDisplayEnvelope, FullSourceCca } from "../api/fullActivityDisplayContracts";
import type { PlayerAnalysis, ShotmapPoint } from "../dashboard/types";
import {
  HEATMAP_COLUMNS,
  HEATMAP_ROWS,
  fullActivityDensityGrid,
  legacyDensityGrid,
  marchingSquares,
  normalizeDensity,
} from "./legacyHeatmap";
import { groupPitchShots, medianObservedXg, type PitchShotGroup } from "./PitchShotMarker";
import type { PitchLayerVisibility } from "./pitchLayers";
import {
  DEFAULT_WEBGL_CAMERA,
  FREEFLY_MOUSE_SENSITIVITY,
  FREEFLY_MOVE_STEP_METERS,
  GLB_PITCH_HALF_LENGTH_METERS,
  GLB_PITCH_LENGTH_METERS,
  GLB_PITCH_WIDTH_METERS,
  GLB_PITCH_SURFACE_Y_METERS,
  WEBGL_OVERLAY_Y_METERS,
  clampWebglZoom,
  freeflyLookTarget,
  freeflyStateFromOrbit,
  moveFreeflyCamera,
  pitchPercentToWorld,
  worldToPitchPercent,
  rotateFreeflyCamera,
  trajectoryWorldPoints,
  trajectoryArcPoint,
  type FreeflyCameraState,
  type PitchPercentPoint,
  type WorldPoint,
} from "./pitchWebglGeometry";
import {
  formatShotMetric,
  outcomePresentation,
  shotIntegrity,
  shotMarkerLabel,
  type ShotOutcome,
} from "./shotOutcomeVisibility";
import {
  WEBGL_DOTMATRIX_COLUMNS,
  WEBGL_DOTMATRIX_ROWS,
  buildWebglDensityDots,
  layoutWebglShotMarkers,
  type WebglShotPlacement,
} from "./webglDotMatrix";

const MODEL_URL = "/assets/footballpitchv3.glb";
const INITIAL_PITCH_CAMERA = freeflyStateFromOrbit(
  { azimuth: -25, elevation: 20, distance: 45 }, pitchPercentToWorld({ x: 90, y: 50 }),
);
// Only head/leftFoot/rightFoot select a pose — other/unknown never silently
// pick a preferred-foot pose (NATIVE_PITCH_EVENT_CONTRACT_20260908.md).
const NATIVE_EVENT_MOTION: Partial<Record<NativePitchEvent["bodyPart"], string>> = { head: "head", leftFoot: "left_foot", rightFoot: "right_foot" };
const NATIVE_BODY_PART_LABEL: Record<NativePitchEvent["bodyPart"], string> = { head: "헤더", leftFoot: "왼발", rightFoot: "오른발", other: "기타", unknown: "부위 미상" };
const NATIVE_OUTCOME_LABEL: Record<NativePitchEvent["outcome"], string> = { goal: "득점", on_target: "유효 슛", off_target: "빗나감", blocked: "블록" };
const DEPTH_BOUNDARIES = [0, 16.67, 33.33, 50, 66.67, 83.33, 100] as const;
const LANE_BOUNDARIES = [0, 21.82, 37, 63, 78.18, 100] as const;
const markerColors: Record<ShotOutcome, number> = {
  goal: 0xbef264,
  on_target: 0x38bdf8,
  off_target: 0xe2e8f0,
  blocked: 0x94a3b8,
};
// The box endpoint's 4 regions are fixed geometry (box-subregion-v1 never
// changes shape per request), so their hit-test positions are computable
// up front — independent of whether the server data has arrived yet.
export const BOX_ZONES: readonly BoxZoneOverlay[] = BOX_SUBREGION_ORDER.map((id) => {
  const bounds = BOX_SUBREGION_BOUNDS[id];
  return { id, point: { x: (bounds.xMinInclusive + 100) / 2, y: (bounds.yMinInclusive + bounds.yMaxExclusive) / 2 } };
});
type OccupancyCell = { depth: number; lane: number; occupancyPct: number };
type ZoneSummary = { shots: number; goals: number; xg: number; shotSharePct: number };
type ZoneOverlay = { cell: OccupancyCell; summary: ZoneSummary; point: PitchPercentPoint };
type BoxRegionId = (typeof BOX_SUBREGION_ORDER)[number];
type BoxZoneOverlay = { id: BoxRegionId; point: PitchPercentPoint };
type ProjectedPoint = { left: number; top: number; visible: boolean };
export type PitchSelectedZone =
  | { kind: "box"; id: BoxRegionId }
  | { kind: "grid"; id: string };

export function tacticalGridZoneId(depth: number, lane: number) {
  return `depth${depth + 1}_lane${lane + 1}`;
}

export function shouldSelectZoneOnPointerUp({
  button,
  moved,
  pinching,
  cancelled,
}: {
  button: number;
  moved: boolean;
  pinching: boolean;
  cancelled: boolean;
}) {
  return button === 0 && !moved && !pinching && !cancelled;
}

type Runtime = {
  asset?: THREE.Object3D;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  overlayRoot: THREE.Group;
  zoneHitRoot: THREE.Group;
  render: () => void;
};

function validPitchPoint(point: { x: number; y: number }) {
  return Number.isFinite(point.x) && Number.isFinite(point.y) &&
    point.x >= 0 && point.x <= 100 && point.y >= 0 && point.y <= 100;
}

function median(values: readonly number[]) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function deriveWebglPivot(
  spatial: PlayerAnalysis["spatial"] | undefined,
  normalized: Float64Array,
): PitchPercentPoint {
  if (shotIntegrity(spatial)) {
    const shots = spatial!.shotmapPoints.filter(validPitchPoint);
    const x = median(shots.map((shot) => shot.x));
    const y = median(shots.map((shot) => shot.y));
    if (x != null && y != null) return { x, y };
  }
  let peak = 0;
  let peakIndex = -1;
  normalized.forEach((value, index) => {
    if (value > peak) {
      peak = value;
      peakIndex = index;
    }
  });
  if (peakIndex >= 0) {
    return {
      x: ((peakIndex % HEATMAP_COLUMNS) + 0.5) / HEATMAP_COLUMNS * 100,
      y: (Math.floor(peakIndex / HEATMAP_COLUMNS) + 0.5) / HEATMAP_ROWS * 100,
    };
  }
  return { x: 80, y: 50 };
}

function zoneSummary(shots: readonly ShotmapPoint[], cell: OccupancyCell): ZoneSummary {
  const x0 = DEPTH_BOUNDARIES[cell.depth];
  const x1 = DEPTH_BOUNDARIES[cell.depth + 1];
  const y0 = LANE_BOUNDARIES[cell.lane];
  const y1 = LANE_BOUNDARIES[cell.lane + 1];
  const inCell = shots.filter((shot) =>
    shot.x >= x0 && (cell.depth === 5 ? shot.x <= x1 : shot.x < x1) &&
    shot.y >= y0 && (cell.lane === 4 ? shot.y <= y1 : shot.y < y1));
  return {
    shots: inCell.length,
    goals: inCell.filter((shot) => shot.outcome === "goal").length,
    xg: inCell.reduce((sum, shot) => sum + (typeof shot.xg === "number" && Number.isFinite(shot.xg) ? shot.xg : 0), 0),
    shotSharePct: shots.length ? inCell.length / shots.length * 100 : 0,
  };
}

function disposeObject(root: THREE.Object3D) {
  root.traverse((object) => {
    if (object instanceof THREE.Mesh || object instanceof THREE.Line) {
      object.geometry?.dispose();
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      materials.forEach((material) => {
        if (!material) return;
        Object.values(material).forEach((value) => {
          if (value instanceof THREE.Texture && !material.userData.sharedAssetTextures) value.dispose();
        });
        material.dispose();
      });
    }
  });
}

/**
 * The exact same curve `trajectoryArcPoint` describes, wrapped so Three's
 * `TubeGeometry` can sample it directly. The replay Tube used to fit a
 * `CatmullRomCurve3` through 49 pre-sampled points instead — a cubic spline
 * that only agrees with the true quadratic curve *at* those 49 knots, and
 * measurably deviates between them. This class has no such gap: every
 * `getPoint(t)` call is the analytic function itself, so the highlighted
 * Tube, the static lines, and the moving ball can never diverge.
 */
export class ShotTrajectoryCurve extends THREE.Curve<THREE.Vector3> {
  constructor(
    private readonly start: PitchPercentPoint,
    private readonly endY: number,
    private readonly endHeightMeters: number | null | undefined,
  ) { super(); }
  getPoint(t: number, target = new THREE.Vector3()) {
    const point = trajectoryArcPoint(this.start, this.endY, this.endHeightMeters, t);
    return target.set(point.x, point.y, point.z);
  }
}

function line(
  points: readonly WorldPoint[],
  color: number,
  opacity: number,
  dashed = false,
) {
  const geometry = new THREE.BufferGeometry().setFromPoints(
    points.map((point) => new THREE.Vector3(point.x, point.y, point.z)),
  );
  const material = dashed
    ? new THREE.LineDashedMaterial({ color, transparent: true, opacity, dashSize: 0.8, gapSize: 0.55 })
    : new THREE.LineBasicMaterial({ color, transparent: true, opacity });
  const object = new THREE.Line(geometry, material);
  if (dashed) object.computeLineDistances();
  return object;
}

function addTacticalGrid(root: THREE.Group) {
  const color = 0xf1f5f9;
  for (const depth of DEPTH_BOUNDARIES.slice(1, -1)) {
    root.add(line([
      pitchPercentToWorld({ x: depth, y: 0 }, 0.095),
      pitchPercentToWorld({ x: depth, y: 100 }, 0.095),
    ], color, 0.85, true));
  }
  for (const lane of LANE_BOUNDARIES.slice(1, -1)) {
    root.add(line([
      pitchPercentToWorld({ x: 0, y: lane }, 0.095),
      pitchPercentToWorld({ x: 100, y: lane }, 0.095),
    ], color, 0.85, true));
  }
  // Reuse the existing 37/63 lane lines; only the PK centre axis is additional.
  for (const y of [50]) {
    root.add(line([
      pitchPercentToWorld({ x: 100 - 16.5 / GLB_PITCH_LENGTH_METERS * 100, y }, 0.095),
      pitchPercentToWorld({ x: 100, y }, 0.095),
    ], 0xf8fafc, 0.8, true));
  }
}

export function addZoneHitMeshes(root: THREE.Group, zones: readonly ZoneOverlay[]) {
  const material = new THREE.MeshBasicMaterial({
    transparent: true,
    opacity: 0,
    depthTest: false,
    depthWrite: false,
    colorWrite: false,
    side: THREE.DoubleSide,
  });
  for (const zone of zones) {
    const depthSize = (DEPTH_BOUNDARIES[zone.cell.depth + 1] - DEPTH_BOUNDARIES[zone.cell.depth]) / 100 * GLB_PITCH_LENGTH_METERS;
    const laneSize = (LANE_BOUNDARIES[zone.cell.lane + 1] - LANE_BOUNDARIES[zone.cell.lane]) / 100 * GLB_PITCH_WIDTH_METERS;
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(laneSize, depthSize), material);
    const centre = pitchPercentToWorld(zone.point, WEBGL_OVERLAY_Y_METERS + 0.01);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(centre.x, centre.y, centre.z);
    mesh.userData.zoneKey = `${zone.cell.depth}-${zone.cell.lane}`;
    root.add(mesh);
  }
}

// A tiny safety margin (pitch-percent units) the hit surface's near edge sits
// below the box's real 84.29 boundary — many orders of magnitude larger than
// any float32 vertex-position rounding, so an exact x=84.29 ray reliably
// lands ON the mesh instead of sometimes missing it by a hair (confirmed by
// independent review: a real THREE ray at exactly 84.29 could report no hit
// at all against a mesh whose edge was placed exactly there). The handful of
// pitch-percent width this trims from the legacy 30-zone's outermost depth
// band is inside that same coarse band either way, never crossing into the
// next one, and the box's own half-open classification below still uses the
// exact 84.29 threshold — this margin only affects hit ACQUISITION, never
// which region (or "not the box at all") a hit resolves to.
const BOX_HIT_SURFACE_MARGIN = 0.5;

/**
 * The exact server box endpoint's 4 regions, hit-tested independently of the
 * generic 30-zone grid above (whose middle lane merges L3L+L3R and whose
 * depth band starts at 83.33, not the box's real 84.29 boundary — neither
 * matches the box definition closely enough to stand in for it).
 *
 * One single plane covers the whole box (not four separate ones) so there
 * are no internal seams at all at y=37/50/63 for a ray to fall between —
 * region classification never comes from which mesh was hit, only from the
 * exact analytic `resolveBoxSubregionId` at the real hit point. Placed a
 * touch higher than the legacy zone meshes so a raycast anywhere in the
 * (margin-widened) box footprint always resolves through that exact
 * function, never the coarser generic cell it happens to overlap.
 */
export function addBoxZoneHitMeshes(root: THREE.Group) {
  const material = new THREE.MeshBasicMaterial({
    transparent: true,
    opacity: 0,
    depthTest: false,
    depthWrite: false,
    colorWrite: false,
    side: THREE.DoubleSide,
  });
  const yMin = Math.min(...BOX_SUBREGION_ORDER.map((id) => BOX_SUBREGION_BOUNDS[id].yMinInclusive));
  const yMax = Math.max(...BOX_SUBREGION_ORDER.map((id) => BOX_SUBREGION_BOUNDS[id].yMaxExclusive));
  const xStart = BOX_SUBREGION_X_MIN_INCLUSIVE - BOX_HIT_SURFACE_MARGIN;
  const depthSize = (100 - xStart) / 100 * GLB_PITCH_LENGTH_METERS;
  const laneSize = (yMax - yMin) / 100 * GLB_PITCH_WIDTH_METERS;
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(laneSize, depthSize), material);
  const centre = pitchPercentToWorld({ x: (xStart + 100) / 2, y: (yMin + yMax) / 2 }, WEBGL_OVERLAY_Y_METERS + 0.02);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.set(centre.x, centre.y, centre.z);
  mesh.userData.isBoxHitSurface = true;
  root.add(mesh);
}


function addContours(
  root: THREE.Group,
  core: FullSourceCca | undefined,
  normalized: Float64Array,
) {
  if (!core?.available || core.gridColumns !== HEATMAP_COLUMNS || core.gridRows !== HEATMAP_ROWS ||
      core.thresholdOfPeak === null || !Number.isFinite(core.thresholdOfPeak) || core.thresholdOfPeak <= 0) return;
  for (const [x1, y1, x2, y2] of marchingSquares(normalized, core.thresholdOfPeak)) {
    root.add(line([
      pitchPercentToWorld({ x: x1, y: 100 - y1 }, 0.16),
      pitchPercentToWorld({ x: x2, y: 100 - y2 }, 0.16),
    ], 0xffffff, 0.82, true));
  }
}

/**
 * The exact selection production uses to keep the replaying shot's own
 * trajectory from doubling the animated path, while leaving every other raw
 * event — including ones sharing its coordinate — untouched. Exported so a
 * regression test can drive `addShots` through this same function instead of
 * re-implementing the filter and silently drifting from production behavior.
 */
export function excludeReplayingShot<T extends { sourceIndex: number }>(
  shots: readonly T[],
  replayIndex: number | null,
): readonly T[] {
  return replayIndex == null ? shots : shots.filter(({ sourceIndex }) => sourceIndex !== replayIndex);
}

export function addShots(
  root: THREE.Group,
  groups: readonly PitchShotGroup[],
  // Trajectories are drawn per raw shot, never per coordinate-group. A group
  // merges every raw event at one exact (x,y) into a single marker/count
  // badge and keeps only one representative `shot` — so excluding a group
  // during replay silently dropped every sibling sharing that coordinate,
  // even ones the user never selected. Passing the raw list here and
  // excluding only the exact replaying event fixes that.
  trajectoryShots: readonly { shot: ShotmapPoint }[],
  medianXg: number | null,
  layers: PitchLayerVisibility,
  placements: ReadonlyMap<string, WebglShotPlacement>,
  dimmed = false,
  asset?: THREE.Object3D,
) {
  for (const group of groups) {
    if (layers.markers && asset) {
      const placement = placements.get(group.key);
      if (!placement) continue;
      const marker = cloneReplayBall(asset);
      styleShotBall(marker, group.outcome);
      marker.position.set(placement.world.x, GLB_PITCH_SURFACE_Y_METERS + .11, placement.world.z);
      marker.renderOrder = 5;
      root.add(marker);
      const shadow = new THREE.Mesh(new THREE.CircleGeometry(.14, 16), new THREE.MeshBasicMaterial({
        color: 0x101810, transparent: true, opacity: dimmed ? .1 : .3, depthWrite: false,
        polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
      }));
      shadow.rotation.x = -Math.PI / 2;
      shadow.position.set(placement.world.x, GLB_PITCH_SURFACE_Y_METERS + .007, placement.world.z);
      root.add(shadow);
    }
  }
  if (layers.trajectories) {
    for (const { shot } of trajectoryShots) {
      const trajectory = shot.trajectory;
      if (trajectory?.endpointKind === "goal_mouth" && typeof trajectory.endZMeters === "number") {
        root.add(line(
          trajectoryWorldPoints(shot, trajectory.endY, trajectory.endZMeters),
          markerColors[shot.outcome],
          shot.outcome === "goal" ? 0.9 : shot.outcome === "on_target" ? 0.62 : 0.25,
        ));
      }
    }
  }
}

/** Native markers and trajectories are deliberately a separate renderer path:
 * they consume only the strict same-bundle SportsAPI events, never a FotMob
 * position or array index. */
function addNativeShots(
  root: THREE.Group,
  events: readonly NativePitchEvent[],
  layers: PitchLayerVisibility,
  asset: THREE.Object3D | undefined,
) {
  for (const event of events) {
    // A recorded, projected origin is enough for a marker and a body pose.
    // A missing/invalid destination only withholds the endpoint-dependent
    // schematic line and moving ball; it never erases the observed shot.
    const origin = nativeMarkerOriginWorld(event);
    if (layers.markers && asset && origin) {
      const marker = cloneReplayBall(asset);
      styleShotBall(marker, event.outcome);
      marker.position.set(origin.x, origin.y, origin.z);
      marker.renderOrder = 5;
      root.add(marker);
    }
    const geometry = buildNativeReplayGeometry(event);
    if (layers.trajectories && geometry) {
      const trajectory = line(nativeReplayPolyline(geometry), markerColors[event.outcome], event.outcome === "goal" ? .9 : .6);
      trajectory.userData.nativeTrajectoryKey = event.key;
      root.add(trajectory);
    }
  }
}

/** A marker is anchored only to the validated recorded origin.  Do not make
 * it depend on a separately optional endpoint/replay geometry. */
export function nativeMarkerOriginWorld(event: NativePitchEvent): WorldPoint | null {
  if (event.plot.state !== "projected" || event.plot.x === null || event.plot.y === null) return null;
  return pitchPercentToWorld({ x: event.plot.x, y: event.plot.y }, WEBGL_OVERLAY_Y_METERS + .11);
}


function projectWorld(runtime: Runtime | null, container: HTMLDivElement | null, point: WorldPoint): ProjectedPoint {
  if (!runtime || !container) return { left: 50, top: 50, visible: false };
  const vector = new THREE.Vector3(point.x, point.y, point.z).project(runtime.camera);
  return {
    left: (vector.x * 0.5 + 0.5) * 100,
    top: (-vector.y * 0.5 + 0.5) * 100,
    visible: vector.z > -1 && vector.z < 1 && Math.abs(vector.x) <= 1.12 && Math.abs(vector.y) <= 1.12,
  };
}

export function WebGLSpatialPitch({
  spatial,
  visibleOutcomes,
  markerLayerId,
  contextIdentity,
  layers,
  fullActivityHeatmap,
  fullActivityDisplay,
  boxSubregion,
  nativePitchEvents,
  shotSource,
  onShotSourceChange,
}: {
  spatial: PlayerAnalysis["spatial"] | undefined;
  visibleOutcomes: ReadonlySet<ShotOutcome>;
  markerLayerId: string;
  contextIdentity: string;
  layers: PitchLayerVisibility;
  fullActivityHeatmap?: FullActivityHeatmapData;
  fullActivityDisplay?: FullActivityDisplayEnvelope;
  boxSubregion?: BoxSubregionStatsState;
  nativePitchEvents?: NativePitchEventsState;
  shotSource: "sportsapi" | "fotmob";
  onShotSourceChange: (source: "sportsapi" | "fotmob") => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const runtimeRef = useRef<Runtime | null>(null);
  const [runtimeVersion, setRuntimeVersion] = useState(0);
  const [projectionVersion, setProjectionVersion] = useState(0);
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error" | "unsupported">("loading");
  const [loadError, setLoadError] = useState("");
  const [freeflyState, setFreeflyState] = useState<FreeflyCameraState>(() =>
    INITIAL_PITCH_CAMERA);
  const freeflyRef = useRef(freeflyState);
  const dragRef = useRef<{ button: number; x: number; y: number; startX: number; startY: number; moved: boolean } | null>(null);
  const touchPoints = useRef(new Map<number, { x: number; y: number }>());
  const multiTouchRef = useRef(false);
  const selectionBlockedPointersRef = useRef(new Set<number>());
  const raycasterRef = useRef<THREE.Raycaster | null>(null);
  const [zoom, setZoom] = useState(1);
  const [showTacticalZones, setShowTacticalZones] = useState(true);
  const [hoveredZone, setHoveredZone] = useState<ZoneOverlay | null>(null);
  const [hoveredBoxRegion, setHoveredBoxRegion] = useState<BoxRegionId | null>(null);
  const [selectedZone, setSelectedZone] = useState<PitchSelectedZone | null>(null);
  const [activeShot, setActiveShot] = useState<string | null>(null);
  const [replayIndex, setReplayIndex] = useState<number | null>(null);
  const silhouettePreview = import.meta.env.DEV && new URLSearchParams(window.location.search).get("silhouettePreview") === "1";
  const [previewMotion, setPreviewMotion] = useState("right_foot");
  const [silhouetteState, setSilhouetteState] = useState("idle");
  const [playing, setPlaying] = useState(false);
  const [replayProgress, setReplayProgress] = useState(0);
  const [seekVersion, setSeekVersion] = useState(0);
  const [replayError, setReplayError] = useState("");
  const replayProgressRef = useRef(0);
  const replayShot = replayIndex == null ? undefined : spatial?.shotmapPoints[replayIndex];

  // Real event.bodyPart-driven pose selection (native-pitch-events-v1) — a
  // genuinely separate source from the FotMob shot layer above, never
  // joined to it by index/proximity/count. Selecting a real recorded event
  // reveals its OWN body part directly; nothing here is ever inferred.
  const nativeEvents = nativePitchEvents?.kind === "ready" ? nativePitchEvents.data.events : [];
  // Unlocated records remain in the same-bundle counts and replay selector,
  // but cannot honestly receive a pitch marker.  This is a filter for visual
  // placement only, never an event join or a denominator change.
  const nativeMarkerEvents = useMemo(() => nativeEvents.filter((event) => event.plot.state === "projected" && event.plot.x !== null && event.plot.y !== null), [nativeEvents]);
  const [selectedNativeEventKey, setSelectedNativeEventKey] = useState<string | null>(null);
  const selectedNativeEvent = selectedNativeEventKey == null ? undefined : nativeEvents.find((event) => event.key === selectedNativeEventKey);
  const [nativePoseState, setNativePoseState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const nativePoseMixerRef = useRef<THREE.AnimationMixer | null>(null);
  const nativePoseDurationRef = useRef(1);
  const nativeMode = shotSource === "sportsapi";
  const nativeReplay = useMemo(() => selectedNativeEvent ? buildNativeReplayGeometry(selectedNativeEvent) : null, [selectedNativeEvent]);
  const nativeBodyState = nativePitchEvents?.kind === "ready"
    ? { kind: "ready" as const, key: nativePitchEvents.key, data: nativePitchEvents.data.bodyParts }
    : nativePitchEvents ? { kind: nativePitchEvents.kind, key: nativePitchEvents.key } : undefined;

  // A persistent zone is mutually exclusive with a selected shot: the dock
  // must never combine a native event's body/quality with an aggregate zone.
  // This one helper is intentionally the only zone-selection entry point so
  // the click, keyboard, and future dock controls clear the same transient
  // replay state.
  const selectZone = useCallback((next: PitchSelectedZone | null) => {
    setSelectedZone(next);
    if (next === null) return;
    setSelectedNativeEventKey(null);
    setReplayIndex(null);
    setActiveShot(null);
    setPlaying(false);
    replayProgressRef.current = 0;
    setReplayProgress(0);
  }, []);

  const selectNativeShot = useCallback((key: string | null) => {
    setSelectedZone(null);
    setSelectedNativeEventKey(key);
    setPlaying(false);
    replayProgressRef.current = 0;
    setReplayProgress(0);
  }, []);

  const selectLegacyShot = useCallback((index: number | null) => {
    setSelectedZone(null);
    setReplayIndex(index);
    setPlaying(false);
    replayProgressRef.current = 0;
    setReplayProgress(0);
  }, []);

  const legacyHeatValid = Boolean(spatial?.available &&
    spatial.heatmapPointCount === spatial.heatmapPoints.length &&
    spatial.heatmapPoints.every(validPitchPoint));
  const legacyHeat = useMemo(() => legacyHeatValid ? spatial!.heatmapPoints : [], [legacyHeatValid, spatial]);
  const legacyNormalized = useMemo(() => normalizeDensity(legacyDensityGrid(legacyHeat)), [legacyHeat]);
  const heatValid = Boolean(fullActivityHeatmap?.available &&
    fullActivityHeatmap.cellCounts.length === HEATMAP_COLUMNS * HEATMAP_ROWS &&
    fullActivityHeatmap.cellCounts.every((value) => Number.isInteger(value) && value >= 0) &&
    fullActivityHeatmap.cellCounts.reduce((sum, value) => sum + value, 0) === fullActivityHeatmap.validPointCount);
  const densityDots = useMemo(() => heatValid ? buildWebglDensityDots(fullActivityHeatmap!.cellCounts) : [], [fullActivityHeatmap, heatValid]);
  const groundDots = useMemo(() => heatValid ? buildGroundDensityDots(fullActivityHeatmap!.cellCounts) : [], [fullActivityHeatmap, heatValid]);
  const fullNormalized = useMemo(() => fullActivityDisplay?.fullHeat.available ? normalizeDensity(fullActivityDensityGrid(fullActivityDisplay.fullHeat.cellCounts)) : new Float64Array(HEATMAP_COLUMNS * HEATMAP_ROWS), [fullActivityDisplay]);
  const pivot = useMemo(() => deriveWebglPivot(spatial, legacyNormalized), [legacyNormalized, spatial]);
  const shotsValid = shotIntegrity(spatial);
  const visibleShots = useMemo(() => shotsValid ? spatial!.shotmapPoints
    .map((shot, sourceIndex) => ({ shot, sourceIndex }))
    .filter(({ shot }) => visibleOutcomes.has(shot.outcome)) : [], [shotsValid, spatial, visibleOutcomes]);
  const markerGroups = useMemo(() => groupPitchShots(visibleShots), [visibleShots]);
  const medianXg = shotsValid ? medianObservedXg(spatial!.shotmapPoints) : null;
  const markerPlacements = useMemo(() => layoutWebglShotMarkers(markerGroups, medianXg), [markerGroups, medianXg]);
  const zones = useMemo(() => {
    if (!shotsValid) return [];
    return (spatial?.positionalGrid ?? [])
      .filter((cell) => Number.isInteger(cell.depth) && cell.depth >= 0 && cell.depth < 6 &&
        Number.isInteger(cell.lane) && cell.lane >= 0 && cell.lane < 5 && Number.isFinite(cell.occupancyPct))
      .map((cell) => ({
        cell,
        summary: zoneSummary(spatial!.shotmapPoints, cell),
        point: {
          x: (DEPTH_BOUNDARIES[cell.depth] + DEPTH_BOUNDARIES[cell.depth + 1]) / 2,
          y: (LANE_BOUNDARIES[cell.lane] + LANE_BOUNDARIES[cell.lane + 1]) / 2,
        },
      }));
  }, [shotsValid, spatial]);
  const zonesByKey = useMemo(() => new Map(
    zones.map((zone) => [`${zone.cell.depth}-${zone.cell.lane}`, zone]),
  ), [zones]);
  const zonesBySelectedId = useMemo(() => new Map(
    zones.map((zone) => [tacticalGridZoneId(zone.cell.depth, zone.cell.lane), zone]),
  ), [zones]);

  const renderRuntime = useCallback(() => {
    runtimeRef.current?.render();
    setProjectionVersion((value) => value + 1);
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    const host = hostRef.current;
    if (!canvas || !host) return;
    if (typeof WebGLRenderingContext === "undefined") {
      setLoadState("unsupported");
      setLoadError("이 브라우저는 WebGL 컨텍스트를 제공하지 않습니다.");
      return;
    }
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: "high-performance" });
      renderer.shadowMap.enabled = true;
      renderer.shadowMap.type = THREE.PCFShadowMap;
    } catch (error) {
      setLoadState(typeof WebGLRenderingContext === "undefined" ? "unsupported" : "error");
      setLoadError(error instanceof Error ? error.message : "WebGL 초기화 실패");
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 0.85;
    renderer.setClearColor(DAYLIGHT_BACKGROUND, 1);

    const scene = new THREE.Scene();
    let surface: Awaited<ReturnType<typeof loadPitchSurfaceAssets>> | undefined;
    const camera = new THREE.PerspectiveCamera(42, 16 / 9, 0.05, 420);
    const initial = INITIAL_PITCH_CAMERA;
    freeflyRef.current = initial;
    setFreeflyState(initial);
    camera.position.set(initial.position.x, initial.position.y, initial.position.z);
    const initialTarget = freeflyLookTarget(initial);
    camera.lookAt(initialTarget.x, initialTarget.y, initialTarget.z);

    scene.add(new THREE.HemisphereLight(0xcde5f4, 0x4a5231, .3));
    const sun = new THREE.DirectionalLight(0xfff2d7, 1.4);
    sun.position.set(-50, 48, -30);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048,2048);
    Object.assign(sun.shadow.camera, {left:-80,right:80,top:90,bottom:-90,near:1,far:210});
    sun.shadow.bias = -.0003;
    sun.shadow.normalBias = .035;
    scene.add(sun);
    const overlayRoot = new THREE.Group();
    scene.add(overlayRoot);
    const zoneHitRoot = new THREE.Group();
    scene.add(zoneHitRoot);
    const render = () => renderer.render(scene, camera);
    const runtime: Runtime = { scene, camera, renderer, overlayRoot, zoneHitRoot, render };
    runtimeRef.current = runtime;

    let lastWidth = 0;
    const resize = () => {
      const width = Math.max(1, host.clientWidth);
      if (width === lastWidth) return;
      lastWidth = width;
      const height = Math.max(320, Math.round(width * 0.59));
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      renderRuntime();
    };
    let resizeFrame = 0;
    const resizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => {
      cancelAnimationFrame(resizeFrame);
      resizeFrame = requestAnimationFrame(resize);
    });
    resizeObserver?.observe(host);
    resize();
    const loader = new GLTFLoader();
    let cancelled = false;
    const modelAbort = new AbortController();
    loadPitchModelBytes(MODEL_URL, modelAbort.signal)
      .then((bytes) => loader.parseAsync(bytes, new URL('.', new URL(MODEL_URL, window.location.href)).href))
      .then(async (gltf) => {
        if (cancelled) {
          disposeObject(gltf.scene);
          return;
        }
        for (const hiddenName of ["FootballPitch5_3Check_9", "group_12", "Football_13"]) {
          const extra = gltf.scene.getObjectByName(hiddenName);
          if (extra) extra.visible = false;
        }
        gltf.scene.updateMatrixWorld(true);
        gltf.scene.traverse((object) => {
          if (object instanceof THREE.Mesh) {
            repairPitchUV(object);
            (Array.isArray(object.material) ? object.material : [object.material]).forEach(stylePitchMaterial);
            object.castShadow = (Array.isArray(object.material) ? object.material : [object.material]).some(m => /Fencing|White/.test(m.name));
            object.receiveShadow = true;
          }
        });
        let loadedSurface: Awaited<ReturnType<typeof loadPitchSurfaceAssets>>;
        try { loadedSurface = await loadPitchSurfaceAssets(); }
        catch (error) { disposeObject(gltf.scene); throw error; }
        if (cancelled) { disposeObject(gltf.scene); disposeObject(loadedSurface.surround); loadedSurface.dispose(); return; }
        surface = loadedSurface;
        surface.apply(gltf.scene);
        scene.environment = surface.environment; scene.environmentIntensity = .65;
        scene.add(surface.surround);
        canvas.dataset.pitchSurface = PITCH_SURFACE_VERSION;
        scene.add(gltf.scene);
        runtime.asset = gltf.scene;
        setLoadState("ready");
        renderRuntime();
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        console.error("경기장 모델을 불러오지 못했습니다", error);
        setLoadState("error");
        setLoadError(error instanceof Error ? error.message : "3D 피치 자산 로드 실패");
      });
    setRuntimeVersion((value) => value + 1);
    render();
    return () => {
      cancelled = true;
      modelAbort.abort();
      resizeObserver?.disconnect();
      cancelAnimationFrame(resizeFrame);
      disposeObject(scene);
      surface?.dispose();
      delete canvas.dataset.pitchSurface;
      renderer.dispose();
      runtimeRef.current = null;
    };
  // Runtime is intentionally rebuilt only for a player-context reset.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contextIdentity]);

  useEffect(() => {
    setReplayIndex(null); setPlaying(false); setReplayProgress(0); replayProgressRef.current = 0;
    setSelectedNativeEventKey(null); // a native `key` from a stale context can never carry over into a new one
    setSelectedZone(null);
  }, [contextIdentity]);

  // Also clear a selected native event the instant the PK toggle / dataset
  // context makes the underlying event list stale — `nativePitchEvents.key`
  // changes exactly when useNativePitchEvents' own resource key changes.
  useEffect(() => { setSelectedNativeEventKey(null); setSelectedZone(null); }, [nativePitchEvents?.key]);

  // Legacy box data has its own resource key (and its own source policy), so
  // a persistent selection cannot survive an in-flight context replacement.
  useEffect(() => { setSelectedZone(null); }, [boxSubregion?.key]);

  // A source switch is a data-model switch, not merely a different label for
  // the same selected object.  Clear both source-specific selections and the
  // replay clock so neither a FotMob index nor a SportsAPI response key can
  // survive into the other provider's layer.
  useEffect(() => {
    setReplayIndex(null);
    setSelectedNativeEventKey(null);
    setPlaying(false);
    setReplayProgress(0);
    replayProgressRef.current = 0;
    setActiveShot(null);
    setHoveredZone(null);
    setHoveredBoxRegion(null);
    setSelectedZone(null);
  }, [shotSource]);

  // Native pose is a schematic view of this exact SportsAPI event.  Placement
  // and yaw come from the reviewed helper; no raw z is promoted to a measured
  // height and no FotMob position is consulted here.
  useEffect(() => {
    const runtime = runtimeRef.current;
    const placement = selectedNativeEvent ? nativePosePlacement(selectedNativeEvent) : null;
    if (!nativeMode || !runtime || !placement || !layers.markers) { setNativePoseState("idle"); return; }
    let cancelled = false;
    let figure: THREE.Group | undefined;
    let mixer: THREE.AnimationMixer | undefined;
    setNativePoseState("loading");
    new GLTFLoader().load(placement.assetUrl, (gltf) => {
      if (cancelled) { disposeObject(gltf.scene); return; }
      figure = gltf.scene;
      figure.position.set(placement.groundPosition.x, placement.groundPosition.y, placement.groundPosition.z);
      styleShotSilhouette(figure, selectedNativeEvent!.bodyPart);
      figure.rotation.y = placement.yawRadians;
      runtime.scene.add(figure);
      mixer = new THREE.AnimationMixer(figure);
      nativePoseMixerRef.current = mixer;
      nativePoseDurationRef.current = gltf.animations.reduce((duration, clip) => Math.max(duration, clip.duration), 1);
      gltf.animations.forEach((clip) => {
        const action = mixer!.clipAction(clip);
        action.setLoop(THREE.LoopOnce, 1);
        action.clampWhenFinished = true;
        action.play();
      });
      mixer.setTime(0);
      runtime.render();
      setNativePoseState("ready");
    }, undefined, () => { if (!cancelled) setNativePoseState("error"); });
    return () => {
      cancelled = true;
      if (nativePoseMixerRef.current === mixer) nativePoseMixerRef.current = null;
      mixer?.stopAllAction();
      if (figure) { runtime.scene.remove(figure); mixer?.uncacheRoot(figure); disposeObject(figure); runtime.render(); }
    };
  }, [nativeMode, selectedNativeEvent, runtimeVersion, loadState, layers.markers]);

  // The pose is not a static first-frame badge: it follows the exact replay
  // clock used by the schematic ball.  This stays visual-only; clip timing
  // is not claimed as observed biomechanics.
  useEffect(() => {
    const mixer = nativePoseMixerRef.current;
    const runtime = runtimeRef.current;
    if (!mixer || !runtime || !nativeMode) return;
    mixer.setTime(replayProgress * nativePoseDurationRef.current);
    runtime.render();
  }, [nativeMode, replayProgress, runtimeVersion]);

  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!silhouettePreview || !runtime || !replayShot || !layers.markers) return;
    let cancelled = false, frame = 0;
    let figure: THREE.Group | undefined;
    let mixer: THREE.AnimationMixer | undefined;
    setSilhouetteState("loading");
    new GLTFLoader().load(`/assets/shot-silhouette/${previewMotion}.glb?v=2`, gltf => {
      if (cancelled) { disposeObject(gltf.scene); return; }
      figure = gltf.scene;
      const start = replayPosition(replayShot, 0), end = replayPosition(replayShot, 1);
      const direction = end.clone().sub(start); direction.y = 0; direction.normalize();
      figure.position.copy(start).addScaledVector(direction, -.35);
      figure.position.y = GLB_PITCH_SURFACE_Y_METERS;
      figure.rotation.y = shotSilhouetteYawRadians(start, end);
      runtime.scene.add(figure);
      mixer = new THREE.AnimationMixer(figure);
      gltf.animations.forEach(clip => { const action = mixer!.clipAction(clip); action.setLoop(THREE.LoopOnce, 1); action.clampWhenFinished = true; action.play(); });
      setSilhouetteState("ready");
      const draw = () => {
        if (cancelled) return;
        mixer!.setTime(Math.min(1, replayProgressRef.current / .4));
        runtime.render();
        frame = requestAnimationFrame(draw);
      };
      draw();
    }, undefined, () => { if (!cancelled) setSilhouetteState("error"); });
    return () => { cancelled = true; cancelAnimationFrame(frame); mixer?.stopAllAction(); if (figure) { runtime.scene.remove(figure); mixer?.uncacheRoot(figure); disposeObject(figure); } };
  }, [silhouettePreview, previewMotion, replayShot, runtimeVersion, loadState, layers.markers]);

  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!nativeMode || !runtime?.asset || !layers.markers || !nativeReplay || !selectedNativeEvent) return;
    let ball: THREE.Mesh;
    try { ball = cloneReplayBall(runtime.asset); styleShotBall(ball, selectedNativeEvent.outcome); }
    catch { setPlaying(false); return; }
    runtime.scene.add(ball);
    const path = line(nativeReplayPolyline(nativeReplay), markerColors[selectedNativeEvent.outcome], selectedNativeEvent.outcome === "goal" ? .95 : .68);
    runtime.scene.add(path);
    let frame = 0;
    const initial = replayProgressRef.current;
    const started = performance.now();
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const draw = (now: number) => {
      const progress = playing && !reduced ? Math.min(1, initial + (now - started) / REPLAY_DURATION_MS) : initial;
      replayProgressRef.current = progress;
      setReplayProgress(progress);
      const point = nativeReplayPoint(nativeReplay, progress);
      ball.position.set(point.x, point.y, point.z);
      runtime.render();
      if (playing && !reduced && progress < 1) frame = requestAnimationFrame(draw);
      else if (playing) setPlaying(false);
    };
    draw(started);
    return () => {
      cancelAnimationFrame(frame);
      runtime.scene.remove(ball, path);
      ball.geometry.dispose();
      (Array.isArray(ball.material) ? ball.material : [ball.material]).forEach((material) => material.dispose());
      disposeObject(path);
      runtime.render();
    };
  }, [nativeMode, nativeReplay, selectedNativeEvent, playing, seekVersion, loadState, runtimeVersion, layers.markers]);

  useEffect(() => {
    const runtime = runtimeRef.current;
    if (nativeMode || !runtime?.asset || !layers.markers || !replayShot || !canReplayGoal(replayShot)) return;
    let ball: THREE.Mesh;
    try { ball = cloneReplayBall(runtime.asset); styleShotBall(ball, replayShot.outcome); setReplayError(""); }
    catch (error) { setReplayError(String(error)); setPlaying(false); return; }
    runtime.scene.add(ball);
    const ring = new THREE.Mesh(new THREE.RingGeometry(.3, .36, 32), new THREE.MeshBasicMaterial({ color: 0x75ffff, side: THREE.DoubleSide, toneMapped: false, depthTest: false }));
    ring.renderOrder = 20;
    runtime.scene.add(ring);
    // DEV-only head-replay preview lifts the arc by a synthetic offset that has
    // nothing to do with observed data — it stays on the CatmullRom sampling
    // it always used, and stays labelled preview. Never treat it as real
    // bodyPart activation evidence. Outside preview, the Tube samples the
    // exact same analytic curve the static lines and the ball use, so none
    // of the three can visually diverge.
    const trajectoryCurve = silhouettePreview && previewMotion === "head"
      ? new THREE.CatmullRomCurve3(Array.from({ length: 49 }, (_, i) => {
          const point = replayPosition(replayShot, i / 48);
          point.y += 1.55 * (1 - i / 48);
          return point;
        }))
      : new ShotTrajectoryCurve(replayShot, replayShot.trajectory!.endY, replayShot.trajectory!.endZMeters);
    const path = new THREE.Mesh(
      new THREE.TubeGeometry(trajectoryCurve, 64, .025, 6, false),
      new THREE.MeshBasicMaterial({ color: 0xd9ffff, toneMapped: false }),
    );
    runtime.scene.add(path);
    let frame = 0;
    const initial = replayProgressRef.current;
    const started = performance.now();
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const draw = (now: number) => {
      const progress = playing && !reduced ? Math.min(1, initial + (now - started) / REPLAY_DURATION_MS) : initial;
      replayProgressRef.current = progress; setReplayProgress(progress);
      ball.position.copy(replayPosition(replayShot, silhouettePreview ? Math.max(0, (progress - .24) / .76) : progress));
      if (silhouettePreview && previewMotion === "head") ball.position.y += 1.55 * (1 - Math.max(0, (progress - .24) / .76));
      ring.position.copy(ball.position);
      ring.quaternion.copy(runtime.camera.quaternion);
      runtime.render();
      if (playing && !reduced && progress < 1) frame = requestAnimationFrame(draw);
      else if (playing) setPlaying(false);
    };
    draw(started);
    return () => {
      cancelAnimationFrame(frame); runtime.scene.remove(ball, path, ring);
      ring.geometry.dispose(); ring.material.dispose();
      ball.geometry.dispose();
      (Array.isArray(ball.material) ? ball.material : [ball.material]).forEach(m => m.dispose());
      disposeObject(path);
      runtime.render();
    };
  }, [nativeMode, replayShot, playing, seekVersion, loadState, runtimeVersion, layers.markers, silhouettePreview, previewMotion]);

  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    disposeObject(runtime.overlayRoot);
    runtime.overlayRoot.clear();
    disposeObject(runtime.zoneHitRoot);
    runtime.zoneHitRoot.clear();
    if (showTacticalZones) {
      addZoneHitMeshes(runtime.zoneHitRoot, zones);
      addTacticalGrid(runtime.overlayRoot);
    }
    // Box-region hit-testing stays available regardless of the 분석 구획·CCA
    // toggle — the box panel itself is always visible, so its 3D hover
    // target must not be hidden behind an unrelated grid preference.
    addBoxZoneHitMeshes(runtime.zoneHitRoot);
    if (layers.heatmap && groundDots.length) {
      runtime.overlayRoot.add(createContinuousGroundHeatmap(fullActivityHeatmap!.cellCounts));
      const accents = createGroundHeatmap(highDensityAccents(groundDots));
      accents.renderOrder = 3;
      runtime.overlayRoot.add(accents);
    }
    if (layers.cca) addContours(runtime.overlayRoot, fullActivityDisplay?.fullSourceCca, fullNormalized);
    // Markers stay excluded at group granularity: a group's whole marker/count
    // badge sits redundantly on top of the animated ball once that group's
    // shot is being replayed, so dropping the group is correct there.
    // Trajectories must NOT use that same group-level exclusion — a group
    // merges every raw event at one exact (x,y) behind a single representative
    // shot, so excluding by group silently hid sibling shots' own lines
    // whenever they shared a coordinate with the one actually being replayed.
    // Exclude exactly the replaying raw event instead, nothing else.
    if (nativeMode) {
      if (nativePitchEvents?.kind === "ready") addNativeShots(runtime.overlayRoot, nativeEvents, layers, runtime.asset);
    } else if (layers.markers || layers.trajectories) addShots(runtime.overlayRoot,
      replayShot ? markerGroups.filter(group => !group.sourceIndexes.includes(replayIndex!)) : markerGroups,
      excludeReplayingShot(visibleShots, replayShot ? replayIndex : null),
      medianXg, layers, markerPlacements, Boolean(replayShot), runtime.asset);
    if (hostRef.current) hostRef.current.dataset.nativeTrajectoryCount = String(runtime.overlayRoot.children.filter(child => child.userData.nativeTrajectoryKey).length);
    runtime.render();
    setProjectionVersion((value) => value + 1);
  }, [groundDots, fullActivityHeatmap, fullActivityDisplay, fullNormalized, layers, showTacticalZones, nativeMode, nativePitchEvents, nativeEvents, legacyNormalized, markerGroups, visibleShots, markerPlacements, medianXg, runtimeVersion, spatial, zones, replayShot, loadState]);

  const applyFreefly = useCallback((next: FreeflyCameraState) => {
    freeflyRef.current = next;
    setFreeflyState(next);
    const runtime = runtimeRef.current;
    if (runtime) {
      const target = freeflyLookTarget(next);
      runtime.camera.position.set(next.position.x, next.position.y, next.position.z);
      runtime.camera.lookAt(target.x, target.y, target.z);
      renderRuntime();
    }
  }, [renderRuntime]);

  const setZoomLevel = useCallback((next: number | ((current: number) => number)) => {
    setZoom((current) => {
      const clamped = clampWebglZoom(typeof next === "function" ? next(current) : next);
      const runtime = runtimeRef.current;
      if (runtime) {
        runtime.camera.zoom = clamped;
        runtime.camera.updateProjectionMatrix();
        renderRuntime();
      }
      return clamped;
    });
  }, [renderRuntime]);
  const moveCamera = useCallback((forward = 0, right = 0, vertical = 0) => {
    applyFreefly(moveFreeflyCamera(freeflyRef.current, { forward, right, vertical }));
  }, [applyFreefly]);
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const wheel = (event: WheelEvent) => {
      if (event.target !== host && event.target !== canvasRef.current) return;
      event.preventDefault();
      setZoomLevel((current) => current - event.deltaY * 0.0015);
    };
    host.addEventListener("wheel", wheel, { passive: false });
    return () => host.removeEventListener("wheel", wheel);
  }, [setZoomLevel]);
  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    const key = event.key.toLowerCase();
    if (!["w", "a", "s", "d"].includes(key)) return;
    event.preventDefault();
    const step = FREEFLY_MOVE_STEP_METERS;
    moveCamera(
      key === "w" ? step : key === "s" ? -step : 0,
      key === "d" ? step : key === "a" ? -step : 0,
    );
  };
  const resolveZoneAtPointer = (clientX: number, clientY: number): PitchSelectedZone | null => {
    const runtime = runtimeRef.current;
    const canvas = canvasRef.current;
    if (!runtime || !canvas) return null;
    const bounds = canvas.getBoundingClientRect();
    if (!bounds.width || !bounds.height || clientX < bounds.left || clientX > bounds.right ||
        clientY < bounds.top || clientY > bounds.bottom) return null;
    const raycaster = raycasterRef.current ?? new THREE.Raycaster();
    raycasterRef.current = raycaster;
    raycaster.setFromCamera(new THREE.Vector2(
      (clientX - bounds.left) / bounds.width * 2 - 1,
      -((clientY - bounds.top) / bounds.height) * 2 + 1,
    ), runtime.camera);
    // The box surface has strict analytic precedence over the coarser grid.
    // Its acquisition margin is intentionally not a fabricated box region:
    // if it resolves null, the real grid mesh underneath remains eligible.
    const hits = raycaster.intersectObjects(runtime.zoneHitRoot.children, false);
    const boxHit = hits.find((candidate) => candidate.object.userData.isBoxHitSurface === true);
    const boxRegionId = boxHit ? (() => {
      const point = worldToPitchPercent(boxHit.point);
      return resolveBoxSubregionId(point.x, point.y);
    })() : null;
    if (boxRegionId) return { kind: "box", id: boxRegionId };
    const zoneHit = hits.find((candidate) => typeof candidate.object.userData.zoneKey === "string");
    const zoneKey = zoneHit?.object.userData.zoneKey as string | undefined;
    const zone = zoneKey ? zonesByKey.get(zoneKey) : undefined;
    return zone ? { kind: "grid", id: tacticalGridZoneId(zone.cell.depth, zone.cell.lane) } : null;
  };

  const pointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget && event.target !== canvasRef.current) return;
    if (event.button !== 0 && event.button !== 2) return;
    if (event.pointerType === "touch") {
      touchPoints.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (touchPoints.current.size >= 2) {
        touchPoints.current.forEach((_, pointerId) => selectionBlockedPointersRef.current.add(pointerId));
        multiTouchRef.current = true;
        dragRef.current = null;
        event.currentTarget.setPointerCapture?.(event.pointerId);
        event.preventDefault();
        return;
      }
    }
    dragRef.current = { button: event.button, x: event.clientX, y: event.clientY, startX: event.clientX, startY: event.clientY, moved: false };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    event.currentTarget.focus();
    event.preventDefault();
  };
  const pointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "touch" && touchPoints.current.has(event.pointerId)) {
      touchPoints.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (touchPoints.current.size >= 2) {
        event.preventDefault();
        return;
      }
    }
    const drag = dragRef.current;
    if (drag) {
      const dx = event.clientX - drag.x;
      const dy = event.clientY - drag.y;
      dragRef.current = {
        ...drag,
        x: event.clientX,
        y: event.clientY,
        moved: drag.moved || Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) >= 4,
      };
      if (event.pointerType !== "touch") applyFreefly(drag.button === 0
        ? rotateFreeflyCamera(freeflyRef.current, -dx * FREEFLY_MOUSE_SENSITIVITY, -dy * FREEFLY_MOUSE_SENSITIVITY)
        : moveFreeflyCamera(freeflyRef.current, { vertical: -dy * 0.08 }));
    }
    const hovered = resolveZoneAtPointer(event.clientX, event.clientY);
    if (hovered?.kind === "box") {
      setHoveredBoxRegion(hovered.id);
      setHoveredZone(null);
    } else {
      setHoveredBoxRegion(null);
      setHoveredZone(hovered?.kind === "grid" ? zonesBySelectedId.get(hovered.id) ?? null : null);
    }
  };
  const finishPointer = (event: PointerEvent<HTMLDivElement>, cancelled: boolean) => {
    const drag = dragRef.current;
    const pinching = selectionBlockedPointersRef.current.has(event.pointerId) || multiTouchRef.current;
    if (drag && shouldSelectZoneOnPointerUp({ button: drag.button, moved: drag.moved, pinching, cancelled })) {
      const zone = resolveZoneAtPointer(event.clientX, event.clientY);
      if (zone) selectZone(zone);
    }
    dragRef.current = null;
    touchPoints.current.delete(event.pointerId);
    selectionBlockedPointersRef.current.delete(event.pointerId);
    multiTouchRef.current = false;
    if (touchPoints.current.size === 1) {
      const remaining = [...touchPoints.current.values()][0];
      dragRef.current = { button: 0, x: remaining.x, y: remaining.y, startX: remaining.x, startY: remaining.y, moved: false };
    }
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const pointerUp = (event: PointerEvent<HTMLDivElement>) => finishPointer(event, false);
  const pointerCancel = (event: PointerEvent<HTMLDivElement>) => finishPointer(event, true);
  const shotProjection = (group: PitchShotGroup) => projectWorld(
    runtimeRef.current,
    hostRef.current,
    markerPlacements.get(group.key)?.world ?? pitchPercentToWorld(group.shot, WEBGL_OVERLAY_Y_METERS + .03),
  );
  const nativeShotProjection = (event: NativePitchEvent) => {
    const origin = nativeMarkerOriginWorld(event);
    return origin ? projectWorld(runtimeRef.current, hostRef.current, origin) : { left: 50, top: 50, visible: false };
  };
  const zoneProjection = (zone: ZoneOverlay) => projectWorld(
    runtimeRef.current,
    hostRef.current,
    pitchPercentToWorld(zone.point, 0.24),
  );
  const boxZoneProjection = (zone: BoxZoneOverlay) => projectWorld(
    runtimeRef.current,
    hostRef.current,
    pitchPercentToWorld(zone.point, 0.24),
  );
  const boxRegionAt = (id: BoxRegionId): BoxSubregionRegion | undefined =>
    !nativeMode && boxSubregion?.kind === "ready" ? boxSubregion.data.regions.find((candidate) => candidate.id === id) : undefined;
  const nativeBoxRegionAt = (id: BoxRegionId) =>
    nativeMode && nativePitchEvents?.kind === "ready" ? nativePitchEvents.data.box.regions[id] : undefined;
  void projectionVersion;
  // Prefer the actual hovered/focused marker, but fall back to whichever
  // shot is actively replaying — `activeShot` is transient (it clears the
  // instant focus moves to, say, the 재생 button), so without this the result
  // tooltip and "a shot is selected" state used to vanish mid-playback even
  // though the ball was still visibly animating and a real shot was chosen.
  const activeGroup = markerGroups.find((group) => group.key === activeShot) ?? null;
  // A group's `.shot`/`.outcome` are only its representative — Kane has 11
  // penalty events sharing one exact coordinate, each with its own real
  // xG/xGOT/outcome, so falling back to the *group* here would silently show
  // the wrong event's result while a different one from that same group is
  // actually replaying. Override shot/outcome with the exact raw replaying
  // event; keep the rest of the group only for its (currently unused but
  // harmless) count/sourceIndexes metadata.
  const replayGroup = replayIndex != null ? markerGroups.find((group) => group.sourceIndexes.includes(replayIndex)) ?? null : null;
  const selectedShot = activeGroup ?? (replayGroup && replayShot ? { ...replayGroup, shot: replayShot, outcome: replayShot.outcome } : null);
  const goalLeft = projectWorld(runtimeRef.current, hostRef.current, { x: -3.66, y: 0.1, z: GLB_PITCH_HALF_LENGTH_METERS });
  const goalRight = projectWorld(runtimeRef.current, hostRef.current, { x: 3.66, y: 0.1, z: GLB_PITCH_HALF_LENGTH_METERS });
  const goalTop = projectWorld(runtimeRef.current, hostRef.current, { x: -3.66, y: 2.54, z: GLB_PITCH_HALF_LENGTH_METERS });
  const goalWidthPct = Math.hypot(goalRight.left - goalLeft.left, goalRight.top - goalLeft.top);
  const goalHeightPct = Math.hypot(goalTop.left - goalLeft.left, goalTop.top - goalLeft.top);
  const heatState = !fullActivityHeatmap ? "full Tier 3 활동 히트맵 사용 불가" :
    !heatValid ? "full Tier 3 활동 히트맵 무결성 불일치" :
      `full Tier 3 활동 좌표 ${fullActivityHeatmap.validPointCount}개`;
  const shotState = !spatial?.shotmapSnapshotAvailable ? "슈팅 스냅샷 사용 불가" :
    !shotsValid ? "슈팅 스냅샷 무결성 불일치" :
      spatial.shotmapPoints.length ? `슛 ${spatial.shotmapPoints.length}개` : "관측된 슛 0개";

  return <>
    {layers.markers && <div aria-label="슈팅 공 색상 범례" className="flex flex-wrap gap-4 bg-slate-900 px-3 py-2 text-sm text-white">
      {(Object.entries(SHOT_BALL_COLORS) as [ShotOutcome, number][]).map(([outcome, color]) => <span key={outcome} className="inline-flex items-center gap-2"><span aria-hidden="true" className="h-3 w-3 rounded-full" style={{ backgroundColor: `#${color.toString(16).padStart(6, '0')}` }} />{{ goal: '득점', on_target: '유효 슛', off_target: '빗나감', blocked: '블록' }[outcome]}</span>)}
    </div>}
    <div className="flex flex-wrap items-center gap-3 border-b border-white/15 bg-slate-900 px-3 py-2 text-white">
      <label className="text-sm">슈팅 데이터 원천 <select aria-label="슈팅 데이터 원천" value={shotSource} onChange={(event) => onShotSourceChange(event.target.value as "sportsapi" | "fotmob")} className="ml-2 rounded bg-slate-800 p-2"><option value="sportsapi">SportsAPI</option><option value="fotmob">FotMob</option></select></label>
      <button type="button" aria-pressed={showTacticalZones} onClick={() => { setShowTacticalZones(value => !value); setHoveredZone(null); }} className="min-h-11 rounded border border-white/30 px-3 text-sm font-bold aria-pressed:bg-white aria-pressed:text-slate-900">전술 구역</button>
      <span className="text-sm">30구역 안내선 · 공격 박스 4분할</span>
      {nativeMode && <span className="text-sm text-cyan-100">SportsAPI 동일 기록 이벤트 · 활동 히트맵은 별도 원천</span>}
    </div>
    {!nativeMode && layers.markers && <section aria-label="득점·유효슛 모식 재생 시제품" className="border-b border-white/20 bg-slate-950 p-3 text-white">
      <strong>{nativeMode ? "SportsAPI 실제 기록 슛 · 모식 재생" : "득점·유효슛 장면 시제품 · 기록 기반 모식 재생"}</strong>
      {silhouettePreview && <div data-silhouette-state={silhouetteState} className="my-2 rounded border border-amber-300 p-3 text-amber-200">
        <strong>시안 전용 · 동작 수동 선택 / 실제 슛 부위와 무관</strong>
        <label className="ml-3">실루엣 동작 <select aria-label="시안 실루엣 동작" className="bg-slate-800 p-2" value={previewMotion} onChange={e => { setPreviewMotion(e.target.value); setPlaying(false); replayProgressRef.current = 0; setReplayProgress(0); }}>
          <option value="right_foot">오른발</option><option value="left_foot">왼발</option><option value="head">헤딩</option>
        </select></label><span className="ml-3">모델: {silhouetteState}</span>
        {silhouetteState === "error" && <p role="alert">실루엣 에셋 로딩 실패</p>}
      </div>}
      <p data-replay-short-note className="text-sm text-zinc-300">기록 기반 모식 재생 · 실제 비행 궤적 아님</p>
      <details className="mt-1 text-sm text-zinc-400">
        <summary className="cursor-pointer select-none text-zinc-300">재생 안내 자세히</summary>
        <p className="mt-1">유효슛의 골문 좌표는 선방 위치를 뜻하지 않습니다. 골문 방향의 도식이며 실제 선방·리바운드는 재현하지 않습니다.</p>
        <p className="mt-1">시작·골문 도달 좌표는 기록값입니다. 중간 포물선·2.4초 재생 시간은 연출이며 실제 속도·회전·비행 궤적이 아닙니다. 골라인 도달까지 표시합니다.</p>
      </details>
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <label>슈팅 선택 <select aria-label="재생할 슈팅" value={nativeMode ? selectedNativeEventKey ?? "" : replayIndex ?? ""} className="bg-slate-800 p-2" onChange={event => {
          if (nativeMode) selectNativeShot(event.target.value === "" ? null : event.target.value);
          else selectLegacyShot(event.target.value === "" ? null : Number(event.target.value));
        }}><option value="">전체 슈팅 탐색</option>{nativeMode ? nativeEvents.map((event) => <option key={event.key} value={event.key}>{NATIVE_OUTCOME_LABEL[event.outcome]} · {NATIVE_BODY_PART_LABEL[event.bodyPart]} · xG {formatShotMetric(event.xg)}{event.isPenalty ? " · PK" : ""}</option>) : shotsValid && spatial!.shotmapPoints.map((shot, index) => canReplayGoal(shot) ?
          <option key={index} value={index}>{shot.outcome === "goal" ? "득점" : "유효슛"} #{index + 1} · xG {formatShotMetric(shot.xg)} · ({shot.x.toFixed(1)}, {shot.y.toFixed(1)})</option> : null)}</select></label>
        <button disabled={!(nativeMode ? nativeReplay : replayShot) || loadState !== "ready"} onClick={() => {
          if (replayProgressRef.current >= 1) { replayProgressRef.current = 0; setReplayProgress(0); }
          setPlaying(value => !value);
        }} className="rounded border px-3 py-2 disabled:opacity-40">{playing ? "일시정지" : "재생"}</button>
        <button disabled={!(nativeMode ? nativeReplay : replayShot)} onClick={() => { setPlaying(false); replayProgressRef.current = 0; setReplayProgress(0); setSeekVersion(v => v + 1); }} className="rounded border px-3 py-2 disabled:opacity-40">처음으로</button>
        <label>재생 위치 <input aria-label="재생 위치" type="range" min="0" max="100" value={Math.round(replayProgress * 100)} disabled={!(nativeMode ? nativeReplay : replayShot)} onChange={event => {
          setPlaying(false); replayProgressRef.current = Number(event.target.value) / 100; setReplayProgress(replayProgressRef.current); setSeekVersion(v => v + 1);
        }}/></label>
        <output data-replay-progress={replayProgress.toFixed(3)}>{Math.round(replayProgress * 100)}%</output>
      </div>
      {replayError && <p role="alert">{replayError}</p>}
    </section>}
    <p className="border-b border-white/10 bg-black/25 px-3 py-2 text-sm text-zinc-200">WASD 이동 · 좌드래그 앵글 · 우드래그 높이 · 휠 줌</p>
    <div className="lg:grid lg:grid-cols-[1fr_20rem] lg:items-start lg:gap-3">
    <div ref={hostRef} role="img" tabIndex={0} onKeyDown={keyDown}
      onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={pointerCancel}
      onLostPointerCapture={pointerCancel}
      onPointerLeave={() => { setHoveredZone(null); setHoveredBoxRegion(null); }}
      onContextMenu={(event) => event.preventDefault()}
      aria-label={`3D 회랑 WebGL 피치. ${heatState}. ${shotState}. WASD로 이동하고, 왼쪽 드래그로 앵글을 조절하며, 오른쪽 드래그로 높이를 조절하고, 휠로 확대·축소합니다.`}
      className="relative min-h-80 w-full overflow-hidden rounded-b-lg bg-[#050a08] outline-none focus-visible:ring-2 focus-visible:ring-orange-200"
      data-webgl-renderer="three"
      data-shot-source={shotSource}
      data-native-data-state={nativePitchEvents?.kind ?? "unrequested"}
      data-native-pose-state={nativePoseState}
      data-native-pose-key={selectedNativeEvent?.key ?? ""}
      data-native-pose-asset={selectedNativeEvent ? nativePosePlacement(selectedNativeEvent)?.assetUrl ?? "" : ""}
      data-native-pose-motion={selectedNativeEvent ? nativePosePlacement(selectedNativeEvent)?.motion ?? "" : ""}
      data-gltf-loader="GLTFLoader"
      data-gltf-url={MODEL_URL}
      data-webgl-state={loadState}
      data-zone-hover-mode="raycaster"
      data-camera-mode="freefly"
      data-selected-zone={selectedZone ? selectedZone.id : ""}
      data-selected-zone-kind={selectedZone?.kind ?? ""}
      data-camera-azimuth={Number(freeflyState.yaw.toFixed(2))}
      data-camera-elevation={Number((-freeflyState.pitch).toFixed(2))}
      data-camera-distance={DEFAULT_WEBGL_CAMERA.distance}
      data-camera-zoom={zoom}
      data-camera-frame-from-x={0}
      data-camera-pivot={`${(pivot.x * 1.05).toFixed(2)},${(pivot.y * 0.68).toFixed(2)},0`}
      data-camera-position={`${freeflyState.position.x.toFixed(2)},${freeflyState.position.y.toFixed(2)},${freeflyState.position.z.toFixed(2)}`}
      data-visible-shot-count={nativeMode ? nativeMarkerEvents.length : visibleShots.length}
      data-total-shot-count={nativeMode ? nativeEvents.length : visibleShots.length}
      data-attacking-goal-width-pct={goalWidthPct.toFixed(2)}
      data-attacking-goal-height-pct={goalHeightPct.toFixed(2)}>
      <canvas ref={canvasRef} aria-hidden="true" className="block h-auto w-full touch-none" />
      <span className="absolute bottom-2 left-2 rounded bg-black/60 px-2 py-1 text-xs text-white">{nativeMode ? "SportsAPI 기록 슛 · 박스 4구역 / 활동 히트맵은 별도 원천" : showTacticalZones ? "30구역 · 박스 4분할 · Soccerlab 자체 구획 | 개인 내 상대 밀도" : "개인 내 상대 밀도 · 청록 → 노랑 → 주황 | 표시 보간 192×124 · 원천 32×22"}</span>
      {loadState === "loading" && <div role="status" className="absolute inset-0 grid place-items-center bg-[#050a08]/70 text-sm font-bold text-zinc-200">3D 피치 자산 로딩…</div>}
      {(loadState === "error" || loadState === "unsupported") && <div role="alert" className="absolute inset-0 grid place-items-center bg-[#050a08] p-6 text-center text-sm font-bold text-rose-200">{loadState === "unsupported" ? "WebGL 피치를 표시할 수 없습니다." : "경기장 모델을 불러오지 못했습니다."} {loadError}</div>}

      {layers.heatmap && <div hidden data-layer="heat" data-density-source="dot-matrix-64x24" data-density-input="full-tier3-32x22"
        data-ground-dot-columns="192" data-ground-dot-rows="124" data-ground-dot-subdivision="bilinear-native-density" data-ground-palette="cyan-yellow-orange" data-ground-dot-count={groundDots.length}
        data-density-dot-columns={WEBGL_DOTMATRIX_COLUMNS} data-density-dot-rows={WEBGL_DOTMATRIX_ROWS}
        data-blur-std-deviation="0" data-density-mesh-builds="1">
        {densityDots.map((dot) => <span key={`${dot.row}-${dot.column}`} data-density-dot=""
          data-density-row={dot.row} data-density-column={dot.column}
          data-density-normalized={dot.density} data-density-radius-meters={dot.radiusMeters} />)}
      </div>}
      {layers.cca && fullActivityDisplay?.fullSourceCca.available && fullActivityDisplay.fullSourceCca.thresholdOfPeak !== null && <div hidden data-layer="cca-contour" data-cca-definition={fullActivityDisplay.fullSourceCca.definitionVersion} data-cca-source-revision={fullActivityDisplay.fullSourceCca.sourceRevision} data-contour-segments={marchingSquares(fullNormalized, fullActivityDisplay.fullSourceCca.thresholdOfPeak).length} />}
        {showTacticalZones && <div hidden data-layer="positional-grid" data-zone-count="30">{Array.from({ length: 10 }, (_, index) => <span key={index} data-grid-segment={index} />)}</div>}
      <div hidden data-layer="goals"><span data-goal="defending" data-goal-post-near-y="44.61764705882353" data-goal-post-far-y="55.38235294117647" data-goal-crossbar-height-meters="2.44" /><span data-goal="attacking" data-goal-post-near-y="44.61764705882353" data-goal-post-far-y="55.38235294117647" data-goal-crossbar-height-meters="2.44" /></div>
      {(layers.markers || layers.trajectories) && <div hidden data-layer="shots" id={markerLayerId} />}

      {layers.markers && nativeMode && nativeMarkerEvents.map((event, index) => {
        const projected = nativeShotProjection(event);
        const id = `webgl-native-shot-${event.key}`;
        return <button key={event.key} id={id} type="button" data-native-event-key={event.key}
          data-native-body-part={event.bodyPart} data-native-outcome={event.outcome}
          data-pitch-x={event.plot.x ?? ""} data-pitch-y={event.plot.y ?? ""}
          tabIndex={selectedNativeEventKey === event.key || selectedNativeEventKey === null && index === 0 ? 0 : -1}
          aria-label={`${NATIVE_OUTCOME_LABEL[event.outcome]} · ${NATIVE_BODY_PART_LABEL[event.bodyPart]} · xG ${formatShotMetric(event.xg)}`}
          onClick={() => selectNativeShot(event.key)}
          onKeyDown={(keyboard) => {
            if (!/^Arrow(Right|Left|Up|Down)$/.test(keyboard.key) || nativeMarkerEvents.length === 0) return;
            keyboard.preventDefault(); const direction = keyboard.key === "ArrowRight" || keyboard.key === "ArrowDown" ? 1 : -1;
            const next = nativeMarkerEvents[(index + direction + nativeMarkerEvents.length) % nativeMarkerEvents.length];
            selectNativeShot(next.key); document.getElementById(`webgl-native-shot-${next.key}`)?.focus();
          }}
          className="absolute z-20 min-h-6 min-w-6 -translate-x-1/2 -translate-y-1/2 rounded-full bg-transparent text-transparent outline-none focus-visible:ring-2 focus-visible:ring-white"
          style={{ left: `${projected.left}%`, top: `${projected.top}%`, display: projected.visible ? undefined : "none" }}><span className="sr-only">SportsAPI 기록 슛 선택</span></button>;
      })}
      {layers.markers && !nativeMode && markerGroups.map((group, index) => {
        const projected = shotProjection(group);
        const id = `webgl-shot-${group.key}`;
        return <button key={group.key} id={id} type="button" data-shot-marker="" data-shot-index={group.sourceIndexes[0]}
          data-shot-indexes={group.sourceIndexes.join(",")} data-shot-outcome={group.outcome}
          data-marker-symbol={outcomePresentation[group.outcome].symbol}
          data-marker-renderer="asset-football" data-marker-size={.11}
          data-marker-count={group.count} data-pitch-x={group.shot.x} data-pitch-y={group.shot.y}
          data-marker-offset-meters={markerPlacements.get(group.key)?.offsetMeters.join(",") ?? "0,0"}
          tabIndex={activeShot === group.key || activeShot === null && index === 0 ? 0 : -1}
          aria-label={`${shotMarkerLabel(group.shot)}${group.count > 1 ? ` ${group.count} shots share this exact coordinate.` : ""}`}
          onClick={() => {
            setSelectedZone(null);
            setActiveShot(group.key);
            if (group.count === 1 && canReplayGoal(group.shot)) {
              selectLegacyShot(group.sourceIndexes[0]);
            }
          }} onFocus={() => setActiveShot(group.key)} onBlur={() => setActiveShot(null)}
          onPointerEnter={() => setActiveShot(group.key)} onPointerLeave={() => setActiveShot(null)}
          onKeyDown={(event) => {
            if (event.key !== "ArrowRight" && event.key !== "ArrowDown" && event.key !== "ArrowLeft" && event.key !== "ArrowUp") return;
            event.preventDefault();
            const direction = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : -1;
            const next = markerGroups[(index + direction + markerGroups.length) % markerGroups.length];
            setActiveShot(next.key);
            document.getElementById(`webgl-shot-${next.key}`)?.focus();
          }}
          className="absolute z-20 min-h-6 min-w-6 -translate-x-1/2 -translate-y-1/2 rounded-full bg-transparent text-transparent outline-none focus-visible:ring-2 focus-visible:ring-white"
          style={{ left: `${projected.left}%`, top: `${projected.top}%`, display: projected.visible ? undefined : "none" }}>
          <span className="sr-only">{group.count > 1 ? `${group.count}개 동일 좌표 슛` : "슛 상세 열기"}</span>
        </button>;
      })}
      {!nativeMode && layers.trajectories && markerGroups.flatMap((group) => group.shot.trajectory?.endpointKind === "goal_mouth" && typeof group.shot.trajectory.endZMeters === "number" ?
        [<span key={group.key} hidden data-shot-trajectory="" data-trajectory-kind="goal_mouth"
          data-trajectory-outcome={group.outcome} data-end-pitch-x={group.shot.trajectory.endX}
          data-end-pitch-y={group.shot.trajectory.endY}
          data-end-goal-mouth={group.shot.trajectory.endY >= 44.61764705882353 && group.shot.trajectory.endY <= 55.38235294117647 ? "inside" : "outside"}
          data-end-height-meters={group.shot.trajectory.endZMeters} />] : [])}
      {BOX_ZONES.map((zone) => {
        const projected = boxZoneProjection(zone);
        const bounds = BOX_SUBREGION_BOUNDS[zone.id];
        const region = nativeMode ? nativeBoxRegionAt(zone.id) : boxRegionAt(zone.id);
        const ready = region && region.shots !== null;
        const label = ready
          ? `${region!.label}. 슛 ${region!.shots}개, 득점 ${region!.goals}개, xGOT − xG ${region!.quality.state === "unavailable" ? "미상" : region!.quality.delta!.toFixed(2)}.`
          : `${bounds.label}. 박스 구역 통계를 사용할 수 없습니다.`;
        return <button key={zone.id} type="button"
          data-box-zone-keyboard-target={zone.id}
          aria-label={label}
          onClick={() => selectZone({ kind: "box", id: zone.id })}
          onFocus={() => { setHoveredBoxRegion(zone.id); setHoveredZone(null); }} onBlur={() => setHoveredBoxRegion(null)}
          className="pointer-events-none absolute z-10 h-6 w-6 -translate-x-1/2 -translate-y-1/2 rounded bg-transparent text-transparent outline-none focus-visible:ring-2 focus-visible:ring-orange-200"
          style={{ left: `${projected.left}%`, top: `${projected.top}%`, display: projected.visible ? undefined : "none" }} />;
      })}
      {showTacticalZones && zones.map((zone) => {
        const projected = zoneProjection(zone);
        const selectedId = tacticalGridZoneId(zone.cell.depth, zone.cell.lane);
        return <button key={`${zone.cell.depth}-${zone.cell.lane}`} type="button"
          data-zone-keyboard-target={selectedId}
          data-zone-shot-share={zone.summary.shotSharePct.toFixed(2)}
          aria-label={nativeMode
            ? `전술 구역 ${selectedId}. SportsAPI 선택은 해당 구역의 기하 위치만 사용합니다.`
            : `구역 ${zone.cell.depth * 5 + zone.cell.lane + 1}. 슈팅 비중 ${zone.summary.shotSharePct.toFixed(2)}%, 활동 ${zone.cell.occupancyPct.toFixed(2)}%.`}
          onClick={() => selectZone({ kind: "grid", id: selectedId })}
          onFocus={() => setHoveredZone(zone)} onBlur={() => setHoveredZone(null)}
          className="pointer-events-none absolute z-10 h-6 w-6 -translate-x-1/2 -translate-y-1/2 rounded bg-transparent text-transparent outline-none focus-visible:ring-2 focus-visible:ring-orange-200"
          style={{ left: `${projected.left}%`, top: `${projected.top}%`, display: projected.visible ? undefined : "none" }} />;
      })}
      <p className="sr-only">WebGL 장면 요약: 활동 좌표 {fullActivityHeatmap?.available ? fullActivityHeatmap.validPointCount : 0}개, 유효 슈팅 이벤트 {shotsValid ? spatial!.shotmapPoints.length : 0}개, 점유 라벨 {zones.length}개. 실제 GLTFLoader 모델과 Three.js 카메라를 사용합니다.</p>
    </div>
    {/* Below `lg` this sits in normal document flow BELOW the canvas — a
        mobile canvas is short enough (~320px) that the old always-absolute
        top-right dock (224px × up to ~580px of real content) got clipped by
        the host's own overflow-hidden, hiding most of the body-part/box
        stats. The old absolute overlay had a second defect even where it
        wasn't clipped: it sat ON TOP of the canvas, so a wide enough dock to
        stay readable (not breaking "9슛 · 2골 · xG 0.33" across lines)
        necessarily covered pitch markers and the selected shot's path. A
        dedicated grid column at `lg` (see the wrapper above) reserves real
        space beside the canvas instead — the existing ResizeObserver on
        `hostRef` already resizes the renderer/camera to whatever width that
        leaves it, so nothing overlaps at any breakpoint. */}
    <div data-pitch-info-dock className="mt-3 w-full lg:mt-0 lg:w-80">
      {nativeMode ? nativePitchEvents?.kind === "ready" ? <NativePitchSelectionCard
        key={`${nativePitchEvents.key}:${selectedNativeEvent?.key ?? selectedZone?.id ?? "overview"}`}
        data={nativePitchEvents.data} event={selectedNativeEvent} zone={selectedZone}
        onClose={() => { selectZone(null); selectNativeShot(null); }}
        controls={<div className="space-y-2">
          <select aria-label="재생할 슈팅" className="w-full rounded-lg border border-white/15 bg-[#202c40] p-2 text-xs"
            value={selectedNativeEventKey ?? ""} onChange={event => selectNativeShot(event.target.value || null)}>
            <option value="">전체 슈팅 탐색</option>
            {nativeEvents.map(event => <option key={event.key} value={event.key}>{NATIVE_OUTCOME_LABEL[event.outcome]} · {NATIVE_BODY_PART_LABEL[event.bodyPart]} · xG {formatShotMetric(event.xg)}{event.isPenalty ? " · PK" : ""}</option>)}
          </select>
          {selectedNativeEvent && <div className="flex items-center gap-2">
            <button aria-label={playing ? "일시정지" : "재생"} disabled={!nativeReplay || loadState !== "ready"}
              className="h-10 w-10 shrink-0 rounded-full bg-[#f16d78] font-bold text-[#172131] disabled:opacity-30"
              onClick={() => { if (replayProgressRef.current >= 1) { replayProgressRef.current = 0; setReplayProgress(0); } setPlaying(value => !value); }}>{playing ? "Ⅱ" : "▶"}</button>
            <input aria-label="재생 위치" type="range" className="min-w-0 flex-1 accent-[#f16d78]" min="0" max="100"
              value={Math.round(replayProgress * 100)} disabled={!nativeReplay} onChange={event => {
                setPlaying(false); replayProgressRef.current = Number(event.target.value) / 100; setReplayProgress(replayProgressRef.current); setSeekVersion(v => v + 1);
              }} />
            <output className="text-xs" data-replay-progress={replayProgress.toFixed(3)}>{Math.round(replayProgress * 100)}%</output>
          </div>}
          {selectedNativeEvent && !nativeReplay && <p className="text-xs text-[#a9b8c9]">관측 종점 없음 · 궤적 미표시</p>}
          {nativePoseState === "error" && <p role="alert" className="text-xs text-amber-200">신체 동작을 불러오지 못했습니다.</p>}
          {replayError && <p role="alert" className="text-xs text-amber-200">{replayError}</p>}
        </div>}
      /> : <div role="status" className="rounded-2xl border border-white/15 bg-[#172131] p-4 text-sm text-slate-300">
        {nativePitchEvents?.kind === "loading" ? "슈팅 정보를 불러오는 중…" : "슈팅 정보를 사용할 수 없습니다."}
      </div> : <>
      <BodyPartShootingPanel hasSelectedShot={nativeMode ? Boolean(selectedNativeEvent) : Boolean(selectedShot)} selectedBodyPart={nativeMode ? selectedNativeEvent?.bodyPart : undefined} state={nativeBodyState} />
      {boxSubregion && <BoxSubregionPanel state={boxSubregion} activeRegionId={hoveredBoxRegion} />}
      {!nativeMode && selectedShot && (() => {
        return <div role="tooltip" className="rounded border border-white/25 bg-[#0b0e0f]/95 p-2 text-xs text-zinc-100">
          <strong>{outcomePresentation[selectedShot.outcome].label}</strong><br />xG {formatShotMetric(selectedShot.shot.xg)} · xGOT {formatShotMetric(selectedShot.shot.xgot)}
        </div>;
      })()}
      {!nativeMode && hoveredZone && <div data-zone-tooltip role="tooltip" className="rounded-2xl border border-white/30 bg-[#101c19]/85 p-4 text-zinc-100 shadow-xl backdrop-blur-md">
          <div className="flex items-center justify-between gap-3 text-xs text-white/65"><span className="rounded-full border border-white/20 px-2 py-1">구역 {hoveredZone.cell.depth * 5 + hoveredZone.cell.lane + 1}</span><span>슈팅 퀄리티</span></div>
          <p data-zone-shooting-quality="unavailable" className="mt-2 font-mono text-3xl font-semibold tracking-tight">—<span className="ml-2 text-xs text-white/60">xGOT − xG</span></p>
          <p className="mt-1 text-xs text-amber-200/90">구역별 품질 데이터 미연결</p>
          <dl className="mt-3 grid grid-cols-3 gap-2 border-t border-white/15 pt-3">
            {[["슛", hoveredZone.summary.shots], ["득점", hoveredZone.summary.goals], ["xG", hoveredZone.summary.xg.toFixed(2)]].map(([label, value]) => <div key={label}><dt className="text-xs text-white/55">{label}</dt><dd className="mt-1 font-mono text-base font-semibold">{value}</dd></div>)}
          </dl>
          <p className="mt-3 text-xs text-white/60">활동 비중 <span className="float-right font-mono text-white/85">{hoveredZone.cell.occupancyPct.toFixed(1)}%</span></p>
          <p className="mt-2 text-xs text-white/60">슈팅 비중 <span className="float-right font-mono text-white/85">{hoveredZone.summary.shotSharePct.toFixed(1)}%</span></p>
        </div>}
      {hoveredBoxRegion && (() => {
        const bounds = BOX_SUBREGION_BOUNDS[hoveredBoxRegion];
        const region = nativeMode ? nativeBoxRegionAt(hoveredBoxRegion) : boxRegionAt(hoveredBoxRegion);
        const ready = region && region.shots !== null;
        const legacyActivityShare = !nativeMode && region ? (region as BoxSubregionRegion).activitySharePct : null;
        return <div data-box-zone-tooltip data-box-zone-id={hoveredBoxRegion} data-box-zone-state={ready ? "ready" : "unavailable"} role="tooltip" className="rounded-2xl border border-white/30 bg-[#101c19]/85 p-4 text-zinc-100 shadow-xl backdrop-blur-md">
          <div className="flex items-center justify-between gap-3 text-xs text-white/65"><span className="rounded-full border border-white/20 px-2 py-1">{ready ? region!.label : bounds.label}</span><span>박스 구역 슈팅</span></div>
          {ready ? <>
            <p data-box-zone-quality={region!.quality.state} className="mt-2 font-mono text-3xl font-semibold tracking-tight">{region!.quality.state === "unavailable" ? "—" : `${region!.quality.delta! >= 0 ? "+" : ""}${region!.quality.delta!.toFixed(2)}`}<span className="ml-2 text-xs text-white/60">xGOT − xG</span></p>
            {region!.quality.state !== "unavailable" && <p className="mt-1 text-xs text-white/50">적격 {region!.quality.eligible}/{region!.shots}{region!.quality.state === "partial" && <span className="ml-1 text-amber-200/80">일부 표본</span>}</p>}
            <dl className="mt-3 grid grid-cols-3 gap-2 border-t border-white/15 pt-3">
              {[["슛", region!.shots], ["득점", region!.goals], ["xG", region!.xg === null ? "—" : region!.xg.toFixed(2)]].map(([label, value]) => <div key={label}><dt className="text-xs text-white/55">{label}</dt><dd className="mt-1 font-mono text-base font-semibold">{value}</dd></div>)}
            </dl>
            {nativeMode ? <p className="mt-3 text-xs text-white/60">활동 비중 <span className="float-right font-mono text-white/85">— (별도 활동 원천)</span></p> : <p className="mt-3 text-xs text-white/60">활동 비중 <span className="float-right font-mono text-white/85">{legacyActivityShare === null ? "—" : `${legacyActivityShare.toFixed(1)}%`}</span></p>}
            <p className="mt-2 text-xs text-white/60">슈팅 비중 <span className="float-right font-mono text-white/85">{region!.shootingSharePct === null ? "—" : `${region!.shootingSharePct.toFixed(1)}%`}</span></p>
          </> : <p className="mt-2 text-xs text-amber-200/90">박스 구역 통계를 사용할 수 없습니다.</p>}
        </div>;
      })()}
      </>}
    </div>
    </div>
  </>;
}
