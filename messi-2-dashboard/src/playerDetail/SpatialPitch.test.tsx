// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { PlayerAnalysis } from "../dashboard/types";
import { ATTACKING_GOAL_FRAME_LIFT, GOAL_CROSSBAR_HEIGHT_METERS, GOAL_POST_Y, GOAL_WIDTH_METERS, LEGACY_POSITIONAL_SEGMENTS, PITCH_WIDTH_METERS, POSITIONAL_DEPTH_BOUNDARIES, POSITIONAL_LANE_BOUNDARIES, projectPerspective, SIX_YARD_BOX_Y, SpatialPitch } from "./SpatialPitch";
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
    expect(rightDefensive).toEqual({ x: 20, y: 585 });
    expect(leftDefensive).toEqual({ x: 205, y: 235 });
    expect(rightDefensive.y - leftDefensive.y).toBe(350);
  });

  it("projects the legacy asset's segmented positional geometry without zone labels", () => {
    const { container } = render(<SpatialPitch analysis={analysisWith({})}/>);
    const segments = [...container.querySelectorAll("[data-grid-segment]")];
    expect(segments).toHaveLength(LEGACY_POSITIONAL_SEGMENTS.length);
    expect(segments.map((segment) => ({ axis: segment.getAttribute("data-grid-axis"), boundary: Number(segment.getAttribute("data-boundary")), start: segment.getAttribute("data-start"), end: segment.getAttribute("data-end") }))).toEqual(LEGACY_POSITIONAL_SEGMENTS.map((segment) => ({ axis: segment.axis, boundary: segment.boundary, start: `${segment.start.x},${segment.start.y}`, end: `${segment.end.x},${segment.end.y}` })));
    expect(container.querySelector('[data-grid-axis="lane"][data-boundary="37"]')).toHaveAttribute("data-start", "16.67,37");
    expect(container.querySelector('[data-grid-axis="lane"][data-boundary="37"]')).toHaveAttribute("data-end", "83.33,37");
    expect(container.querySelectorAll('[data-grid-axis="depth"][data-boundary="33.33"]')).toHaveLength(2);
    expect(container.querySelectorAll("[data-zone-label], [data-zone-key]")).toHaveLength(0);
    expect(screen.queryByText(/D1|L1/)).not.toBeInTheDocument();
    expect(new Set(LEGACY_POSITIONAL_SEGMENTS.filter(({ axis }) => axis === "depth").map(({ boundary }) => boundary))).toEqual(new Set(POSITIONAL_DEPTH_BOUNDARIES));
    expect(new Set(LEGACY_POSITIONAL_SEGMENTS.filter(({ axis }) => axis === "lane").map(({ boundary }) => boundary))).toEqual(new Set(POSITIONAL_LANE_BOUNDARIES));
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
    expect(attackingGoal).toHaveAttribute("data-goal-frame-lift", String(ATTACKING_GOAL_FRAME_LIFT));
    expect(attackingGoal).toHaveAttribute("data-goal-crossbar-height-meters", String(GOAL_CROSSBAR_HEIGHT_METERS));
    expect(paths).toHaveLength(heightCases.length);
    for (const [index, path] of paths.entries()) {
      const lift = Number(path.getAttribute("data-end-height-lift"));
      const groundY = Number(path.getAttribute("data-end-ground-y"));
      const renderY = Number(path.getAttribute("data-end-render-y"));
      expect(lift).toBeCloseTo(ATTACKING_GOAL_FRAME_LIFT * heightCases[index] / GOAL_CROSSBAR_HEIGHT_METERS, 10);
      expect(groundY - renderY).toBeCloseTo(lift, 10);
    }
    expect(Number(paths[0].getAttribute("data-end-render-y"))).toBe(Number(paths[0].getAttribute("data-end-ground-y")));
    expect(Number(paths[1].getAttribute("data-end-height-lift"))).toBeLessThan(ATTACKING_GOAL_FRAME_LIFT);
    expect(Number(paths[2].getAttribute("data-end-height-lift"))).toBeCloseTo(ATTACKING_GOAL_FRAME_LIFT, 10);
    expect(Number(paths[3].getAttribute("data-end-height-lift"))).toBeGreaterThan(ATTACKING_GOAL_FRAME_LIFT);
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
    const frameLift = Number(container.querySelector('[data-goal="attacking"]')?.getAttribute("data-goal-frame-lift"));
    const desktop = { markerScale: Number(marker.getAttribute("data-pixel-scale")), endpointY: path.getAttribute("data-end-render-y"), endpointLift: Number(path.getAttribute("data-end-height-lift")) };

    rendered.width = 320;
    rendered.height = 208;
    act(() => resizeCallbacks[0]());

    expect(Number(marker.getAttribute("data-pixel-scale"))).toBeCloseTo(3.125);
    expect(path).toHaveAttribute("data-end-render-y", desktop.endpointY);
    expect(Number(path.getAttribute("data-end-height-lift"))).toBeCloseTo(desktop.endpointLift, 10);
    expect(desktop.endpointLift / frameLift).toBeCloseTo(1.2 / GOAL_CROSSBAR_HEIGHT_METERS, 10);
  });

  it("keeps unknown-height goal-mouth endpoints on the source ground coordinate and shows whether the source y is in the mouth", () => {
    const shots = [
      { x: 80, y: 20, outcome: "goal" as const, trajectory: { schemaVersion: "shotmap-trajectory-v1" as const, endpointKind: "goal_mouth" as const, endX: 100, endY: 50, endZMeters: null, source: "fotmob" as const } },
      { x: 78, y: 22, outcome: "on_target" as const, trajectory: { schemaVersion: "shotmap-trajectory-v1" as const, endpointKind: "goal_mouth" as const, endX: 100, endY: 40, endZMeters: 1.2, source: "fotmob" as const } },
    ];
    const { container } = render(<SpatialPitch analysis={analysisWith({ shotmapSnapshotAvailable: true, shotmapPointCount: shots.length, shotmapPoints: shots })}/>);
    const unknownHeight = container.querySelector('[data-trajectory-kind="goal_mouth"][data-end-pitch-y="50"]')!;
    const outsideMouth = container.querySelector('[data-trajectory-kind="goal_mouth"][data-end-pitch-y="40"]')!;
    expect(unknownHeight).toHaveAttribute("data-end-height-lift", "0");
    expect(unknownHeight).toHaveAttribute("data-end-render-y", unknownHeight.getAttribute("data-end-ground-y"));
    expect(unknownHeight).toHaveAttribute("data-end-goal-mouth", "inside");
    expect(outsideMouth).toHaveAttribute("data-end-goal-mouth", "outside");
  });

  it("projects only authoritative goal-mouth trajectories and never invents blocked goal-line paths", () => {
    const shots = [
      { x: 80, y: 20, outcome: "goal" as const, trajectory: { schemaVersion: "shotmap-trajectory-v1" as const, endpointKind: "goal_mouth" as const, endX: 100, endY: 52, endZMeters: 1.2, source: "fotmob" as const } },
      { x: 70, y: 60, outcome: "blocked" as const, trajectory: { schemaVersion: "shotmap-trajectory-v1" as const, endpointKind: "blocked" as const, endX: 78, endY: 56, endZMeters: null, source: "fotmob" as const } },
      { x: 75, y: 40, outcome: "off_target" as const, trajectory: null },
    ];
    const { container } = render(<SpatialPitch analysis={analysisWith({ shotmapSnapshotAvailable: true, shotmapPointCount: shots.length, shotmapPoints: shots })}/>);
    const paths = [...container.querySelectorAll("[data-shot-trajectory]")];
    expect(paths).toHaveLength(1);
    const goalPath = container.querySelector('[data-trajectory-kind="goal_mouth"]')!;
    const goalGround = projectPerspective({ x: 100, y: 52 });
    expect(goalPath).toHaveAttribute("data-end-ground-x", String(goalGround.x));
    expect(goalPath).toHaveAttribute("data-end-ground-y", String(goalGround.y));
    expect(Number(goalPath.getAttribute("data-end-render-y"))).toBeLessThan(goalGround.y);
    expect(container.querySelector('[data-trajectory-kind="blocked"]')).not.toBeInTheDocument();
    expect(container.querySelector('[data-shot-marker][data-shot-outcome="goal"]')).toHaveAccessibleName(/Goal-mouth trajectory to 100\.0, 52\.0, height 1\.20 metres/);
    expect(screen.getByRole("list", { name: "Authoritative shot events" })).toHaveTextContent(/blocked trajectory to \(78\.0, 56\.0\)/);
  });

  it("filters matching trajectory paths and keeps the exact 2D fallback marker-only", () => {
    const shots = [
      { x: 80, y: 20, outcome: "goal" as const, trajectory: { schemaVersion: "shotmap-trajectory-v1" as const, endpointKind: "goal_mouth" as const, endX: 100, endY: 52, endZMeters: 1.2, source: "fotmob" as const } },
      { x: 70, y: 60, outcome: "blocked" as const, trajectory: { schemaVersion: "shotmap-trajectory-v1" as const, endpointKind: "blocked" as const, endX: 78, endY: 56, endZMeters: null, source: "fotmob" as const } },
    ];
    const { container } = render(<SpatialPitch analysis={analysisWith({ shotmapSnapshotAvailable: true, shotmapPointCount: shots.length, shotmapPoints: shots })}/>);
    fireEvent.click(screen.getByRole("button", { name: /Goals, 1 shots/ }), { detail: 0 });
    expect(container.querySelector('[data-trajectory-kind="goal_mouth"]')).not.toBeInTheDocument();
    expect(container.querySelector('[data-trajectory-kind="blocked"]')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "어떻게 움직이나" }));
    expect(container.querySelector("[data-shot-trajectory]")).not.toBeInTheDocument();
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
    expect(heat.closest("[data-layer=heat]")).not.toHaveAttribute("style");
    expect(shot).toHaveAttribute("data-screen-x", String(projectPerspective(point).x));
    expect(shot).toHaveAttribute("data-screen-y", String(projectPerspective(point).y));
    expect(shot).toHaveAttribute("data-marker-symbol", "star");
    expect(shot).toHaveAttribute("tabindex", "0");
    expect(screen.getByRole("list", { name: "Authoritative shot events" })).toHaveTextContent(/Goal · xG 0.72 · xGOT 0.84/);
    expect(screen.getByText(/1 activity points\. 1 shots\./)).toBeInTheDocument();
  });

  it("keeps unavailable snapshots distinct from available verified zero", () => {
    const { rerender } = render(<SpatialPitch analysis={analysisWith({ available: false })}/>);
    expect(screen.getAllByText(/Activity heatmap unavailable/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Shot snapshot unavailable/).length).toBeGreaterThan(0);
    expect(screen.queryByText("◇ Goals 0")).not.toBeInTheDocument();
    rerender(<SpatialPitch analysis={analysisWith({ available: true, shotmapSnapshotAvailable: true })}/>);
    expect(screen.getAllByText(/Verified zero activity points/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Verified zero shots/).length).toBeGreaterThan(0);
    expect(screen.getByText("◇ Goals 0")).toBeInTheDocument();
  });

  it("keeps a production-sized payload bounded to the density mesh while panning does not rebuild it", () => {
    const heatmapPoints = Array.from({ length: 2000 }, (_, index) => ({ x: index % 100, y: (index * 7) % 100 }));
    const shotmapPoints = Array.from({ length: 150 }, (_, index) => ({ x: 70 + index % 30, y: 25 + index % 50, outcome: "on_target" as const, xg: .1, xgot: .2 }));
    const { container } = render(<SpatialPitch analysis={analysisWith({ heatmapPointCount: heatmapPoints.length, heatmapPoints, shotmapSnapshotAvailable: true, shotmapPointCount: shotmapPoints.length, shotmapPoints })}/>);
    const before = [...container.querySelectorAll("[data-density-cell]")];
    const heatLayer = container.querySelector("[data-layer=heat]")!;
    const meshBuilds = heatLayer.getAttribute("data-density-mesh-builds");
    expect(before).toHaveLength(DISPLAY_HEATMAP_ROWS * DISPLAY_HEATMAP_COLUMNS);
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    const viewport = container.querySelector("svg[role=img]")!;
    fireEvent.keyDown(viewport, { key: "ArrowRight" });
    expect([...container.querySelectorAll("[data-density-cell]")]).toEqual(before);
    expect(heatLayer).toHaveAttribute("data-density-mesh-builds", meshBuilds);
    expect(container.querySelectorAll("[data-shot-marker]")).toHaveLength(150);
    expect(container.querySelectorAll('[data-shot-marker][tabindex="0"]')).toHaveLength(1);
    expect(within(screen.getByRole("list", { name: "Authoritative shot events" })).getAllByRole("listitem")).toHaveLength(150);
  });

  it("fails closed for unavailable, mismatched, and invalid heatmap coordinates", () => {
    const { container, rerender } = render(<SpatialPitch analysis={analysisWith({ available: false })}/>);
    expect(container.querySelectorAll("[data-density-cell]")).toHaveLength(DISPLAY_HEATMAP_ROWS * DISPLAY_HEATMAP_COLUMNS);
    expect([...container.querySelectorAll("[data-density-cell]")].every((cell) => cell.getAttribute("data-density-normalized") === "0")).toBe(true);
    rerender(<SpatialPitch analysis={analysisWith({ heatmapPointCount: 2, heatmapPoints: [{ x: 50, y: 50 }] })}/>);
    expect(screen.getAllByText(/Activity heatmap integrity mismatch/).length).toBeGreaterThan(0);
    expect([...container.querySelectorAll("[data-density-cell]")].every((cell) => cell.getAttribute("data-density-normalized") === "0")).toBe(true);
    rerender(<SpatialPitch analysis={analysisWith({ heatmapPointCount: 1, heatmapPoints: [{ x: 101, y: 50 }] })}/>);
    expect([...container.querySelectorAll("[data-density-cell]")].every((cell) => cell.getAttribute("data-density-normalized") === "0")).toBe(true);
  });

  it("controls exact Perspective viewBoxes and resets pan on escape, context, and view transitions", () => {
    vi.spyOn(SVGSVGElement.prototype, "getBoundingClientRect").mockImplementation(() => svgBounds(1000, 650));
    const analysis = analysisWith({ heatmapPointCount: 1, heatmapPoints: [{ x: 50, y: 50 }], shotmapSnapshotAvailable: true, shotmapPointCount: 1, shotmapPoints: [{ x: 80, y: 50, outcome: "goal" }] });
    const { container, rerender } = render(<SpatialPitch analysis={analysis} contextIdentity="one"/>);
    const viewport = () => container.querySelector("svg[role=img]")!;
    expect(viewport()).toHaveAttribute("viewBox", "0 0 1000 650");
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(viewport()).toHaveAttribute("viewBox", "250 162.5 500 325");
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(viewport()).toHaveAttribute("viewBox", "333.33333333333337 216.66666666666669 333.3333333333333 216.66666666666666");
    expect(screen.getByRole("button", { name: "Zoom in" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Zoom out" }));
    expect(viewport()).toHaveAttribute("viewBox", "250 162.5 500 325");
    const densityCell = container.querySelector("[data-density-cell]")!;
    fireEvent.pointerDown(densityCell, { pointerId: 1, clientX: 500, clientY: 325 });
    fireEvent.pointerMove(viewport(), { pointerId: 1, clientX: 0, clientY: 0 });
    expect(viewport()).toHaveAttribute("viewBox", "500 325 500 325");
    fireEvent.pointerCancel(viewport(), { pointerId: 1 });
    fireEvent.pointerMove(viewport(), { pointerId: 1, clientX: 500, clientY: 325 });
    expect(viewport()).toHaveAttribute("viewBox", "500 325 500 325");
    fireEvent.keyDown(viewport(), { key: "Escape" });
    expect(viewport()).toHaveAttribute("viewBox", "0 0 1000 650");
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    const marker = container.querySelector("[data-shot-marker]")!;
    fireEvent.pointerDown(marker, { pointerId: 2, clientX: 500, clientY: 325 });
    fireEvent.pointerMove(viewport(), { pointerId: 2, clientX: 0, clientY: 0 });
    expect(viewport()).toHaveAttribute("viewBox", "250 162.5 500 325");
    fireEvent.keyDown(marker, { key: "Escape" });
    expect(viewport()).toHaveAttribute("viewBox", "0 0 1000 650");
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    fireEvent.click(screen.getByRole("button", { name: "어떻게 움직이나" }));
    fireEvent.click(screen.getByRole("button", { name: "어디서 쏘고 어디로 꽂나" }));
    expect(viewport()).toHaveAttribute("viewBox", "0 0 1000 650");
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    rerender(<SpatialPitch analysis={analysis} contextIdentity="two"/>);
    expect(viewport()).toHaveAttribute("viewBox", "0 0 1000 650");
  });

  it("defaults reduced-motion users to the responsive 2D fallback and remains keyboard switchable", () => {
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
    render(<SpatialPitch analysis={analysisWith({})}/>);
    const group = screen.getByRole("group", { name: "Pitch view" });
    expect(within(group).getByRole("button", { name: "어떻게 움직이나" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("img", { name: /Two-dimensional legacy spatial pitch/ })).toBeInTheDocument();
    fireEvent.click(within(group).getByRole("button", { name: "어디서 쏘고 어디로 꽂나" }));
    expect(screen.getByRole("img", { name: /attacking pitch/ })).toHaveAccessibleName(/Perspective attacking pitch/);
  });

  it("shares marker visibility between Perspective and exact 2D while totals and details remain unfiltered", () => {
    const shots = [{ x: 80, y: 20, outcome: "goal" as const, xg: .4, xgot: null }, { x: 75, y: 35, outcome: "on_target" as const }, { x: 70, y: 50, outcome: "off_target" as const }, { x: 65, y: 65, outcome: "blocked" as const }];
    const { container } = render(<SpatialPitch analysis={analysisWith({ shotmapSnapshotAvailable: true, shotmapPointCount: 4, shotmapPoints: shots })}/>);
    const goals = screen.getByRole("button", { name: /Goals, 1 shots/ }); fireEvent.click(goals, { detail: 0 });
    expect(container.querySelectorAll('[data-shot-marker][data-shot-outcome="goal"]')).toHaveLength(0); expect(container.querySelectorAll("[data-shot-marker]")).toHaveLength(3);
    expect(screen.getByRole("list", { name: "Shot outcome legend" })).toHaveTextContent("Goals 1"); expect(screen.getByRole("list", { name: "Authoritative shot events" }).children).toHaveLength(4);
    fireEvent.click(screen.getByRole("button", { name: "어떻게 움직이나" }));
    expect(screen.getByRole("img", { name: /Two-dimensional legacy spatial pitch/ })).toHaveAccessibleName(/Visible shot outcomes: On target, Off target, Blocked/);
    expect(container.querySelectorAll('[data-layer="legacy-events"] [data-shot-outcome="goal"]')).toHaveLength(0); expect(container.querySelectorAll('[data-layer="legacy-events"] [data-shot-index]')).toHaveLength(3);
    expect(screen.getByText(/Goal ◇ · on target ● · off target × · blocked ■/, { selector: "figcaption" })).toBeInTheDocument();
    fireEvent.click(goals, { detail: 0 }); expect(container.querySelectorAll('[data-layer="legacy-events"] [data-shot-index]')).toHaveLength(4);
  });

  it("handles click races, same-outcome doubles, keyboard activation, and context reset", () => {
    vi.useFakeTimers();
    const shots = [{ x: 80, y: 20, outcome: "goal" as const }, { x: 75, y: 35, outcome: "on_target" as const }, { x: 70, y: 50, outcome: "off_target" as const }, { x: 65, y: 65, outcome: "blocked" as const }];
    const populated = analysisWith({ shotmapSnapshotAvailable: true, shotmapPointCount: 4, shotmapPoints: shots });
    const { container, rerender } = render(<SpatialPitch analysis={populated} contextIdentity="one"/>);
    const goals = screen.getByRole("button", { name: /Goals, 1 shots/ }), onTarget = screen.getByRole("button", { name: /On target, 1 shots/ });
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
    expect(screen.getAllByText(/Shot snapshot integrity mismatch/).length).toBeGreaterThan(0); expect(container.querySelectorAll("[data-grid-segment]")).toHaveLength(LEGACY_POSITIONAL_SEGMENTS.length); expect(container.querySelectorAll("[data-zone-label]")).toHaveLength(0);
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
    const initialAnchor = view.container.querySelector("[data-shot-anchor]")!;
    const initialShadow = view.container.querySelector("[data-shot-shadow]")!;
    const anchorPosition = [initialAnchor.getAttribute("x1"), initialAnchor.getAttribute("y1")];
    const shadowPosition = [initialShadow.getAttribute("cx"), initialShadow.getAttribute("cy")];

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
    expect(screen.getByRole("tooltip")).toHaveTextContent("Goal");

    rendered.width = 320;
    rendered.height = 208;
    act(() => resizeCallbacks[0]());

    const resizedVisual = view.container.querySelector("[data-marker-visual]")!;
    expect(Number(resizedVisual.getAttribute("data-pixel-scale"))).toBeCloseTo(3.125);
    assertPixelSizes();
    expect([initialAnchor.getAttribute("x1"), initialAnchor.getAttribute("y1")]).toEqual(anchorPosition);
    expect([initialShadow.getAttribute("cx"), initialShadow.getAttribute("cy")]).toEqual(shadowPosition);

    view.unmount();
    expect(disconnect).toHaveBeenCalledTimes(1);
  });
});
