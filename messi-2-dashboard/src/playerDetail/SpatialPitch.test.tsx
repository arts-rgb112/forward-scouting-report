// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { PlayerAnalysis } from "../dashboard/types";
import { deriveOrbitPivot, GOAL_CROSSBAR_HEIGHT_METERS, GOAL_POST_Y, GOAL_WIDTH_METERS, PITCH_WIDTH_METERS, POSITIONAL_LANE_BOUNDARIES, projectPerspective, SIX_YARD_BOX_Y, SpatialPitch } from "./SpatialPitch";
import { DISPLAY_HEATMAP_COLUMNS, DISPLAY_HEATMAP_ROWS, HEATMAP_COLUMNS, HEATMAP_OPACITY, HEATMAP_ROWS, displayDensityGrid, displayHeatmapColor, legacyDensityGrid, normalizeDensity } from "./legacyHeatmap";
import { outcomePresentation } from "./shotOutcomeVisibility";

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

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

const svgBounds = (width: number, height: number) => ({
  x: 0, y: 0, width, height, top: 0, right: width, bottom: height, left: 0, toJSON: () => ({}),
}) as DOMRect;

describe("perspective spatial pitch", () => {
  it("preserves attacking x and places right Lane 1 on the near lower edge", () => {
    const rightDefensive = projectPerspective({ x: 0, y: 0 });
    const rightAttacking = projectPerspective({ x: 100, y: 0 });
    const leftDefensive = projectPerspective({ x: 0, y: 100 });
    expect(rightAttacking.x).toBeGreaterThan(rightDefensive.x);
    expect(rightDefensive.y).toBeGreaterThan(leftDefensive.y);
    expect(Number.isFinite(rightDefensive.x)).toBe(true);
    expect(Number.isFinite(leftDefensive.y)).toBe(true);
  });

  it("projects the approved 20-zone geometry without zone labels", () => {
    const { container } = render(<SpatialPitch analysis={analysisWith({})}/>);
    const segments = [...container.querySelectorAll("[data-grid-segment]")];
    expect(segments).toHaveLength(17);
    expect(segments.every((segment) => Boolean(segment.getAttribute("d")))).toBe(true);
    expect(container.querySelectorAll("[data-zone-label], [data-zone-key]")).toHaveLength(0);
    expect(screen.queryByText(/D1|L1/)).not.toBeInTheDocument();
  });

  it("renders source-shot shares in the 3D corridor and exposes the full hover breakdown", () => {
    const { container } = render(<SpatialPitch analysis={analysisWith({ shotmapSnapshotAvailable: true, shotmapPointCount: 2, shotmapPoints: [{ x: 8, y: 10, outcome: "goal", xg: .3 }, { x: 80, y: 90, outcome: "on_target", xg: .2 }], positionalGrid: [{ depth: 0, lane: 0, occupancyPct: 16.67 }] })}/>);
    expect(container.querySelector('[data-layer="positional-occupancy-labels"]')).not.toBeNull();
    const label = screen.getByText("50.00%");
    expect(label).toHaveAttribute("data-zone-shot-share", "50.00");
    fireEvent.pointerEnter(label);
    expect(screen.getByRole("tooltip")).toHaveTextContent("슈팅 비중 50.00% · 활동 16.67%");
    expect(screen.getByRole("tooltip")).toHaveTextContent("슛 1 · 득점 1 · xG 0.30");
  });

  it("keeps terrain finite across every approved camera-angle and zoom-preset combination", () => {
    const { container } = render(<SpatialPitch analysis={analysisWith({ heatmapPointCount: 1, heatmapPoints: [{ x: 85, y: 50 }] })}/>);
    const terrain = () => container.querySelector("[data-terrain-frame-from-x]")!;
    for (const angle of ["좌측", "우측", "골대 정면", "골대 뒤"]) {
      fireEvent.click(screen.getByRole("button", { name: angle }));
      for (const frame of ["전체 필드", "공격 진영", "박스"]) {
        fireEvent.click(screen.getByRole("button", { name: frame }));
        expect(terrain().getAttribute("d")).not.toMatch(/NaN|Infinity/);
        expect(terrain()).toHaveAttribute("data-terrain-frame-from-x", frame === "전체 필드" ? "0" : frame === "공격 진영" ? "50" : "80");
      }
    }
  });

  it("adds both goal frames and nets but no inferred shot trajectory", () => {
    const { container } = render(<SpatialPitch analysis={analysisWith({ shotmapSnapshotAvailable: true, shotmapPointCount: 1, shotmapPoints: [{ x: 80, y: 50, outcome: "goal" }] })}/>);
    expect(container.querySelectorAll("[data-goal]")).toHaveLength(2);
    expect(container.querySelector('[data-goal="defending"] [data-goal-frame]')).toBeInTheDocument();
    expect(container.querySelector('[data-goal="attacking"] [data-goal-net]')).toBeInTheDocument();
    expect(container.querySelector("[data-shot-trajectory]")).not.toBeInTheDocument();
  });

  it("uses the regulation goal mouth, independently of six-yard and positional lane boundaries", () => {
    const { container } = render(<SpatialPitch analysis={analysisWith({})}/>);
    const [nearPost, farPost] = GOAL_POST_Y;
    expect(nearPost).toBeCloseTo((34 - 3.66) / 68 * 100, 10);
    expect(farPost).toBeCloseTo((34 + 3.66) / 68 * 100, 10);
    expect(farPost - nearPost).toBeCloseTo(GOAL_WIDTH_METERS / PITCH_WIDTH_METERS * 100, 10);
    expect(nearPost).toBeGreaterThan(37);
    expect(farPost).toBeLessThan(63);
    expect(SIX_YARD_BOX_Y[0]).toBeLessThan(nearPost);
    expect(SIX_YARD_BOX_Y[1]).toBeGreaterThan(farPost);
    expect(SIX_YARD_BOX_Y).not.toEqual(POSITIONAL_LANE_BOUNDARIES.slice(2, 4));
    for (const goal of [...container.querySelectorAll("[data-goal]")]) {
      expect(goal).toHaveAttribute("data-goal-post-near-y", String(nearPost));
      expect(goal).toHaveAttribute("data-goal-post-far-y", String(farPost));
    }
  });

  it("aligns source endpoint heights to the attacking crossbar without marker scaling", () => {
    const heightCases = [0, 1.2, GOAL_CROSSBAR_HEIGHT_METERS, 3.66] as const;
    const shots = heightCases.map((endZMeters, index) => ({ x: 80 - index, y: 50, outcome: "goal" as const, trajectory: { schemaVersion: "shotmap-trajectory-v1" as const, endpointKind: "goal_mouth" as const, endX: 100, endY: 50, endZMeters, source: "fotmob" as const } }));
    const { container } = render(<SpatialPitch analysis={analysisWith({ shotmapSnapshotAvailable: true, shotmapPointCount: shots.length, shotmapPoints: shots })}/>);
    const paths = [...container.querySelectorAll('[data-trajectory-kind="goal_mouth"]')];
    const attackingGoal = container.querySelector('[data-goal="attacking"]')!;
    expect(Number(attackingGoal.getAttribute("data-goal-frame-lift"))).toBeGreaterThan(0);
    expect(attackingGoal).toHaveAttribute("data-goal-crossbar-height-meters", String(GOAL_CROSSBAR_HEIGHT_METERS));
    expect(paths).toHaveLength(heightCases.length);
    for (const [index, path] of paths.entries()) {
      expect(Number(path.getAttribute("data-end-height-meters"))).toBe(heightCases[index]);
      expect(Number.isFinite(Number(path.getAttribute("data-end-render-x")))).toBe(true);
      expect(Number.isFinite(Number(path.getAttribute("data-end-render-y")))).toBe(true);
    }
    expect(paths[0].getAttribute("data-end-render-y")).not.toBe(paths[3].getAttribute("data-end-render-y"));
  });

  it("keeps endpoint-to-crossbar height ratios fixed when responsive marker pixelScale changes", () => {
    const rendered = { width: 1000, height: 650 };
    vi.spyOn(SVGSVGElement.prototype, "getBoundingClientRect").mockImplementation(() => svgBounds(rendered.width, rendered.height));
    const resizeCallbacks: Array<() => void> = [];
    vi.stubGlobal("ResizeObserver", class {
      constructor(callback: ResizeObserverCallback) { resizeCallbacks.push(() => callback([], this as unknown as ResizeObserver)); }
      observe() {}
      unobserve() {}
      disconnect() {}
    });
    const shots = [{ x: 80, y: 20, outcome: "goal" as const, trajectory: { schemaVersion: "shotmap-trajectory-v1" as const, endpointKind: "goal_mouth" as const, endX: 100, endY: 50, endZMeters: 1.2, source: "fotmob" as const } }];
    const { container } = render(<SpatialPitch analysis={analysisWith({ shotmapSnapshotAvailable: true, shotmapPointCount: 1, shotmapPoints: shots })}/>);
    const path = container.querySelector('[data-trajectory-kind="goal_mouth"]')!;
    const marker = container.querySelector("[data-marker-visual]")!;
    const desktop = { markerScale: Number(marker.getAttribute("data-pixel-scale")), endpointY: path.getAttribute("data-end-render-y") };

    rendered.width = 320;
    rendered.height = 208;
    act(() => resizeCallbacks[0]());

    expect(Number(marker.getAttribute("data-pixel-scale"))).toBeCloseTo(3.125);
    expect(path).toHaveAttribute("data-end-render-y", desktop.endpointY);
  });

  it("does not invent a flight when endpoint height is unknown and retains source mouth classification", () => {
    const shots = [
      { x: 80, y: 20, outcome: "goal" as const, trajectory: { schemaVersion: "shotmap-trajectory-v1" as const, endpointKind: "goal_mouth" as const, endX: 100, endY: 50, endZMeters: null, source: "fotmob" as const } },
      { x: 78, y: 22, outcome: "on_target" as const, trajectory: { schemaVersion: "shotmap-trajectory-v1" as const, endpointKind: "goal_mouth" as const, endX: 100, endY: 40, endZMeters: 1.2, source: "fotmob" as const } },
    ];
    const { container } = render(<SpatialPitch analysis={analysisWith({ shotmapSnapshotAvailable: true, shotmapPointCount: shots.length, shotmapPoints: shots })}/>);
    const unknownHeight = container.querySelector('[data-trajectory-kind="goal_mouth"][data-end-pitch-y="50"]');
    const outsideMouth = container.querySelector('[data-trajectory-kind="goal_mouth"][data-end-pitch-y="40"]')!;
    expect(unknownHeight).not.toBeInTheDocument();
    expect(outsideMouth).toHaveAttribute("data-end-goal-mouth", "outside");
  });

  it("uses result-specific fading trajectories without shadows or tie ribs", () => {
    const shots = [
      { x: 80, y: 20, outcome: "goal" as const, trajectory: { schemaVersion: "shotmap-trajectory-v1" as const, endpointKind: "goal_mouth" as const, endX: 100, endY: 52, endZMeters: 1.2, source: "fotmob" as const } },
      { x: 78, y: 28, outcome: "on_target" as const, trajectory: { schemaVersion: "shotmap-trajectory-v1" as const, endpointKind: "goal_mouth" as const, endX: 100, endY: 48, endZMeters: .8, source: "fotmob" as const } },
      { x: 70, y: 60, outcome: "blocked" as const, trajectory: { schemaVersion: "shotmap-trajectory-v1" as const, endpointKind: "blocked" as const, endX: 78, endY: 56, endZMeters: null, source: "fotmob" as const } },
      { x: 75, y: 40, outcome: "off_target" as const, trajectory: null },
    ];
    const { container } = render(<SpatialPitch analysis={analysisWith({ shotmapSnapshotAvailable: true, shotmapPointCount: shots.length, shotmapPoints: shots })}/>);
    const paths = [...container.querySelectorAll("[data-shot-trajectory]")];
    expect(paths).toHaveLength(2);
    const goalPath = container.querySelector('[data-trajectory-kind="goal_mouth"]')!;
    expect(Number.isFinite(Number(goalPath.getAttribute("data-end-render-x")))).toBe(true);
    expect(Number.isFinite(Number(goalPath.getAttribute("data-end-render-y")))).toBe(true);
    expect(container.querySelector('[data-shot-trajectory-shadow]')).not.toBeInTheDocument();
    expect(container.querySelector('[data-shot-trajectory-tie]')).not.toBeInTheDocument();
    expect(container.querySelector('[data-trajectory-outcome="goal"] path')).toHaveAttribute("stroke", "#BEF264");
    expect(container.querySelector('[data-trajectory-outcome="on_target"] path')).toHaveAttribute("stroke", "#38BDF8");
    expect(container.querySelector('[data-trajectory-kind="blocked"]')).not.toBeInTheDocument();
    expect(container.querySelector('[data-shot-marker][data-shot-outcome="goal"]')).toHaveAccessibleName(/골대 도달 지점 100\.0, 52\.0, 높이 1\.20 m/);
    expect(screen.getByRole("list", { name: "서버 슈팅 이벤트" })).toHaveTextContent(/블록/);
  });

  it("filters matching trajectory paths and keeps the exact 2D fallback marker-only", () => {
    const shots = [
      { x: 80, y: 20, outcome: "goal" as const, trajectory: { schemaVersion: "shotmap-trajectory-v1" as const, endpointKind: "goal_mouth" as const, endX: 100, endY: 52, endZMeters: 1.2, source: "fotmob" as const } },
      { x: 70, y: 60, outcome: "blocked" as const, trajectory: { schemaVersion: "shotmap-trajectory-v1" as const, endpointKind: "blocked" as const, endX: 78, endY: 56, endZMeters: null, source: "fotmob" as const } },
    ];
    const { container } = render(<SpatialPitch analysis={analysisWith({ shotmapSnapshotAvailable: true, shotmapPointCount: shots.length, shotmapPoints: shots })}/>);
    fireEvent.click(screen.getByRole("button", { name: /득점, 1 shots/ }), { detail: 0 });
    expect(container.querySelector('[data-trajectory-kind="goal_mouth"]')).not.toBeInTheDocument();
    expect(container.querySelector('[data-trajectory-kind="blocked"]')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "2D 회랑" }));
    expect(container.querySelector('[data-layer="shot-trajectories-2d"]')).toBeInTheDocument();
  });

  it("renders a 96 by 66 display mesh while keeping the source 32 by 22 grid for CCA", () => {
    const point = { x: 44, y: 21.82 };
    const analysis = analysisWith({ heatmapPointCount: 1, heatmapPoints: [point], shotmapSnapshotAvailable: true, shotmapPointCount: 1, shotmapPoints: [{ ...point, outcome: "goal", xg: .72, xgot: .84 }] });
    const { container } = render(<SpatialPitch analysis={analysis}/>);
    const normalized = normalizeDensity(legacyDensityGrid([point]));
    const display = displayDensityGrid(normalized);
    const row = Math.floor(point.y / 100 * DISPLAY_HEATMAP_ROWS), column = Math.floor(point.x / 100 * DISPLAY_HEATMAP_COLUMNS);
    const heat = container.querySelector(`[data-density-row="${row}"][data-density-column="${column}"]`)!; const shot = container.querySelector("[data-shot-marker]");
    const [red, green, blue, alpha] = displayHeatmapColor(display[row * DISPLAY_HEATMAP_COLUMNS + column]);
    expect(container.querySelectorAll("[data-density-cell]")).toHaveLength(DISPLAY_HEATMAP_ROWS * DISPLAY_HEATMAP_COLUMNS);
    expect(container.querySelectorAll("[data-heat-point]")).toHaveLength(0);
    expect(heat).toHaveAttribute("data-density-normalized", String(display[row * DISPLAY_HEATMAP_COLUMNS + column]));
    expect(heat).toHaveAttribute("fill", `rgb(${red} ${green} ${blue})`);
    expect(heat).toHaveAttribute("fill-opacity", String(alpha * HEATMAP_OPACITY));
    expect(heat.closest("[data-layer=heat]")).toHaveAttribute("clip-path");
    expect(heat.closest("[data-layer=heat]")).toHaveAttribute("data-density-source", "display-96x66");
    expect(heat.closest("[data-layer=heat]")).toHaveAttribute("filter", expect.stringContaining("display-heat-blur"));
    expect(heat.closest("[data-layer=heat]")).not.toHaveAttribute("style");
    expect(container.querySelector("filter feGaussianBlur")).toHaveAttribute("stdDeviation", "9");
    expect(container.querySelector('linearGradient stop')).toHaveAttribute("stop-color", "#123A20");
    expect(container.querySelector('[data-layer="pitch-markings"] path')).toHaveAttribute("stroke", "#FFFFFF");
    expect(container.querySelector('[data-layer="positional-grid"]')).toHaveAttribute("stroke", "#FFFFFF");
    expect(container.querySelector('[data-layer="positional-grid"]')).toHaveAttribute("stroke-width", "1");
    expect(Number.isFinite(Number(shot?.getAttribute("data-screen-x")))).toBe(true);
    expect(Number.isFinite(Number(shot?.getAttribute("data-screen-y")))).toBe(true);
    expect(shot).toHaveAttribute("data-marker-symbol", "star");
    expect(shot).toHaveAttribute("tabindex", "0");
    expect(screen.getByRole("list", { name: "서버 슈팅 이벤트" })).toHaveTextContent(/득점 · xG 0.72 · xGOT 0.84/);
    expect(screen.getAllByText(/1 activity points.*1 shots|활동 좌표 1개.*슛 1개/).length).toBeGreaterThan(0);
  });

  it("keeps unavailable snapshots distinct from available verified zero", () => {
    const { rerender } = render(<SpatialPitch analysis={analysisWith({ available: false })}/>);
    expect(screen.getAllByText(/Activity heatmap unavailable|활동 히트맵 사용 불가/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Shot snapshot unavailable|슈팅 스냅샷 사용 불가/).length).toBeGreaterThan(0);
    rerender(<SpatialPitch analysis={analysisWith({ available: true, shotmapSnapshotAvailable: true })}/>);
    expect(screen.getAllByText(/Verified zero activity points|관측된 활동 좌표 0개/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Verified zero shots|관측된 슛 0개/).length).toBeGreaterThan(0);
  });

  it("keeps a production-sized payload bounded while camera distance rebuilds one fixed-size mesh", () => {
    const heatmapPoints = Array.from({ length: 2000 }, (_, index) => ({ x: index % 100, y: (index * 7) % 100 }));
    const shotmapPoints = Array.from({ length: 150 }, (_, index) => ({ x: 70 + index % 30, y: 25 + index % 50, outcome: "on_target" as const, xg: .1, xgot: .2 }));
    const { container } = render(<SpatialPitch analysis={analysisWith({ heatmapPointCount: heatmapPoints.length, heatmapPoints, shotmapSnapshotAvailable: true, shotmapPointCount: shotmapPoints.length, shotmapPoints })}/>);
    const before = [...container.querySelectorAll("[data-density-cell]")];
    const heatLayer = container.querySelector("[data-layer=heat]")!;
    const meshBuilds = heatLayer.getAttribute("data-density-mesh-builds");
    expect(before).toHaveLength(DISPLAY_HEATMAP_ROWS * DISPLAY_HEATMAP_COLUMNS);
    fireEvent.click(screen.getByRole("button", { name: "확대" }));
    const viewport = container.querySelector("svg[role=img]")!;
    fireEvent.keyDown(viewport, { key: "ArrowRight" });
    expect([...container.querySelectorAll("[data-density-cell]")]).toEqual(before);
    expect(Number(heatLayer.getAttribute("data-density-mesh-builds"))).toBe(Number(meshBuilds) + 1);
    expect(container.querySelectorAll("[data-shot-marker]")).toHaveLength(150);
    expect(container.querySelectorAll('[data-shot-marker][tabindex="0"]')).toHaveLength(1);
    expect(within(screen.getByRole("list", { name: "서버 슈팅 이벤트" })).getAllByRole("listitem")).toHaveLength(150);
  });

  it("derives a stable shot-median pivot and falls back to the native heat peak", () => {
    const shots = [{ x: 70, y: 20, outcome: "goal" as const }, { x: 90, y: 80, outcome: "on_target" as const }];
    const shotSpatial = analysisWith({ shotmapSnapshotAvailable: true, shotmapPointCount: 2, shotmapPoints: shots }).spatial;
    expect(deriveOrbitPivot(shotSpatial, new Float64Array(HEATMAP_COLUMNS * HEATMAP_ROWS))).toEqual([84, 34, 0]);
    const heat = new Float64Array(HEATMAP_COLUMNS * HEATMAP_ROWS);
    heat[3 * HEATMAP_COLUMNS + 5] = 1;
    expect(deriveOrbitPivot(analysisWith({}).spatial, heat)).toEqual([((5.5 / HEATMAP_COLUMNS) * 105), ((3.5 / HEATMAP_ROWS) * 68), 0]);
    expect(deriveOrbitPivot(undefined, new Float64Array(HEATMAP_COLUMNS * HEATMAP_ROWS))).toEqual([82, 34, 0]);
  });

  it("fails closed for unavailable, mismatched, and invalid heatmap coordinates", () => {
    const { container, rerender } = render(<SpatialPitch analysis={analysisWith({ available: false })}/>);
    expect(container.querySelectorAll("[data-density-cell]")).toHaveLength(DISPLAY_HEATMAP_ROWS * DISPLAY_HEATMAP_COLUMNS);
    expect([...container.querySelectorAll("[data-density-cell]")].every((cell) => cell.getAttribute("data-density-normalized") === "0")).toBe(true);
    rerender(<SpatialPitch analysis={analysisWith({ heatmapPointCount: 2, heatmapPoints: [{ x: 50, y: 50 }] })}/>);
    expect(screen.getAllByText(/Activity heatmap integrity mismatch|활동 히트맵 무결성 불일치/).length).toBeGreaterThan(0);
    expect([...container.querySelectorAll("[data-density-cell]")].every((cell) => cell.getAttribute("data-density-normalized") === "0")).toBe(true);
    rerender(<SpatialPitch analysis={analysisWith({ heatmapPointCount: 1, heatmapPoints: [{ x: 101, y: 50 }] })}/>);
    expect([...container.querySelectorAll("[data-density-cell]")].every((cell) => cell.getAttribute("data-density-normalized") === "0")).toBe(true);
  });

  it("uses one clamped camera distance for buttons, wheel, and touch pinch while keeping azimuth free", () => {
    vi.spyOn(SVGSVGElement.prototype, "getBoundingClientRect").mockImplementation(() => svgBounds(1000, 650));
    const analysis = analysisWith({ heatmapPointCount: 1, heatmapPoints: [{ x: 50, y: 50 }], shotmapSnapshotAvailable: true, shotmapPointCount: 1, shotmapPoints: [{ x: 80, y: 50, outcome: "goal" }] });
    const { container, rerender } = render(<SpatialPitch analysis={analysis} contextIdentity="one"/>);
    const viewport = () => container.querySelector("svg[role=img]")!;
    expect(viewport()).toHaveAttribute("viewBox", "0 0 1000 650");
    expect(viewport()).toHaveAttribute("data-camera-pivot", "84,34,0");
    expect(viewport()).toHaveAttribute("data-camera-distance", "84");
    fireEvent.click(screen.getByRole("button", { name: "확대" }));
    expect(viewport()).toHaveAttribute("viewBox", "0 0 1000 650");
    expect(viewport()).toHaveAttribute("data-camera-distance", "72");
    fireEvent.wheel(viewport(), { deltaY: 100 });
    expect(viewport()).toHaveAttribute("data-camera-distance", "76");
    fireEvent.pointerDown(viewport(), { pointerId: 11, pointerType: "touch", clientX: 100, clientY: 100 });
    fireEvent.pointerDown(viewport(), { pointerId: 12, pointerType: "touch", clientX: 200, clientY: 100 });
    fireEvent.pointerMove(viewport(), { pointerId: 12, pointerType: "touch", clientX: 300, clientY: 100 });
    expect(Number(viewport().getAttribute("data-camera-distance"))).toBeCloseTo(48);
    fireEvent.pointerUp(viewport(), { pointerId: 11, pointerType: "touch" });
    fireEvent.pointerUp(viewport(), { pointerId: 12, pointerType: "touch" });
    fireEvent.click(screen.getByRole("button", { name: "축소" }));
    expect(viewport()).toHaveAttribute("data-camera-distance", "60");
    const densityCell = container.querySelector("[data-density-cell]")!;
    expect(viewport()).toHaveAttribute("data-camera-azimuth", "-48");
    fireEvent.pointerDown(densityCell, { pointerId: 1, clientX: 500, clientY: 325 });
    fireEvent.pointerMove(viewport(), { pointerId: 1, clientX: -1500, clientY: 1000 });
    expect(Number(viewport().getAttribute("data-camera-azimuth"))).toBeGreaterThan(360);
    expect(viewport()).toHaveAttribute("data-camera-elevation", "65");
    fireEvent.pointerCancel(viewport(), { pointerId: 1 });
    fireEvent.keyDown(viewport(), { key: "Escape" });
    expect(viewport()).toHaveAttribute("data-camera-azimuth", "-48");
    expect(viewport()).toHaveAttribute("data-camera-elevation", "30");
    expect(viewport()).toHaveAttribute("data-camera-distance", "84");
    rerender(<SpatialPitch analysis={analysis} contextIdentity="two"/>);
    expect(viewport()).toHaveAttribute("data-camera-distance", "84");
  });

  it("defaults reduced-motion users to the responsive 2D fallback and remains keyboard switchable", () => {
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
    render(<SpatialPitch analysis={analysisWith({})}/>);
    const group = screen.getByRole("group", { name: "피치 보기" });
    expect(within(group).getByRole("button", { name: "2D 회랑" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("group", { name: "Interactive two-dimensional shot markers" })).toBeInTheDocument();
    fireEvent.click(within(group).getByRole("button", { name: "3D 회랑" }));
    expect(screen.getByRole("img", { name: /3D 회랑/ })).toBeInTheDocument();
  });

  it("shares marker visibility between Perspective and exact 2D while totals and details remain unfiltered", () => {
    const shots = [{ x: 80, y: 20, outcome: "goal" as const, xg: .4, xgot: null }, { x: 75, y: 35, outcome: "on_target" as const }, { x: 70, y: 50, outcome: "off_target" as const }, { x: 65, y: 65, outcome: "blocked" as const }];
    const { container } = render(<SpatialPitch analysis={analysisWith({ shotmapSnapshotAvailable: true, shotmapPointCount: 4, shotmapPoints: shots })}/>);
    const goals = screen.getByRole("button", { name: /득점, 1 shots/ }); fireEvent.click(goals, { detail: 0 });
    expect(container.querySelectorAll('[data-shot-marker][data-shot-outcome="goal"]')).toHaveLength(0); expect(container.querySelectorAll("[data-shot-marker]")).toHaveLength(3);
    expect(screen.getByRole("list", { name: "서버 슈팅 이벤트" }).children).toHaveLength(4);
    fireEvent.click(screen.getByRole("button", { name: "2D 회랑" }));
    expect(screen.getByRole("group", { name: "Interactive two-dimensional shot markers" })).toBeInTheDocument();
    expect(container.querySelectorAll('[data-layer="legacy-events"] [data-shot-outcome="goal"]')).toHaveLength(0); expect(container.querySelectorAll('[data-layer="legacy-events"] [data-shot-index]')).toHaveLength(3);
    expect(screen.getByText(/득점 ◇ · 유효 슛 ● · 빗나감 × · 블록 ■/, { selector: "figcaption" })).toBeInTheDocument();
    fireEvent.click(goals, { detail: 0 }); expect(container.querySelectorAll('[data-layer="legacy-events"] [data-shot-index]')).toHaveLength(4);
  });

  it("handles click races, same-outcome doubles, keyboard activation, and context reset", () => {
    vi.useFakeTimers();
    const shots = [{ x: 80, y: 20, outcome: "goal" as const }, { x: 75, y: 35, outcome: "on_target" as const }, { x: 70, y: 50, outcome: "off_target" as const }, { x: 65, y: 65, outcome: "blocked" as const }];
    const populated = analysisWith({ shotmapSnapshotAvailable: true, shotmapPointCount: 4, shotmapPoints: shots });
    const { container, rerender } = render(<SpatialPitch analysis={populated} contextIdentity="one"/>);
    const goals = screen.getByRole("button", { name: /득점, 1 shots/ }), onTarget = screen.getByRole("button", { name: /유효 슛, 1 shots/ });
    fireEvent.click(goals, { detail: 1 }); fireEvent.click(onTarget, { detail: 1 });
    expect(container.querySelectorAll('[data-shot-outcome="goal"]')).toHaveLength(0); expect(container.querySelectorAll('[data-shot-outcome="on_target"]')).toHaveLength(1);
    act(() => vi.advanceTimersByTime(350)); expect(container.querySelectorAll('[data-shot-outcome="on_target"]')).toHaveLength(0);
    fireEvent.click(goals, { detail: 0 }); expect(container.querySelectorAll('[data-shot-outcome="goal"]')).toHaveLength(1);
    fireEvent.click(goals, { detail: 1 }); fireEvent.doubleClick(goals); act(() => vi.advanceTimersByTime(350)); expect(container.querySelectorAll("[data-shot-marker]")).toHaveLength(1);
    rerender(<SpatialPitch analysis={populated} contextIdentity="two"/>); act(() => vi.advanceTimersByTime(350)); expect(container.querySelectorAll("[data-shot-marker]")).toHaveLength(4);
  });

  it("fails closed on an invalid snapshot without disturbing the 30-zone pitch", () => {
    const { container } = render(<SpatialPitch analysis={analysisWith({ shotmapSnapshotAvailable: true, shotmapPointCount: 2, shotmapPoints: [{ x: 80, y: 20, outcome: "goal" }] })}/>);
    expect(screen.queryByRole("group", { name: "Shot outcome visibility" })).not.toBeInTheDocument(); expect(container.querySelectorAll("[data-shot-marker]")).toHaveLength(0);
    expect(screen.getAllByText(/Shot snapshot integrity mismatch|슈팅 스냅샷 무결성 불일치/).length).toBeGreaterThan(0); expect(container.querySelectorAll("[data-grid-segment]")).toHaveLength(17); expect(container.querySelectorAll("[data-zone-label]")).toHaveLength(0);
  });

  it("shows accessible null-metric tooltip with one roving tab stop in Perspective", () => {
    const shots = Array.from({ length: 119 }, (_, index) => ({ x: 70 + index % 30, y: index % 100, outcome: "goal" as const, xg: null, xgot: null }));
    const { container } = render(<SpatialPitch analysis={analysisWith({ shotmapSnapshotAvailable: true, shotmapPointCount: 119, shotmapPoints: shots })}/>);
    expect(container.querySelectorAll('[data-shot-marker][tabindex="0"]')).toHaveLength(1); fireEvent.focus(container.querySelector('[data-shot-marker][tabindex="0"]')!);
    expect(screen.getByRole("tooltip")).toHaveTextContent("xG —"); expect(screen.getByRole("tooltip")).toHaveTextContent("xGOT —");
  });

  it("keeps perspective shot visuals, hit targets, and tooltips pixel-sized across responsive widths", () => {
    const rendered = { width: 1000, height: 650 };
    vi.spyOn(SVGSVGElement.prototype, "getBoundingClientRect").mockImplementation(() => svgBounds(rendered.width, rendered.height));
    const resizeCallbacks: Array<() => void> = [];
    const disconnect = vi.fn();
    vi.stubGlobal("ResizeObserver", class {
      constructor(callback: ResizeObserverCallback) { resizeCallbacks.push(() => callback([], this as unknown as ResizeObserver)); }
      observe() {}
      unobserve() {}
      disconnect() { disconnect(); }
    });

    const shots = [
      { x: 82, y: 20, outcome: "goal" as const, xg: .6, xgot: .74 },
      { x: 78, y: 40, outcome: "on_target" as const },
      { x: 74, y: 60, outcome: "off_target" as const },
      { x: 70, y: 80, outcome: "blocked" as const },
    ];
    const view = render(<SpatialPitch analysis={analysisWith({ shotmapSnapshotAvailable: true, shotmapPointCount: 4, shotmapPoints: shots })}/>);
    const cssLength = (element: Element, sourceLength: number) => {
      return sourceLength * Number(element.getAttribute("data-pixel-scale")) * rendered.width / 1000;
    };
    const marker = view.container.querySelector('[data-shot-marker][data-shot-outcome="goal"]')!;
    fireEvent.focus(marker);
    const markerPosition = [marker.getAttribute("data-screen-x"), marker.getAttribute("data-screen-y")];

    const assertPixelSizes = () => {
      const markers = [...view.container.querySelectorAll("[data-shot-marker]")];
      const visuals = [...view.container.querySelectorAll("[data-marker-visual]")];
      const hits = [...view.container.querySelectorAll("[data-marker-hit]")];
      visuals.forEach((visual, index) => expect(cssLength(visual, Number(markers[index].getAttribute("data-marker-size")))).toBeCloseTo(Number(markers[index].getAttribute("data-marker-size")), 8));
      expect(hits.map((hit, index) => cssLength(visuals[index], Number(hit.getAttribute("r")) * 2))).toEqual([24, 24, 24, 24]);
      const tooltip = screen.getByRole("tooltip");
      expect(cssLength(tooltip, Number(tooltip.getAttribute("data-tooltip-width")))).toBe(150);
    };
    assertPixelSizes();
    expect(screen.getByRole("tooltip")).toHaveTextContent("득점");

    rendered.width = 320;
    rendered.height = 208;
    act(() => resizeCallbacks[0]());

    const resizedVisual = view.container.querySelector("[data-marker-visual]")!;
    expect(Number(resizedVisual.getAttribute("data-pixel-scale"))).toBeCloseTo(3.125);
    assertPixelSizes();
    expect([marker.getAttribute("data-screen-x"), marker.getAttribute("data-screen-y")]).toEqual(markerPosition);

    view.unmount();
    expect(disconnect).toHaveBeenCalledTimes(1);
  });
});
