// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { PlayerAnalysis } from "../dashboard/types";
import { boxSubregionEnvelopeSchema } from "../api/boxSubregionContracts";
import { nativePitchEventsEnvelopeSchema } from "../api/nativePitchEventsContracts";
import { rawActivityHistogram } from "./legacyHeatmap";
import type { BoxSubregionStatsState } from "./useBoxSubregionStats";
import type { NativePitchEventsState } from "./useNativePitchEvents";
import { SpatialPitch } from "./SpatialPitch";
import { nativeMarkerOriginWorld } from "./WebGLSpatialPitch";
import {
  DEFAULT_WEBGL_CAMERA, GLB_PITCH_HALF_LENGTH_METERS, GLB_PITCH_HALF_WIDTH_METERS,
  GLB_PITCH_LENGTH_METERS, GLB_PITCH_WIDTH_METERS, FREEFLY_BOUNDS, WEBGL_CAMERA_PRESETS,
  cameraPositionFromOrbit, clampWebglZoom, fifaPenaltySpotWorld, freeflyStateFromOrbit,
  moveFreeflyCamera, pitchPercentToWorld, pinchWebglZoom,
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

// import.meta.url does not resolve to a real filesystem path under jsdom.
const boxFixture = boxSubregionEnvelopeSchema.parse(JSON.parse(readFileSync(
  resolve(import.meta.dirname, "../../../../messi-specs/fixtures/box-subregion-kane-2025-2026-league8.json"),
  "utf-8",
)));

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("footballpitchv3 coordinate contract", () => {
  it("pinches relative to gesture start and clamps zoom without invalid-distance jumps", () => {
    expect(pinchWebglZoom(1, 100, 200)).toBe(2);
    expect(pinchWebglZoom(2, 100, 50)).toBe(1);
    expect(pinchWebglZoom(2, 100, 400)).toBe(3);
    expect(pinchWebglZoom(2, 0, 200)).toBe(2);
    expect(pinchWebglZoom(2, 100, NaN)).toBe(2);
  });
  it("places provider right on camera-right when facing the attacking goal", () => {
    const camera = { position: { x: 0, y: 4, z: 0 }, yaw: 180, pitch: 0 };
    const rightStep = moveFreeflyCamera(camera, { right: 1 });
    const providerRight = pitchPercentToWorld({ x: 80, y: 0 });
    const providerLeft = pitchPercentToWorld({ x: 80, y: 100 });
    // Compare independent camera movement basis, not just a forward/inverse roundtrip.
    expect(providerRight.x * rightStep.position.x).toBeGreaterThan(0);
    expect(providerLeft.x * rightStep.position.x).toBeLessThan(0);
  });
  it("maps the measured 68 m by 105.38557 m Y-up model around world origin", () => {
    expect(pitchPercentToWorld({ x: 50, y: 50 })).toMatchObject({ x: 0, z: 0 });
    expect(pitchPercentToWorld({ x: 0, y: 50 }).z).toBeCloseTo(-GLB_PITCH_HALF_LENGTH_METERS, 8);
    expect(pitchPercentToWorld({ x: 100, y: 50 }).z).toBeCloseTo(GLB_PITCH_HALF_LENGTH_METERS, 8);
    // Facing the attacking goal (+Z), physical right is -X (forward cross up).
    expect(pitchPercentToWorld({ x: 50, y: 0 }).x).toBeCloseTo(-GLB_PITCH_HALF_WIDTH_METERS, 8);
    expect(pitchPercentToWorld({ x: 50, y: 100 }).x).toBeCloseTo(GLB_PITCH_HALF_WIDTH_METERS, 8);
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
    // No fake 2D pitch fallback inside the actual WebGL canvas host itself —
    // scoped to `pitch` (the host div), not the whole container, since the
    // info dock's anatomical-figure SVG is a legitimate external sibling.
    expect(pitch.querySelector("svg")).not.toBeInTheDocument();
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

  it("keeps tactical zones independently switchable with CCA disabled", async () => {
    const { container } = render(<SpatialPitch analysis={analysisWith({})} layers={{ heatmap: true, markers: false, trajectories: false, cca: false }} />);
    const toggle = await screen.findByRole('button', { name: '전술 구역' });
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    expect(container.querySelector('[data-layer=positional-grid]')).toBeInTheDocument();
    expect(container.querySelector('[data-layer=cca-contour]')).not.toBeInTheDocument();
    fireEvent.click(toggle);
    expect(container.querySelector('[data-layer=positional-grid]')).not.toBeInTheDocument();
    fireEvent.click(toggle);
    expect(container.querySelector('[data-layer=positional-grid]')).toBeInTheDocument();
  });

  it("retains the tactical grid, both goals, full density, and 32x22 CCA input", async () => {
    const point = { x: 81, y: 46 };
    const { container } = render(<SpatialPitch analysis={analysisWith({
      heatmapPointCount: 1, heatmapPoints: [point],
      continuousCore: { available: true, definitionVersion: "continuous-hdr-50-v1", targetDensityPct: 50, achievedDensityPct: 50, coreAreaPct: 8, densityThreshold: .5, thresholdOfPeak: .5, gridColumns: 32, gridRows: 22 },
    })} fullActivityHeatmap={fullHeatmap([point])} />);
    await screen.findByRole("img", { name: /3D 회랑 WebGL 피치/ });
    // Five depth + four existing lane lines + the PK centre axis; no duplicate box sides.
    expect(container.querySelectorAll("[data-grid-segment]")).toHaveLength(10);
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
    expect(marker).toHaveAttribute("data-marker-renderer", "asset-football");
    expect(marker).toHaveAttribute("data-marker-size", "0.11");
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
    const tooltip = screen.getByRole("tooltip");
    expect(tooltip).toHaveTextContent("슈팅 비중");
    expect(tooltip).toHaveTextContent("50.0%");
    expect(tooltip).toHaveTextContent("활동 비중 16.7%");
    expect(tooltip).toHaveTextContent("슈팅 비중 50.0%");
    expect(tooltip).toHaveTextContent("슈팅 퀄리티");
    expect(tooltip.querySelector('[data-zone-shooting-quality="unavailable"]')).toHaveTextContent("—");
    expect(tooltip).toHaveTextContent("구역별 품질 데이터 미연결");
    const dock = container.querySelector('[data-pitch-info-dock]');
    expect(dock).toContainElement(tooltip);
    // Mobile-first, and never absolute-overlay at any breakpoint any more —
    // a dedicated lg: grid column reserves real space beside the canvas
    // instead (see the dedicated dock-placement test below for the full rationale).
    expect(dock).toHaveClass('lg:w-80'); // ~320px, enough for a readable figure without shrinking type
    expect(dock.className).not.toMatch(/\babsolute\b/);
    const rows = [...tooltip.querySelectorAll('p')].map(row => row.textContent);
    expect(rows.at(-2)).toContain('활동 비중');
    expect(rows.at(-1)).toContain('슈팅 비중');
    expect(tooltip.querySelector('dl')).toHaveTextContent("슛1득점1xG0.30");
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

  it("resolves the exact server box region on keyboard focus, independent of the 분석 구획·CCA toggle", async () => {
    const boxSubregion: BoxSubregionStatsState = { kind: "ready", key: "k", data: boxFixture };
    const { container } = render(<SpatialPitch analysis={analysisWith({})} layers={{ heatmap: false, markers: false, trajectories: false, cca: false }} boxSubregion={boxSubregion} />);
    await screen.findByRole("img", { name: /3D 회랑 WebGL 피치/ });
    // Turn the 분석 구획·CCA (30-zone) toggle off — the box region target must still be reachable.
    fireEvent.click(screen.getByRole("button", { name: "전술 구역" }));
    expect(container.querySelector('[data-layer=positional-grid]')).not.toBeInTheDocument();
    const l4 = container.querySelector<HTMLButtonElement>("[data-box-zone-keyboard-target='L4']")!;
    expect(l4).toBeInTheDocument();
    fireEvent.focus(l4);
    const box = container.querySelector('[data-box-zone-tooltip]')!;
    expect(box).toHaveAttribute("data-box-zone-id", "L4");
    expect(box).toHaveAttribute("data-box-zone-state", "ready");
    expect(box).toHaveTextContent("박스 좌");
    expect(box).toHaveTextContent("+1.64");
    expect(box.querySelector("dl")).toHaveTextContent("슛9득점2xG0.33");
    // Quality is the headline, but the interactive 3D readout must also carry
    // the joint eligibility ratio (and partial flag) — the passive panel
    // already had this; the review specifically flagged its absence here.
    expect(box).toHaveTextContent("적격 9/9");
    expect(box).toHaveTextContent("활동 비중");
    expect(box).toHaveTextContent("2.7%");
    fireEvent.blur(l4);
    expect(container.querySelector('[data-box-zone-tooltip]')).not.toBeInTheDocument();
  });

  it("marks a partial-quality box region's eligibility ratio in the interactive 3D readout, not just the passive panel", async () => {
    const boxSubregion: BoxSubregionStatsState = { kind: "ready", key: "k", data: boxFixture };
    const { container } = render(<SpatialPitch analysis={analysisWith({})} boxSubregion={boxSubregion} />);
    await screen.findByRole("img", { name: /3D 회랑 WebGL 피치/ });
    fireEvent.focus(container.querySelector<HTMLButtonElement>("[data-box-zone-keyboard-target='L3L']")!); // L3L is 30/31 eligible in the fixture
    const box = container.querySelector('[data-box-zone-tooltip]')!;
    expect(box).toHaveTextContent("적격 30/31");
    expect(box).toHaveTextContent("일부 표본");
  });

  it("clears both the legacy zone and box-region hover state on pointer leave and on camera reset — not only one of the two", async () => {
    const boxSubregion: BoxSubregionStatsState = { kind: "ready", key: "k", data: boxFixture };
    const { container } = render(<SpatialPitch analysis={analysisWith({
      shotmapSnapshotAvailable: true, shotmapPointCount: 1, shotmapPoints: [{ x: 8, y: 10, outcome: "goal", xg: .3 }],
      positionalGrid: [{ depth: 0, lane: 0, occupancyPct: 16.67 }],
    })} boxSubregion={boxSubregion} />);
    const pitch = await screen.findByRole("img", { name: /3D 회랑 WebGL 피치/ });
    fireEvent.focus(container.querySelector<HTMLButtonElement>("[data-zone-keyboard-target]")!);
    expect(container.querySelector('[data-zone-tooltip]')).toBeInTheDocument();
    fireEvent.pointerLeave(pitch);
    expect(container.querySelector('[data-zone-tooltip]')).not.toBeInTheDocument();

    fireEvent.focus(container.querySelector<HTMLButtonElement>("[data-box-zone-keyboard-target='L4']")!);
    expect(container.querySelector('[data-box-zone-tooltip]')).toBeInTheDocument();
    fireEvent.pointerLeave(pitch);
    expect(container.querySelector('[data-box-zone-tooltip]')).not.toBeInTheDocument();

    fireEvent.focus(container.querySelector<HTMLButtonElement>("[data-box-zone-keyboard-target='L4']")!);
    expect(container.querySelector('[data-box-zone-tooltip]')).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "기본 시점" })); // resetCamera
    expect(container.querySelector('[data-box-zone-tooltip]')).not.toBeInTheDocument();
  });

  it("keeps the info dock as a sibling of the WebGL host, never absolutely overlapping it at any breakpoint", async () => {
    const boxSubregion: BoxSubregionStatsState = { kind: "ready", key: "k", data: boxFixture };
    const { container } = render(<SpatialPitch analysis={analysisWith({})} boxSubregion={boxSubregion} />);
    await screen.findByRole("img", { name: /3D 회랑 WebGL 피치/ });
    const host = container.querySelector('[data-webgl-renderer]')!;
    const dock = container.querySelector('[data-pitch-info-dock]')!;
    expect(host.contains(dock)).toBe(false);
    expect(dock.parentElement).toBe(host.parentElement);
    // Never absolute at any breakpoint any more — below `lg` the dock sits in
    // normal document flow (full width, below the canvas); at `lg`+ its
    // parent switches to a two-column grid (see the wrapper test below) that
    // reserves the dock a real, non-overlapping column instead of stacking
    // it on top of the canvas the way the old always-absolute overlay did
    // (which is exactly what broke both the mobile clipping and the desktop
    // "obscures the selected path" defect independent review reported).
    expect(dock.className).not.toMatch(/\babsolute\b/);
    expect(dock.parentElement!.className).toContain("lg:grid");
  });

  it("shows the box region as honestly unavailable while the route still 404s, keyed to its own static label", async () => {
    const { container } = render(<SpatialPitch analysis={analysisWith({})} boxSubregion={{ kind: "error", key: "k" }} />);
    await screen.findByRole("img", { name: /3D 회랑 WebGL 피치/ });
    fireEvent.focus(container.querySelector<HTMLButtonElement>("[data-box-zone-keyboard-target='L2']")!);
    const box = container.querySelector('[data-box-zone-tooltip]')!;
    expect(box).toHaveAttribute("data-box-zone-state", "unavailable");
    expect(box).toHaveTextContent("박스 우");
    expect(box).toHaveTextContent("박스 구역 통계를 사용할 수 없습니다");
  });

  it("retains the truthful box-subregion panel in the reduced-motion 2D plan fallback, not just 3D", async () => {
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
    const boxSubregion: BoxSubregionStatsState = { kind: "ready", key: "k", data: boxFixture };
    const { container } = render(<SpatialPitch analysis={analysisWith({})} boxSubregion={boxSubregion} />);
    expect(container.querySelector("[data-box-subregion-panel]")).toBeInTheDocument();
    expect(container.querySelector('[data-box-subregion-region="L4"]')).toHaveTextContent("9슛 · 2골 · xG 0.33");
  });

  it("connects a real native-pitch-events selection to its own confirmed body part — a genuinely separate source from the FotMob shot layer, never joined by index/proximity", async () => {
    const native = nativePitchEventsEnvelopeSchema.parse(JSON.parse(readFileSync(
      resolve(import.meta.dirname, "../../../../messi-specs/evidence/native-pitch-http-20260908-canonical-v2/included.json"),
      "utf-8",
    )));
    const nativePitchEvents: NativePitchEventsState = { kind: "ready", key: "k", data: native };
    const { container } = render(<SpatialPitch analysis={analysisWith({})} forcedMode="perspective" nativePitchEvents={nativePitchEvents} />);
    await screen.findByRole("img", { name: /3D 회랑 WebGL 피치/ });
    const panel = container.querySelector("[data-native-pitch-events-panel]")!;
    expect(panel).toBeInTheDocument();
    const select = screen.getByRole("combobox", { name: "재생할 슈팅" });
    // The canonical fixture contains a projected source origin with no
    // usable endpoint. It remains a real marker/selection; only its
    // endpoint-dependent replay is unavailable.
    expect(native.events.some((event) => event.plot.state === "projected" && event.destination.kind === "unavailable")).toBe(true);
    const endpointUnavailable = native.events.find((event) => event.plot.state === "projected" && event.destination.kind === "unavailable")!;
    expect(nativeMarkerOriginWorld(endpointUnavailable)).toEqual(pitchPercentToWorld({ x: endpointUnavailable.plot.x!, y: endpointUnavailable.plot.y! }, 0.185));
    expect(container.querySelectorAll("[data-native-event-key]")).toHaveLength(native.events.filter((event) => event.plot.state === "projected").length);
    expect(container.querySelectorAll("[data-shot-marker]")).toHaveLength(0);
    expect(container.querySelector("[data-native-box-state]")).toHaveAttribute("data-native-box-state", "ready");
    const leftFootGoal = native.events.find((event) => event.identity.matchId === 14056037 && event.identity.shotId === 5473386)!;
    fireEvent.change(select, { target: { value: leftFootGoal.key } });
    const detail = container.querySelector("[data-native-pitch-event-detail]")!;
    expect(detail).toBeInTheDocument();
    expect(container.querySelector("[data-native-pitch-event-bodypart]")).toHaveTextContent("왼발 확정");
    expect(detail).toHaveTextContent("득점");
    expect(container.querySelector("[data-bodypart-attribution-note]")).toHaveTextContent("선택한 실제 기록 슛의 부위: 왼발");
    expect(container.querySelector("[data-webgl-renderer]")).toHaveAttribute("data-native-pose-key", leftFootGoal.key);
    fireEvent.change(screen.getByRole("combobox", { name: "슈팅 데이터 원천" }), { target: { value: "fotmob" } });
    expect(container.querySelector("[data-webgl-renderer]")).toHaveAttribute("data-shot-source", "fotmob");
    expect(container.querySelectorAll("[data-native-event-key]")).toHaveLength(0);
    expect(container.querySelector("[data-spatial-shot-note]")).not.toHaveTextContent("SportsAPI 동일 응답");
    // the 2D plan fallback must never receive this — 3D-only first integration, never implicitly relabelled onto 2D.
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
    const { container: plan } = render(<SpatialPitch analysis={analysisWith({})} nativePitchEvents={nativePitchEvents} />);
    expect(plan.querySelector("[data-native-pitch-events-panel]")).not.toBeInTheDocument();
  });

  it("never renders an unavailable SportsAPI envelope as observed zero", async () => {
    const native = nativePitchEventsEnvelopeSchema.parse(JSON.parse(readFileSync(
      resolve(import.meta.dirname, "../../../../messi-specs/evidence/native-pitch-http-20260908-canonical-v2/included.json"), "utf-8")));
    // The UI branch is driven by the strict transport's completeness field.
    // Event/body reconciliation is backend-owned and separately enforced by
    // its decoder tests; this isolates the presentation distinction.
    const unavailable = { kind: "ready" as const, key: "unavailable", data: { ...native, events: [], bodyParts: { ...native.bodyParts, completeness: "unavailable" as const } } } as NativePitchEventsState;
    const { container } = render(<SpatialPitch analysis={analysisWith({})} forcedMode="perspective" nativePitchEvents={unavailable} />);
    await screen.findByRole("img", { name: /3D 회랑 WebGL 피치/ });
    expect(container.querySelector("[data-spatial-shot-note]")).toHaveTextContent("원천이 관측되지 않았습니다");
    expect(container.querySelector("[data-spatial-shot-note]")).not.toHaveTextContent("슛 0개");
  });

  it("clears a selected native event when the pitch context changes — a stale native key never carries over", async () => {
    const native = nativePitchEventsEnvelopeSchema.parse(JSON.parse(readFileSync(
      resolve(import.meta.dirname, "../../../../messi-specs/evidence/native-pitch-http-20260908-canonical-v2/included.json"),
      "utf-8",
    )));
    const nativePitchEvents: NativePitchEventsState = { kind: "ready", key: "k", data: native };
    const { container, rerender } = render(<SpatialPitch analysis={analysisWith({})} forcedMode="perspective" contextIdentity="a" nativePitchEvents={nativePitchEvents} />);
    await screen.findByRole("img", { name: /3D 회랑 WebGL 피치/ });
    const select = screen.getByRole("combobox", { name: "재생할 슈팅" });
    fireEvent.change(select, { target: { value: native.events[0].key } });
    expect(container.querySelector("[data-native-pitch-event-detail]")).toBeInTheDocument();
    rerender(<SpatialPitch analysis={analysisWith({})} forcedMode="perspective" contextIdentity="b" nativePitchEvents={nativePitchEvents} />);
    expect(container.querySelector("[data-native-pitch-event-detail]")).not.toBeInTheDocument();
  });

  it("shows a short always-visible replay-honesty label and keeps the full limitations text behind a details disclosure, not as two long always-visible paragraphs", async () => {
    const shots = [{ x: 80, y: 20, outcome: "goal" as const, xg: .4, xgot: .6, trajectory: { schemaVersion: "shotmap-trajectory-v1" as const, endpointKind: "goal_mouth" as const, endX: 100, endY: 52, endZMeters: 1.2, source: "fotmob" as const } }];
    const { container } = render(<SpatialPitch analysis={analysisWith({ shotmapSnapshotAvailable: true, shotmapPointCount: shots.length, shotmapPoints: shots })} forcedMode="perspective" />);
    await screen.findByRole("img", { name: /3D 회랑 WebGL 피치/ });
    const shortNote = container.querySelector("[data-replay-short-note]");
    expect(shortNote).toHaveTextContent("기록 기반 모식 재생 · 실제 비행 궤적 아님");
    const details = shortNote!.nextElementSibling as HTMLDetailsElement;
    expect(details.tagName).toBe("DETAILS");
    // jsdom keeps collapsed <details> content in the DOM/textContent regardless of the open attribute.
    expect(details).toHaveTextContent("유효슛의 골문 좌표는 선방 위치를 뜻하지 않습니다");
    expect(details).toHaveTextContent("중간 포물선·2.4초 재생 시간은 연출이며 실제 속도·회전·비행 궤적이 아닙니다");
  });

  it("prints the full Tier 3 activity-coordinate count once, not twice, on the 3D perspective page", async () => {
    const point = { x: 81, y: 46 };
    const { container } = render(<SpatialPitch analysis={analysisWith({ heatmapPointCount: 1, heatmapPoints: [point] })} fullActivityHeatmap={fullHeatmap([point])} forcedMode="perspective" />);
    await screen.findByRole("img", { name: /3D 회랑 WebGL 피치/ });
    const matches = (container.textContent!.match(/full Tier 3 활동 좌표 1개/g) ?? []).length;
    expect(matches).toBe(1);
  });

  it("keeps the exact selected replay event's own result/xG/xGOT visible through playback — not the group's representative shot at the same coordinate", async () => {
    // Two distinct real goals sharing one exact coordinate (Kane has 11 such
    // penalty events) — groupPitchShots keeps only ONE representative per
    // coordinate for the marker, but the replay/result display must always
    // reflect whichever raw event is actually selected, not that representative.
    const trajectory = { schemaVersion: "shotmap-trajectory-v1" as const, endpointKind: "goal_mouth" as const, endX: 100, endY: 50, endZMeters: 1.0, source: "fotmob" as const };
    const shots = [
      { x: 89.5, y: 50, outcome: "goal" as const, xg: 0.9, xgot: 1.0, trajectory },
      { x: 89.5, y: 50, outcome: "goal" as const, xg: 0.3, xgot: 0.4, trajectory },
    ];
    render(<SpatialPitch analysis={analysisWith({ shotmapSnapshotAvailable: true, shotmapPointCount: shots.length, shotmapPoints: shots })} forcedMode="perspective" />);
    const pitch = await screen.findByRole("img", { name: /3D 회랑 WebGL 피치/ });
    // Select the FIRST raw event (#1, xG 0.90) via the replay dropdown — the
    // group's own representative (rank ties resolve to the later shot) would
    // otherwise be the SECOND one (xG 0.30).
    fireEvent.change(screen.getByRole("combobox", { name: "재생할 슈팅" }), { target: { value: "0" } });
    fireEvent.focus(screen.getByRole("button", { name: "재생" })); // moves focus away from any marker
    expect(pitch.ownerDocument.activeElement).not.toBe(null);
    const tooltip = screen.getByRole("tooltip");
    expect(tooltip).toHaveTextContent("xG 0.90");
    expect(tooltip).toHaveTextContent("xGOT 1.00");
    expect(tooltip).not.toHaveTextContent("xG 0.30");
  });
});
