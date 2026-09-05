import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

import type { FullActivityHeatmapData } from "../api/fullActivityHeatmapContracts";
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
  FREEFLY_HEIGHT_STEP_METERS,
  FREEFLY_MOUSE_SENSITIVITY,
  FREEFLY_MOVE_STEP_METERS,
  GLB_PITCH_HALF_LENGTH_METERS,
  GLB_PITCH_LENGTH_METERS,
  GLB_PITCH_WIDTH_METERS,
  WEBGL_CAMERA_PRESETS,
  WEBGL_OVERLAY_Y_METERS,
  WEBGL_ZOOM,
  clampWebglZoom,
  freeflyLookTarget,
  freeflyStateFromOrbit,
  moveFreeflyCamera,
  pitchPercentToWorld,
  rotateFreeflyCamera,
  trajectoryWorldPoints,
  type CameraAngle,
  type FreeflyCameraState,
  type OrbitCameraState,
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
  type WebglDensityDot,
  type WebglShotPlacement,
} from "./webglDotMatrix";

const MODEL_URL = "/assets/footballpitchv3.glb";
const DEPTH_BOUNDARIES = [0, 16.67, 33.33, 50, 66.67, 83.33, 100] as const;
const LANE_BOUNDARIES = [0, 21.82, 37, 63, 78.18, 100] as const;
const END_ON_ANGLES = new Set<CameraAngle>(["goalFront", "goalBack"]);
const markerColors: Record<ShotOutcome, number> = {
  goal: 0xbef264,
  on_target: 0x38bdf8,
  off_target: 0xe2e8f0,
  blocked: 0x94a3b8,
};
const cameraLabels: Record<CameraAngle, string> = {
  left: "좌측",
  right: "우측",
  goalFront: "골대 정면",
  goalBack: "골대 뒤",
};

type OccupancyCell = { depth: number; lane: number; occupancyPct: number };
type ZoneSummary = { shots: number; goals: number; xg: number; shotSharePct: number };
type ZoneOverlay = { cell: OccupancyCell; summary: ZoneSummary; point: PitchPercentPoint };
type ProjectedPoint = { left: number; top: number; visible: boolean };
type Runtime = {
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
          if (value instanceof THREE.Texture) value.dispose();
        });
        material.dispose();
      });
    }
  });
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
  const color = 0xb7e4c7;
  for (const depth of DEPTH_BOUNDARIES.slice(1, -1)) {
    root.add(line([
      pitchPercentToWorld({ x: depth, y: 0 }, 0.095),
      pitchPercentToWorld({ x: depth, y: 100 }, 0.095),
    ], color, 0.28, true));
  }
  for (const lane of LANE_BOUNDARIES.slice(1, -1)) {
    root.add(line([
      pitchPercentToWorld({ x: 0, y: lane }, 0.095),
      pitchPercentToWorld({ x: 100, y: lane }, 0.095),
    ], color, 0.28, true));
  }
  root.add(line([
    pitchPercentToWorld({ x: 84.29, y: 50 }, 0.11),
    pitchPercentToWorld({ x: 100, y: 50 }, 0.11),
  ], 0xf8fafc, 0.38, true));
}

function addZoneHitMeshes(root: THREE.Group, zones: readonly ZoneOverlay[]) {
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

function addDotMatrixHeatmap(root: THREE.Group, dots: readonly WebglDensityDot[]) {
  if (!dots.length) return;
  const positions = new Float32Array(dots.length * 3);
  const colors = new Float32Array(dots.length * 4);
  const sizes = new Float32Array(dots.length);
  dots.forEach((dot, index) => {
    positions.set([dot.world.x, dot.world.y, dot.world.z], index * 3);
    colors.set([dot.color[0] / 255, dot.color[1] / 255, dot.color[2] / 255, dot.color[3]], index * 4);
    sizes[index] = dot.radiusMeters;
  });
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("aColor", new THREE.BufferAttribute(colors, 4));
  geometry.setAttribute("aSize", new THREE.BufferAttribute(sizes, 1));
  const material = new THREE.ShaderMaterial({
    transparent: true,
    depthTest: false,
    depthWrite: false,
    vertexShader: `attribute vec4 aColor; attribute float aSize; varying vec4 vColor;
      void main() { vec4 mvPosition = modelViewMatrix * vec4(position, 1.0); vColor = aColor;
      gl_PointSize = clamp(aSize * 2800.0 / max(1.0, -mvPosition.z), 2.0, 28.0);
      gl_Position = projectionMatrix * mvPosition; }`,
    fragmentShader: `varying vec4 vColor; void main() { vec2 centre = gl_PointCoord - vec2(.5);
      if (dot(centre, centre) > .25) discard; gl_FragColor = vColor; }`,
  });
  const points = new THREE.Points(geometry, material);
  points.renderOrder = 2;
  root.add(points);
}

function addContours(
  root: THREE.Group,
  spatial: PlayerAnalysis["spatial"] | undefined,
  normalized: Float64Array,
) {
  const core = spatial?.continuousCore;
  if (!core?.available || core.gridColumns !== HEATMAP_COLUMNS || core.gridRows !== HEATMAP_ROWS ||
      !Number.isFinite(core.thresholdOfPeak) || core.thresholdOfPeak <= 0) return;
  for (const [x1, y1, x2, y2] of marchingSquares(normalized, core.thresholdOfPeak)) {
    root.add(line([
      pitchPercentToWorld({ x: x1, y: 100 - y1 }, 0.16),
      pitchPercentToWorld({ x: x2, y: 100 - y2 }, 0.16),
    ], 0xffffff, 0.82, true));
  }
}

function addShots(
  root: THREE.Group,
  groups: readonly PitchShotGroup[],
  medianXg: number | null,
  layers: PitchLayerVisibility,
  placements: ReadonlyMap<string, WebglShotPlacement>,
) {
  for (const group of groups) {
    if (layers.markers) {
      const placement = placements.get(group.key);
      if (!placement) continue;
      const marker = new THREE.Mesh(
        new THREE.CircleGeometry(placement.radiusMeters, 18),
        new THREE.MeshBasicMaterial({ color: markerColors[group.outcome], transparent: true, opacity: group.outcome === "goal" ? .98 : .82, depthTest: false, depthWrite: false, side: THREE.DoubleSide }),
      );
      marker.rotation.x = -Math.PI / 2;
      marker.position.set(placement.world.x, placement.world.y, placement.world.z);
      marker.renderOrder = 5;
      root.add(marker);
    }
    const trajectory = group.shot.trajectory;
    if (layers.trajectories && trajectory?.endpointKind === "goal_mouth" && typeof trajectory.endZMeters === "number") {
      root.add(line(
        trajectoryWorldPoints(group.shot, trajectory.endY, trajectory.endZMeters),
        markerColors[group.outcome],
        group.outcome === "goal" ? 0.9 : group.outcome === "on_target" ? 0.62 : 0.25,
      ));
    }
  }
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
}: {
  spatial: PlayerAnalysis["spatial"] | undefined;
  visibleOutcomes: ReadonlySet<ShotOutcome>;
  markerLayerId: string;
  contextIdentity: string;
  layers: PitchLayerVisibility;
  fullActivityHeatmap?: FullActivityHeatmapData;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const runtimeRef = useRef<Runtime | null>(null);
  const [runtimeVersion, setRuntimeVersion] = useState(0);
  const [projectionVersion, setProjectionVersion] = useState(0);
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error" | "unsupported">("loading");
  const [loadError, setLoadError] = useState("");
  const [cameraAngle, setCameraAngle] = useState<CameraAngle | null>(null);
  const [cameraState, setCameraState] = useState(DEFAULT_WEBGL_CAMERA);
  const [freeflyState, setFreeflyState] = useState<FreeflyCameraState>(() =>
    freeflyStateFromOrbit(DEFAULT_WEBGL_CAMERA, { x: 0, y: WEBGL_OVERLAY_Y_METERS, z: 0 }));
  const freeflyRef = useRef(freeflyState);
  const dragRef = useRef<{ button: number; x: number; y: number } | null>(null);
  const raycasterRef = useRef<THREE.Raycaster | null>(null);
  const [zoom, setZoom] = useState(1);
  const [hoveredZone, setHoveredZone] = useState<ZoneOverlay | null>(null);
  const [activeShot, setActiveShot] = useState<string | null>(null);

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
  const pivot = useMemo(() => deriveWebglPivot(spatial, legacyNormalized), [legacyNormalized, spatial]);
  const pivotWorld = useMemo(() => pitchPercentToWorld(pivot, WEBGL_OVERLAY_Y_METERS), [pivot]);
  const shotsValid = shotIntegrity(spatial);
  const visibleShots = useMemo(() => shotsValid ? spatial!.shotmapPoints
    .map((shot, sourceIndex) => ({ shot, sourceIndex }))
    .filter(({ shot }) => visibleOutcomes.has(shot.outcome)) : [], [shotsValid, spatial, visibleOutcomes]);
  const endOnFrame = cameraAngle != null && END_ON_ANGLES.has(cameraAngle);
  const framedShots = useMemo(() => endOnFrame ? visibleShots.filter(({ shot }) => shot.x >= 50) : visibleShots, [endOnFrame, visibleShots]);
  const markerGroups = useMemo(() => groupPitchShots(framedShots), [framedShots]);
  const medianXg = shotsValid ? medianObservedXg(spatial!.shotmapPoints) : null;
  const markerPlacements = useMemo(() => layoutWebglShotMarkers(markerGroups, medianXg), [markerGroups, medianXg]);
  const offscreenShotCount = visibleShots.length - framedShots.length;
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
    } catch (error) {
      setLoadState(typeof WebGLRenderingContext === "undefined" ? "unsupported" : "error");
      setLoadError(error instanceof Error ? error.message : "WebGL 초기화 실패");
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 0.95;
    renderer.setClearColor(0x050a08, 1);

    const scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2(0x050a08, 0.0065);
    const camera = new THREE.PerspectiveCamera(42, 16 / 9, 0.05, 420);
    const initial = freeflyStateFromOrbit(DEFAULT_WEBGL_CAMERA, pivotWorld);
    freeflyRef.current = initial;
    setFreeflyState(initial);
    camera.position.set(initial.position.x, initial.position.y, initial.position.z);
    const initialTarget = freeflyLookTarget(initial);
    camera.lookAt(initialTarget.x, initialTarget.y, initialTarget.z);

    scene.add(new THREE.HemisphereLight(0xdfffea, 0x102219, 2.2));
    const sun = new THREE.DirectionalLight(0xffffff, 2.4);
    sun.position.set(-30, 70, -18);
    scene.add(sun);
    const overlayRoot = new THREE.Group();
    scene.add(overlayRoot);
    const zoneHitRoot = new THREE.Group();
    scene.add(zoneHitRoot);
    const render = () => renderer.render(scene, camera);
    const runtime = { scene, camera, renderer, overlayRoot, zoneHitRoot, render };
    runtimeRef.current = runtime;

    const resize = () => {
      const width = Math.max(1, host.clientWidth);
      const height = Math.max(320, Math.round(width * 0.59));
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      renderRuntime();
    };
    const resizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(resize);
    resizeObserver?.observe(host);
    resize();
    const loader = new GLTFLoader();
    let cancelled = false;
    loader.load(
      MODEL_URL,
      (gltf) => {
        if (cancelled) {
          disposeObject(gltf.scene);
          return;
        }
        for (const hiddenName of ["FootballPitch5_3Check_9", "group_12", "Football_13"]) {
          const extra = gltf.scene.getObjectByName(hiddenName);
          if (extra) extra.visible = false;
        }
        gltf.scene.traverse((object) => {
          if (object instanceof THREE.Mesh) {
            object.castShadow = false;
            object.receiveShadow = true;
          }
        });
        scene.add(gltf.scene);
        setLoadState("ready");
        renderRuntime();
      },
      undefined,
      (error) => {
        if (cancelled) return;
        setLoadState("error");
        setLoadError(error instanceof Error ? error.message : "3D 피치 자산 로드 실패");
      },
    );
    setRuntimeVersion((value) => value + 1);
    render();
    return () => {
      cancelled = true;
      resizeObserver?.disconnect();
      disposeObject(scene);
      renderer.dispose();
      runtimeRef.current = null;
    };
  // Runtime is intentionally rebuilt only for a player-context reset.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contextIdentity]);

  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    disposeObject(runtime.overlayRoot);
    runtime.overlayRoot.clear();
    disposeObject(runtime.zoneHitRoot);
    runtime.zoneHitRoot.clear();
    addZoneHitMeshes(runtime.zoneHitRoot, zones);
    addTacticalGrid(runtime.overlayRoot);
    if (layers.heatmap) addDotMatrixHeatmap(runtime.overlayRoot, densityDots);
    if (layers.cca) addContours(runtime.overlayRoot, spatial, legacyNormalized);
    if (layers.markers || layers.trajectories) addShots(runtime.overlayRoot, markerGroups, medianXg, layers, markerPlacements);
    runtime.render();
    setProjectionVersion((value) => value + 1);
  }, [densityDots, layers, legacyNormalized, markerGroups, markerPlacements, medianXg, runtimeVersion, spatial, zones]);

  const applyFreefly = useCallback((next: FreeflyCameraState, publicState?: OrbitCameraState) => {
    freeflyRef.current = next;
    setFreeflyState(next);
    const runtime = runtimeRef.current;
    if (runtime) {
      const target = freeflyLookTarget(next);
      runtime.camera.position.set(next.position.x, next.position.y, next.position.z);
      runtime.camera.lookAt(target.x, target.y, target.z);
      renderRuntime();
    }
    setCameraState(publicState ?? {
      azimuth: next.yaw,
      elevation: -next.pitch,
      distance: DEFAULT_WEBGL_CAMERA.distance,
    });
  }, [renderRuntime]);

  const applyCamera = useCallback((state: OrbitCameraState, nextZoom: number, angle: CameraAngle | null) => {
    applyFreefly(freeflyStateFromOrbit(state, pivotWorld), state);
    const runtime = runtimeRef.current;
    if (runtime) {
      runtime.camera.zoom = nextZoom;
      runtime.camera.updateProjectionMatrix();
      renderRuntime();
    }
    setZoom(nextZoom);
    setCameraAngle(angle);
  }, [applyFreefly, pivotWorld, renderRuntime]);

  const resetCamera = useCallback(() => {
    setActiveShot(null);
    setHoveredZone(null);
    applyCamera(DEFAULT_WEBGL_CAMERA, 1, null);
  }, [applyCamera]);

  const setZoomLevel = (next: number) => {
    const clamped = clampWebglZoom(next);
    const runtime = runtimeRef.current;
    if (runtime) {
      runtime.camera.zoom = clamped;
      runtime.camera.updateProjectionMatrix();
      renderRuntime();
    }
    setZoom(clamped);
  };
  const moveCamera = useCallback((forward = 0, right = 0, vertical = 0) => {
    setCameraAngle(null);
    applyFreefly(moveFreeflyCamera(freeflyRef.current, { forward, right, vertical }));
  }, [applyFreefly]);
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const wheel = (event: WheelEvent) => {
      if (event.target !== host && event.target !== canvasRef.current) return;
      event.preventDefault();
      moveCamera(0, 0, -event.deltaY * 0.015);
    };
    host.addEventListener("wheel", wheel, { passive: false });
    return () => host.removeEventListener("wheel", wheel);
  }, [moveCamera]);
  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    if (event.key === "Escape") {
      event.preventDefault();
      resetCamera();
      return;
    }
    const key = event.key.toLowerCase();
    if (!["w", "a", "s", "d", "arrowleft", "arrowright", "arrowup", "arrowdown", "pageup", "pagedown"].includes(key)) return;
    event.preventDefault();
    const step = FREEFLY_MOVE_STEP_METERS;
    moveCamera(
      key === "w" || key === "arrowup" ? step : key === "s" || key === "arrowdown" ? -step : 0,
      key === "d" || key === "arrowright" ? step : key === "a" || key === "arrowleft" ? -step : 0,
      key === "pageup" ? FREEFLY_HEIGHT_STEP_METERS : key === "pagedown" ? -FREEFLY_HEIGHT_STEP_METERS : 0,
    );
  };
  const pointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget && event.target !== canvasRef.current) return;
    if (event.button !== 0 && event.button !== 2) return;
    dragRef.current = { button: event.button, x: event.clientX, y: event.clientY };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    event.currentTarget.focus();
    event.preventDefault();
  };
  const pointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (drag) {
      const dx = event.clientX - drag.x;
      const dy = event.clientY - drag.y;
      dragRef.current = { ...drag, x: event.clientX, y: event.clientY };
      setCameraAngle(null);
      applyFreefly(drag.button === 0
        ? rotateFreeflyCamera(freeflyRef.current, -dx * FREEFLY_MOUSE_SENSITIVITY, -dy * FREEFLY_MOUSE_SENSITIVITY)
        : moveFreeflyCamera(freeflyRef.current, { vertical: -dy * 0.08 }));
    }
    const runtime = runtimeRef.current;
    const canvas = canvasRef.current;
    if (!runtime || !canvas) {
      setHoveredZone(null);
      return;
    }
    const bounds = canvas.getBoundingClientRect();
    if (!bounds.width || !bounds.height || event.clientX < bounds.left || event.clientX > bounds.right ||
        event.clientY < bounds.top || event.clientY > bounds.bottom) {
      setHoveredZone(null);
      return;
    }
    const raycaster = raycasterRef.current ?? new THREE.Raycaster();
    raycasterRef.current = raycaster;
    raycaster.setFromCamera(new THREE.Vector2(
      (event.clientX - bounds.left) / bounds.width * 2 - 1,
      -((event.clientY - bounds.top) / bounds.height) * 2 + 1,
    ), runtime.camera);
    const hit = raycaster.intersectObjects(runtime.zoneHitRoot.children, false)[0];
    const zoneKey = typeof hit?.object.userData.zoneKey === "string" ? hit.object.userData.zoneKey : null;
    setHoveredZone(zoneKey ? zonesByKey.get(zoneKey) ?? null : null);
  };
  const pointerUp = (event: PointerEvent<HTMLDivElement>) => {
    dragRef.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  };
  const shotProjection = (group: PitchShotGroup) => projectWorld(
    runtimeRef.current,
    hostRef.current,
    markerPlacements.get(group.key)?.world ?? pitchPercentToWorld(group.shot, WEBGL_OVERLAY_Y_METERS + .03),
  );
  const zoneProjection = (zone: ZoneOverlay) => projectWorld(
    runtimeRef.current,
    hostRef.current,
    pitchPercentToWorld(zone.point, 0.24),
  );
  void projectionVersion;
  const selectedShot = markerGroups.find((group) => group.key === activeShot) ?? null;
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
    <div className="space-y-2 border-b border-white/10 bg-black/25 px-2 py-2">
      <div role="group" aria-label="카메라 각도 프리셋" className="flex flex-wrap items-center gap-1">
        {(Object.keys(WEBGL_CAMERA_PRESETS) as CameraAngle[]).map((angle) =>
          <button key={angle} type="button" data-camera-preset={angle} aria-pressed={cameraAngle === angle}
            onClick={() => applyCamera(WEBGL_CAMERA_PRESETS[angle], 1, angle)}
            className="min-h-9 rounded border border-white/15 px-3 text-base font-bold aria-pressed:bg-lime-300 aria-pressed:text-slate-950">
            {cameraLabels[angle]}
          </button>)}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <div role="group" aria-label="화면 배율 조절" className="flex items-center gap-1">
          <button type="button" aria-label="축소" disabled={zoom <= WEBGL_ZOOM.minimum}
            onClick={() => setZoomLevel(zoom - WEBGL_ZOOM.step)} className="min-h-9 min-w-9 rounded border border-white/15 px-2 font-bold disabled:opacity-40">−</button>
          <button type="button" aria-label="확대" disabled={zoom >= WEBGL_ZOOM.maximum}
            onClick={() => setZoomLevel(zoom + WEBGL_ZOOM.step)} className="min-h-9 min-w-9 rounded border border-white/15 px-2 font-bold disabled:opacity-40">+</button>
          <button type="button" aria-label="기본 시점" onClick={resetCamera} className="min-h-9 rounded border border-white/15 px-3 text-base font-bold">초기화</button>
        </div>
        <p aria-live="polite" className="text-base text-zinc-300">{cameraState.azimuth.toFixed(0)}° · {cameraState.elevation.toFixed(0)}° · {zoom.toFixed(2)}배</p>
        {endOnFrame && <p data-offscreen-shot-count={offscreenShotCount} className="rounded border border-amber-300/35 bg-amber-300/10 px-2 py-1 text-base font-bold text-amber-100">화면 밖 {offscreenShotCount}발</p>}
      </div>
    </div>
    <div ref={hostRef} role="img" tabIndex={0} onKeyDown={keyDown}
      onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={pointerUp}
      onPointerLeave={() => setHoveredZone(null)}
      onContextMenu={(event) => event.preventDefault()}
      aria-label={`3D 회랑 WebGL 피치. ${heatState}. ${shotState}. WASD 또는 화살표 키로 이동하고, 왼쪽 드래그로 시선을 돌리며, 오른쪽 드래그나 휠로 높이를 조절합니다.`}
      className="relative min-h-80 w-full overflow-hidden rounded-b-lg bg-[#050a08] outline-none focus-visible:ring-2 focus-visible:ring-orange-200"
      data-webgl-renderer="three"
      data-gltf-loader="GLTFLoader"
      data-gltf-url={MODEL_URL}
      data-webgl-state={loadState}
      data-zone-hover-mode="raycaster"
      data-camera-mode="freefly"
      data-camera-azimuth={Number(cameraState.azimuth.toFixed(2))}
      data-camera-elevation={Number(cameraState.elevation.toFixed(2))}
      data-camera-distance={DEFAULT_WEBGL_CAMERA.distance}
      data-camera-zoom={zoom}
      data-camera-frame-from-x={endOnFrame ? 50 : 0}
      data-camera-pivot={`${(pivot.x * 1.05).toFixed(2)},${(pivot.y * 0.68).toFixed(2)},0`}
      data-camera-position={`${freeflyState.position.x.toFixed(2)},${freeflyState.position.y.toFixed(2)},${freeflyState.position.z.toFixed(2)}`}
      data-visible-shot-count={framedShots.length}
      data-total-shot-count={visibleShots.length}
      data-attacking-goal-width-pct={goalWidthPct.toFixed(2)}
      data-attacking-goal-height-pct={goalHeightPct.toFixed(2)}>
      <canvas ref={canvasRef} aria-hidden="true" className="block h-auto w-full touch-none" />
      {loadState === "loading" && <div role="status" className="absolute inset-0 grid place-items-center bg-[#050a08]/70 text-sm font-bold text-zinc-200">3D 피치 자산 로딩…</div>}
      {(loadState === "error" || loadState === "unsupported") && <div role="alert" className="absolute inset-0 grid place-items-center bg-[#050a08] p-6 text-center text-sm font-bold text-rose-200">WebGL 피치를 표시할 수 없습니다. {loadError}</div>}

      {layers.heatmap && <div hidden data-layer="heat" data-density-source="dot-matrix-64x24" data-density-input="full-tier3-32x22"
        data-density-dot-columns={WEBGL_DOTMATRIX_COLUMNS} data-density-dot-rows={WEBGL_DOTMATRIX_ROWS}
        data-blur-std-deviation="0" data-density-mesh-builds="1">
        {densityDots.map((dot) => <span key={`${dot.row}-${dot.column}`} data-density-dot=""
          data-density-row={dot.row} data-density-column={dot.column}
          data-density-normalized={dot.density} data-density-radius-meters={dot.radiusMeters} />)}
      </div>}
      {layers.cca && legacyHeatValid && spatial?.continuousCore.available && spatial.continuousCore.thresholdOfPeak > 0 && <div hidden data-layer="cca-contour" data-contour-segments={marchingSquares(legacyNormalized, spatial.continuousCore.thresholdOfPeak).length} />}
      <div hidden data-layer="positional-grid" data-zone-count="30">{Array.from({ length: 17 }, (_, index) => <span key={index} data-grid-segment={index} />)}</div>
      <div hidden data-layer="goals"><span data-goal="defending" data-goal-post-near-y="44.61764705882353" data-goal-post-far-y="55.38235294117647" data-goal-crossbar-height-meters="2.44" /><span data-goal="attacking" data-goal-post-near-y="44.61764705882353" data-goal-post-far-y="55.38235294117647" data-goal-crossbar-height-meters="2.44" /></div>
      {(layers.markers || layers.trajectories) && <div hidden data-layer="shots" id={markerLayerId} />}

      {layers.markers && markerGroups.map((group, index) => {
        const projected = shotProjection(group);
        const id = `webgl-shot-${group.key}`;
        return <button key={group.key} id={id} type="button" data-shot-marker="" data-shot-index={group.sourceIndexes[0]}
          data-shot-indexes={group.sourceIndexes.join(",")} data-shot-outcome={group.outcome}
          data-marker-symbol={outcomePresentation[group.outcome].symbol}
          data-marker-renderer="flat-disc" data-marker-size={markerPlacements.get(group.key)?.radiusMeters ?? 0}
          data-marker-count={group.count} data-pitch-x={group.shot.x} data-pitch-y={group.shot.y}
          data-marker-offset-meters={markerPlacements.get(group.key)?.offsetMeters.join(",") ?? "0,0"}
          tabIndex={activeShot === group.key || activeShot === null && index === 0 ? 0 : -1}
          aria-label={`${shotMarkerLabel(group.shot)}${group.count > 1 ? ` ${group.count} shots share this exact coordinate.` : ""}`}
          onClick={() => setActiveShot(group.key)} onFocus={() => setActiveShot(group.key)} onBlur={() => setActiveShot(null)}
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
      {layers.trajectories && markerGroups.flatMap((group) => group.shot.trajectory?.endpointKind === "goal_mouth" && typeof group.shot.trajectory.endZMeters === "number" ?
        [<span key={group.key} hidden data-shot-trajectory="" data-trajectory-kind="goal_mouth"
          data-trajectory-outcome={group.outcome} data-end-pitch-x={group.shot.trajectory.endX}
          data-end-pitch-y={group.shot.trajectory.endY}
          data-end-goal-mouth={group.shot.trajectory.endY >= 44.61764705882353 && group.shot.trajectory.endY <= 55.38235294117647 ? "inside" : "outside"}
          data-end-height-meters={group.shot.trajectory.endZMeters} />] : [])}
      {selectedShot && (() => {
        const point = shotProjection(selectedShot);
        return <div role="tooltip" className="pointer-events-none absolute z-30 w-36 -translate-x-1/2 -translate-y-[115%] rounded border border-white/25 bg-[#0b0e0f]/95 p-2 text-xs text-zinc-100"
          style={{ left: `${Math.min(92, Math.max(8, point.left))}%`, top: `${Math.min(92, Math.max(8, point.top))}%` }}>
          <strong>{outcomePresentation[selectedShot.outcome].label}</strong><br />xG {formatShotMetric(selectedShot.shot.xg)} · xGOT {formatShotMetric(selectedShot.shot.xgot)}
        </div>;
      })()}
      {zones.map((zone) => {
        const projected = zoneProjection(zone);
        return <button key={`${zone.cell.depth}-${zone.cell.lane}`} type="button"
          data-zone-keyboard-target=""
          data-zone-shot-share={zone.summary.shotSharePct.toFixed(2)}
          aria-label={`구역 ${zone.cell.depth * 5 + zone.cell.lane + 1}. 슈팅 비중 ${zone.summary.shotSharePct.toFixed(2)}%, 활동 ${zone.cell.occupancyPct.toFixed(2)}%.`}
          onFocus={() => setHoveredZone(zone)} onBlur={() => setHoveredZone(null)}
          className="pointer-events-none absolute z-10 h-6 w-6 -translate-x-1/2 -translate-y-1/2 rounded bg-transparent text-transparent outline-none focus-visible:ring-2 focus-visible:ring-orange-200"
          style={{ left: `${projected.left}%`, top: `${projected.top}%`, display: projected.visible ? undefined : "none" }} />;
      })}
      {hoveredZone && (() => {
        const projected = zoneProjection(hoveredZone);
        return <div data-zone-tooltip role="tooltip" className="pointer-events-none absolute z-30 w-48 -translate-x-1/2 -translate-y-[115%] rounded border border-white/25 bg-[#0b0e0f]/95 p-2 text-xs text-zinc-100"
          style={{ left: `${Math.min(90, Math.max(10, projected.left))}%`, top: `${Math.min(90, Math.max(10, projected.top))}%` }}>
          <strong>구역 {hoveredZone.cell.depth * 5 + hoveredZone.cell.lane + 1}</strong><br />
          슈팅 비중 {hoveredZone.summary.shotSharePct.toFixed(2)}% · 활동 {hoveredZone.cell.occupancyPct.toFixed(2)}%<br />
          슛 {hoveredZone.summary.shots} · 득점 {hoveredZone.summary.goals} · xG {hoveredZone.summary.xg.toFixed(2)}
        </div>;
      })()}
      <p className="sr-only">WebGL 장면 요약: 활동 좌표 {fullActivityHeatmap?.available ? fullActivityHeatmap.validPointCount : 0}개, 유효 슈팅 이벤트 {shotsValid ? spatial!.shotmapPoints.length : 0}개, 점유 라벨 {zones.length}개. 실제 GLTFLoader 모델과 Three.js 카메라를 사용합니다.</p>
    </div>
  </>;
}
