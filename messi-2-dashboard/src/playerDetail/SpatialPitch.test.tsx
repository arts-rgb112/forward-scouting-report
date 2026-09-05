// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { PlayerAnalysis } from "../dashboard/types";
import { rawActivityHistogram } from "./legacyHeatmap";
import { SpatialPitch } from "./SpatialPitch";
import {
  DEFAULT_WEBGL_CAMERA, GLB_PITCH_HALF_LENGTH_METERS, GLB_PITCH_HALF_WIDTH_METERS,
  GLB_PITCH_LENGTH_METERS, GLB_PITCH_WIDTH_METERS, FREEFLY_BOUNDS, WEBGL_CAMERA_PRESETS,
  cameraPositionFromOrbit, clampWebglZoom, fifaPenaltySpotWorld, freeflyStateFromOrbit,
  moveFreeflyCamera, pitchPercentToWorld,
  providerPenaltyAlignmentErrorMeters, trajectoryWorldPoints, worldToPitchPercent,
} from "./pitchWebglGeometry";

const analysisWith = (spatial: Partial<PlayerAnalysis["spatial"]>): PlayerAnalysis => ({
  score: { value: 80, rank: 1, topPercent: 1, population: 100, archetype: "Type A" },
  volumeRadar: { kind: "volume", axes: [] }, ratioRadar: { kind: "ratio", axes: [] }, rawMetrics: {},
  spatial: {
    available: true, source: "messi-static-cohort", heatmapPointCount: 0, heatmapPoints: [], shotmapPointCount: 0, shotmapPoints: [], shotmapSnapshotAvailable: false,
    inBoxRatio: null, outBoxFinalRatio: null, midThirdRatio: null, finalThirdRatio: null, ccaAreaPct: null, laneRatios: [], depthRatios: [], positionalGrid: [],
    trueCore: { available: false, gridVersion: "positional-6x5-v1", definitionVersion: "true-core-50-v1", targetDensityPct: 50, achievedDensityPct: 0, zoneIds: [], zoneCount: 0, coreAreaPct: 0, tieBreak: "density-desc-depth-asc-lane-asc", zones: [] },
    continuousCore: { available: false, definitionVersion: "continuous-hdr-50-v1", targetDensityPct: 50, achievedDensityPct: 0, coreAreaPct: 0, densityThreshold: 0, thresholdOfPeak: 0, gridColumns: 32, gridRows: 22 },
    dangerZoneDensity: null, deepBoxZoneScore: null, ...spatial,
  },
});

const fullHeatmap = (points: readonly { x: number; y: number }[]) => ({
  available: true, reason: null, definitionVersion: "full-tier3-count-weighted-histogram-32x22-v1", columns: 32, rows: 22,
  cellCounts: [...rawActivityHistogram(points)], validPointCount: points.length, activitySnapshotCount: 1,
  sourceDefinitionVersion: "sportsapi-heatmap-points-count-weighted-full-v1",
}) as never;

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("footballpitchv3 coordinate contract", () => {
  it("maps the measured 68 m by 105.38557 m Y-up model around world origin", () => {
    expect(pitchPercentToWorld({ x: 50, y: 50 })).toMatchObject({ x: 0, z: 0 });
    expect(pitchPercentToWorld({ x: 0, y: 50 }).z).toBeCloseTo(-GLB_PITCH_HALF_LENGTH_METERS, 8);
    expect(pitchPercentToWorld({ x: 100, y: 50 }).z).toBeCloseTo(GLB_PITCH_HALF_LENGTH_METERS, 8);
    expect(pitchPercentToWorld({ x: 50, y: 0 }).x).toBeCloseTo(GLB_PITCH_HALF_WIDTH_METERS, 8);
    expect(pitchPercentToWorld({ x: 50, y: 100 }).x).toBeCloseTo(-GLB_PITCH_HALF_WIDTH_METERS, 8);
    expect(GLB_PITCH_WIDTH_METERS).toBe(68);
    expect(GLB_PITCH_LENGTH_METERS).toBeCloseTo(105.3855703125, 10);
  });

  it("round-trips provider coordinates and aligns its penalty geometry to FIFA 11 m", () => {
    const source = { x: 82.4, y: 19.7 };
    expect(worldToPitchPercent(pitchPercentToWorld(source))).toEqual(source);
    expect(fifaPenaltySpotWorld(true).z).toBeCloseTo(GLB_PITCH_HALF_LENGTH_METERS - 11, 10);
    expect(providerPenaltyAlignmentErrorMeters()).toBeLessThan(0.05);
  });

  it("keeps four finite camera presets and clamps one shared zoom scale", () => {
    expect(Object.keys(WEBGL_CAMERA_PRESETS)).toEqual(["left", "right", "goalFront", "goalBack"]);
    for (const preset of Object.values(WEBGL_CAMERA_PRESETS)) {
      expect(Object.values(cameraPositionFromOrbit(preset, { x: 0, y: 0, z: 0 }, 2)).every(Number.isFinite)).toBe(true);
    }
    expect(clampWebglZoom(0)).toBe(1);
    expect(clampWebglZoom(99)).toBe(3);
    expect(cameraPositionFromOrbit(DEFAULT_WEBGL_CAMERA, { x: 0, y: 0, z: 0 }, 1)).not.toEqual(cameraPositionFromOrbit(DEFAULT_WEBGL_CAMERA, { x: 0, y: 0, z: 0 }, 2));
  });

  it("moves freefly forward relative to view and clamps every pitch boundary", () => {
    const initial = freeflyStateFromOrbit(DEFAULT_WEBGL_CAMERA, { x: 0, y: 0, z: 0 });
    const moved = moveFreeflyCamera(initial, { forward: 3, right: 2, vertical: 1 });
    expect(moved.position).not.toEqual(initial.position);
    const clamped = moveFreeflyCamera(moved, { forward: 10000, right: 10000, vertical: -10000 });
    expect(clamped.position.x).toBeGreaterThanOrEqual(FREEFLY_BOUNDS.minX);
    expect(clamped.position.x).toBeLessThanOrEqual(FREEFLY_BOUNDS.maxX);
    expect(clamped.position.y).toBe(FREEFLY_BOUNDS.minY);
    expect(clamped.position.z).toBeGreaterThanOrEqual(FREEFLY_BOUNDS.minZ);
    expect(clamped.position.z).toBeLessThanOrEqual(FREEFLY_BOUNDS.maxZ);
  });

  it("terminates a known-height trajectory at the attacking goal without inventing units", () => {
    const points = trajectoryWorldPoints({ x: 80, y: 25 }, 52, 1.2, 8);
    expect(points).toHaveLength(9);
    expect(points.at(-1)).toMatchObject({ y: 1.2, z: GLB_PITCH_HALF_LENGTH_METERS });
    expect(worldToPitchPercent(points.at(-1)!)).toMatchObject({ x: 100, y: 52 });
    expect(Math.max(...points.map((point) => point.y))).toBeGreaterThan(1.2);
  });
});

describe("Three WebGL spatial pitch contract", () => {
  it("declares the real Three renderer and in-repo GLTFLoader asset without an SVG fallback", async () => {
    const { container } = render(<SpatialPitch analysis={analysisWith({})} />);
    const pitch = await screen.findByRole("img", { name: /3D 회랑 WebGL 피치/ });
    expect(pitch).toHaveAttribute("data-webgl-renderer", "three");
    expect(pitch).toHaveAttribute("data-gltf-loader", "GLTFLoader");
    expect(pitch).toHaveAttribute("data-gltf-url", "/assets/footballpitchv3.glb");
    await waitFor(() => expect(pitch).toHaveAttribute("data-webgl-state", "unsupported"));
    expect(within(pitch).getByRole("alert")).toHaveTextContent("WebGL 피치를 표시할 수 없습니다");
    expect(container.querySelector("canvas")).toBeInTheDocument();
    expect(container.querySelector("svg")).not.toBeInTheDocument();
  });

  it("preserves all camera presets, zoom/reset, end-on framing, and shot counts", async () => {
    render(<SpatialPitch analysis={analysisWith({ shotmapSnapshotAvailable: true, shotmapPointCount: 2, shotmapPoints: [
      { x: 40, y: 40, outcome: "off_target" }, { x: 80, y: 60, outcome: "goal" },
    ] })} />);
    const pitch = await screen.findByRole("img", { name: /3D 회랑 WebGL 피치/ });
    expect(screen.getAllByRole("button", { name: /좌측|우측|골대 정면|골대 뒤/ })).toHaveLength(4);
    fireEvent.click(screen.getByRole("button", { name: "골대 정면" }));
    expect(pitch).toHaveAttribute("data-camera-azimuth", "180");
    expect(pitch).toHaveAttribute("data-camera-elevation", "27");
    expect(pitch).toHaveAttribute("data-camera-frame-from-x", "50");
    expect(pitch).toHaveAttribute("data-visible-shot-count", "1");
    expect(pitch).toHaveAttribute("data-total-shot-count", "2");
    expect(screen.getByText("화면 밖 1발")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "확대" }));
    expect(pitch).toHaveAttribute("data-camera-zoom", "1.25");
    fireEvent.click(screen.getByRole("button", { name: "기본 시점" }));
    expect(pitch).toHaveAttribute("data-camera-zoom", "1");
    expect(pitch).toHaveAttribute("data-camera-distance", "84");
  });

  it("uses freefly by default and lets keyboard users walk after a preset jump", async () => {
    render(<SpatialPitch analysis={analysisWith({})} />);
    const pitch = await screen.findByRole("img", { name: /3D 회랑 WebGL 피치/ });
    expect(pitch).toHaveAttribute("data-camera-mode", "freefly");
    fireEvent.click(screen.getByRole("button", { name: "좌측" }));
    const presetPosition = pitch.getAttribute("data-camera-position");
    fireEvent.keyDown(pitch, { key: "w" });
    expect(pitch).not.toHaveAttribute("data-camera-position", presetPosition);
    expect(screen.getByRole("button", { name: "좌측" })).toHaveAttribute("aria-pressed", "false");
    const walkedPosition = pitch.getAttribute("data-camera-position");
    fireEvent.pointerDown(pitch, { button: 0, pointerId: 1, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(pitch, { pointerId: 1, clientX: 130, clientY: 115 });
    fireEvent.pointerUp(pitch, { pointerId: 1 });
    expect(pitch).not.toHaveAttribute("data-camera-azimuth", "90");
    fireEvent.pointerDown(pitch, { button: 2, pointerId: 2, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(pitch, { pointerId: 2, clientX: 100, clientY: 120 });
    fireEvent.pointerUp(pitch, { pointerId: 2 });
    expect(pitch).not.toHaveAttribute("data-camera-position", walkedPosition);
    const draggedPosition = pitch.getAttribute("data-camera-position");
    const wheelUp = new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -100 });
    expect(fireEvent(pitch, wheelUp)).toBe(false);
    expect(wheelUp.defaultPrevented).toBe(true);
    expect(pitch).not.toHaveAttribute("data-camera-position", draggedPosition);
    const raisedPosition = pitch.getAttribute("data-camera-position");
    const wheelDown = new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: 100 });
    expect(fireEvent(pitch, wheelDown)).toBe(false);
    expect(wheelDown.defaultPrevented).toBe(true);
    expect(pitch).not.toHaveAttribute("data-camera-position", raisedPosition);
  });

  it("retains the 17-segment grid, both goals, 64x24 dot-matrix full density, and 32x22 CCA input", async () => {
    const point = { x: 81, y: 46 };
    const { container } = render(<SpatialPitch analysis={analysisWith({
      heatmapPointCount: 1, heatmapPoints: [point],
      continuousCore: { available: true, definitionVersion: "continuous-hdr-50-v1", targetDensityPct: 50, achievedDensityPct: 50, coreAreaPct: 8, densityThreshold: .5, thresholdOfPeak: .5, gridColumns: 32, gridRows: 22 },
    })} fullActivityHeatmap={fullHeatmap([point])} />);
    await screen.findByRole("img", { name: /3D 회랑 WebGL 피치/ });
    expect(container.querySelectorAll("[data-grid-segment]")).toHaveLength(17);
    expect(container.querySelectorAll("[data-goal]")).toHaveLength(2);
    expect(container.querySelectorAll("[data-density-dot]").length).toBeGreaterThan(0);
    expect(container.querySelectorAll("[data-density-dot]").length).toBeLessThanOrEqual(64 * 24);
    expect(container.querySelector("[data-layer=heat]")).toHaveAttribute("data-density-input", "full-tier3-32x22");
    expect(container.querySelector("[data-layer=heat]")).toHaveAttribute("data-density-source", "dot-matrix-64x24");
    expect(container.querySelector("[data-layer=heat]")).toHaveAttribute("data-blur-std-deviation", "0");
    expect(container.querySelector("[data-layer=heat]")).toHaveAttribute("data-density-mesh-builds", "1");
    expect(container.querySelector("[data-layer=cca-contour]")).toBeInTheDocument();
    expect(container.querySelector("[data-spatial-activity-note]")).toHaveTextContent("full Tier 3 활동 좌표 1개 · 전술 구획은 시각 안내선이며 브라우저에서 점수나 구역 값을 새로 계산하지 않습니다.");
    expect(container.querySelector("[data-spatial-shot-note]")).toHaveTextContent("슈팅 스냅샷 사용 불가 · 데이터 없음과 관측된 0은 구분합니다.");
  });

  it("exposes accessible markers and only source-backed goal-mouth trajectories", async () => {
    const shots = [
      { x: 80, y: 20, outcome: "goal" as const, xg: .4, xgot: .6, trajectory: { schemaVersion: "shotmap-trajectory-v1" as const, endpointKind: "goal_mouth" as const, endX: 100, endY: 52, endZMeters: 1.2, source: "fotmob" as const } },
      { x: 78, y: 22, outcome: "on_target" as const, trajectory: { schemaVersion: "shotmap-trajectory-v1" as const, endpointKind: "goal_mouth" as const, endX: 100, endY: 40, endZMeters: null, source: "fotmob" as const } },
      { x: 70, y: 60, outcome: "blocked" as const, trajectory: { schemaVersion: "shotmap-trajectory-v1" as const, endpointKind: "blocked" as const, endX: 78, endY: 56, endZMeters: null, source: "fotmob" as const } },
    ];
    const { container } = render(<SpatialPitch analysis={analysisWith({ shotmapSnapshotAvailable: true, shotmapPointCount: shots.length, shotmapPoints: shots })} />);
    await screen.findByRole("img", { name: /3D 회랑 WebGL 피치/ });
    expect(container.querySelectorAll("[data-shot-marker]")).toHaveLength(3);
    expect(container.querySelectorAll("[data-shot-trajectory]")).toHaveLength(1);
    expect(container.querySelector("[data-shot-trajectory]")).toHaveAttribute("data-end-height-meters", "1.2");
    const marker = container.querySelector<HTMLButtonElement>("[data-shot-marker][data-shot-outcome='goal']")!;
    expect(marker).toHaveAttribute("data-marker-renderer", "flat-disc");
    expect(container.querySelectorAll("[data-shot-marker][tabindex='0']")).toHaveLength(1);
    fireEvent.click(marker);
    expect(screen.getByRole("tooltip")).toHaveTextContent("xG 0.40 · xGOT 0.60");
    expect(screen.getByRole("list", { name: "서버 슈팅 이벤트" })).toHaveTextContent("블록");
  });

  it("keeps server zone shares and the complete hover breakdown", async () => {
    const { container } = render(<SpatialPitch analysis={analysisWith({
      shotmapSnapshotAvailable: true, shotmapPointCount: 2,
      shotmapPoints: [{ x: 8, y: 10, outcome: "goal", xg: .3 }, { x: 80, y: 90, outcome: "on_target", xg: .2 }],
      positionalGrid: [{ depth: 0, lane: 0, occupancyPct: 16.67 }],
    })} />);
    await screen.findByRole("img", { name: /3D 회랑 WebGL 피치/ });
    const zone = container.querySelector<HTMLButtonElement>("[data-zone-shot-share='50.00']")!;
    expect(zone).toBeInTheDocument();
    expect(zone).toBeEmptyDOMElement();
    expect(zone).toHaveAttribute("data-zone-keyboard-target");
    expect(zone).toHaveAttribute("aria-label", "구역 1. 슈팅 비중 50.00%, 활동 16.67%.");
    expect(screen.getByRole("img", { name: /3D 회랑 WebGL 피치/ })).toHaveAttribute("data-zone-hover-mode", "raycaster");
    fireEvent.focus(zone);
    expect(screen.getByRole("tooltip")).toHaveTextContent("슈팅 비중 50.00% · 활동 16.67%");
    expect(screen.getByRole("tooltip")).toHaveTextContent("슛 1 · 득점 1 · xG 0.30");
  });

  it("shares outcome visibility with markers and trajectories while keeping the raw event list", async () => {
    const shots = [{ x: 80, y: 20, outcome: "goal" as const, trajectory: { schemaVersion: "shotmap-trajectory-v1" as const, endpointKind: "goal_mouth" as const, endX: 100, endY: 52, endZMeters: 1.2, source: "fotmob" as const } }];
    const { container } = render(<SpatialPitch analysis={analysisWith({ shotmapSnapshotAvailable: true, shotmapPointCount: 1, shotmapPoints: shots })} />);
    await screen.findByRole("img", { name: /3D 회랑 WebGL 피치/ });
    expect(container.querySelectorAll("[data-shot-marker]")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: /득점, 1 shots/ }), { detail: 0 });
    expect(container.querySelectorAll("[data-shot-marker]")).toHaveLength(0);
    expect(container.querySelectorAll("[data-shot-trajectory]")).toHaveLength(0);
    expect(screen.getByRole("list", { name: "서버 슈팅 이벤트" })).toHaveTextContent("득점");
  });

  it("uses only the approved 2D plan for reduced motion until the user selects 3D", async () => {
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
    const { container } = render(<SpatialPitch analysis={analysisWith({})} />);
    expect(screen.getByText(/Reduced-motion preference detected/)).toBeInTheDocument();
    expect(container.querySelector("[data-webgl-renderer]")).not.toBeInTheDocument();
    expect(container.querySelector("svg")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "3D 회랑" }));
    await waitFor(() => expect(container.querySelector("[data-webgl-renderer]")).toBeInTheDocument());
  });

  it("distinguishes unavailable snapshots from observed zero", async () => {
    const unavailable = render(<SpatialPitch analysis={analysisWith({ shotmapSnapshotAvailable: false })} />);
    await screen.findByRole("img", { name: /슈팅 스냅샷 사용 불가/ });
    unavailable.unmount();
    render(<SpatialPitch analysis={analysisWith({ shotmapSnapshotAvailable: true, shotmapPointCount: 0, shotmapPoints: [] })} />);
    await screen.findByRole("img", { name: /관측된 슛 0개/ });
  });
});
