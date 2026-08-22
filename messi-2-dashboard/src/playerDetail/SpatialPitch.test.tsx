// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { PlayerAnalysis } from "../dashboard/types";
import { POSITIONAL_DEPTH_BOUNDARIES, POSITIONAL_LANE_BOUNDARIES, projectPerspective, SpatialPitch } from "./SpatialPitch";

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
    expect(rightDefensive).toEqual({ x: 30, y: 560 });
    expect(leftDefensive).toEqual({ x: 190, y: 90 });
  });

  it("draws the exact non-uniform 6-depth by 5-lane contract and all 30 labels", () => {
    const { container } = render(<SpatialPitch analysis={analysisWith({})}/>);
    expect(container.querySelectorAll('[data-grid-axis="depth"]')).toHaveLength(POSITIONAL_DEPTH_BOUNDARIES.length);
    expect(container.querySelectorAll('[data-grid-axis="lane"]')).toHaveLength(POSITIONAL_LANE_BOUNDARIES.length);
    expect(container.querySelector('[data-grid-axis="depth"][data-boundary="16.67"]')).toBeInTheDocument();
    expect(container.querySelector('[data-grid-axis="lane"][data-boundary="21.82"]')).toBeInTheDocument();
    expect(container.querySelectorAll("[data-zone-label]")).toHaveLength(30);
  });

  it("uses one projection for populated heat and shot source coordinates", () => {
    const point = { x: 44, y: 21.82 };
    const analysis = analysisWith({ heatmapPointCount: 1, heatmapPoints: [point], shotmapSnapshotAvailable: true, shotmapPointCount: 1, shotmapPoints: [{ ...point, outcome: "goal", xg: .72, xgot: .84 }] });
    const { container } = render(<SpatialPitch analysis={analysis}/>);
    const heat = container.querySelector("[data-heat-point]"); const shot = container.querySelector("[data-shot-marker]");
    expect(heat).toHaveAttribute("data-screen-x", shot?.getAttribute("data-screen-x"));
    expect(heat).toHaveAttribute("data-screen-y", shot?.getAttribute("data-screen-y"));
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

  it("keeps a production-sized payload bounded to one heat node per point and no marker tab stops", () => {
    const heatmapPoints = Array.from({ length: 180 }, (_, index) => ({ x: index % 100, y: (index * 7) % 100 }));
    const shotmapPoints = Array.from({ length: 120 }, (_, index) => ({ x: 70 + index % 30, y: 25 + index % 50, outcome: "on_target" as const, xg: .1, xgot: .2 }));
    const { container } = render(<SpatialPitch analysis={analysisWith({ heatmapPointCount: heatmapPoints.length, heatmapPoints, shotmapSnapshotAvailable: true, shotmapPointCount: shotmapPoints.length, shotmapPoints })}/>);
    expect(container.querySelectorAll("[data-heat-point]")).toHaveLength(180);
    expect(container.querySelectorAll("[data-shot-marker]")).toHaveLength(120);
    expect(container.querySelectorAll('[data-shot-marker][tabindex="0"]')).toHaveLength(1);
    expect(within(screen.getByRole("list", { name: "Authoritative shot events" })).getAllByRole("listitem")).toHaveLength(120);
  });

  it("defaults reduced-motion users to the responsive 2D fallback and remains keyboard switchable", () => {
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
    render(<SpatialPitch analysis={analysisWith({})}/>);
    const group = screen.getByRole("group", { name: "Pitch view" });
    expect(within(group).getByRole("button", { name: "2D plan" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("img", { name: /Two-dimensional legacy spatial pitch/ })).toBeInTheDocument();
    fireEvent.click(within(group).getByRole("button", { name: "Perspective" }));
    expect(screen.getByRole("img", { name: /attacking pitch/ })).toHaveAccessibleName(/Perspective attacking pitch/);
  });

  it("shares marker visibility between Perspective and exact 2D while totals and details remain unfiltered", () => {
    const shots = [{ x: 80, y: 20, outcome: "goal" as const, xg: .4, xgot: null }, { x: 75, y: 35, outcome: "on_target" as const }, { x: 70, y: 50, outcome: "off_target" as const }, { x: 65, y: 65, outcome: "blocked" as const }];
    const { container } = render(<SpatialPitch analysis={analysisWith({ shotmapSnapshotAvailable: true, shotmapPointCount: 4, shotmapPoints: shots })}/>);
    const goals = screen.getByRole("button", { name: /Goals, 1 shots/ }); fireEvent.click(goals, { detail: 0 });
    expect(container.querySelectorAll('[data-shot-marker][data-shot-outcome="goal"]')).toHaveLength(0); expect(container.querySelectorAll("[data-shot-marker]")).toHaveLength(3);
    expect(screen.getByRole("list", { name: "Shot outcome legend" })).toHaveTextContent("Goals 1"); expect(screen.getByRole("list", { name: "Authoritative shot events" }).children).toHaveLength(4);
    fireEvent.click(screen.getByRole("button", { name: "2D plan" }));
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
    expect(screen.getAllByText(/Shot snapshot integrity mismatch/).length).toBeGreaterThan(0); expect(container.querySelectorAll('[data-grid-axis="depth"]')).toHaveLength(POSITIONAL_DEPTH_BOUNDARIES.length); expect(container.querySelectorAll("[data-zone-label]")).toHaveLength(30);
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
    const marker = view.container.querySelector("[data-shot-marker]")!;
    fireEvent.focus(marker);
    const initialAnchor = view.container.querySelector("[data-shot-anchor]")!;
    const initialShadow = view.container.querySelector("[data-shot-shadow]")!;
    const anchorPosition = [initialAnchor.getAttribute("x1"), initialAnchor.getAttribute("y1")];
    const shadowPosition = [initialShadow.getAttribute("cx"), initialShadow.getAttribute("cy")];

    const assertPixelSizes = () => {
      const markers = [...view.container.querySelectorAll("[data-shot-marker]")];
      const visuals = [...view.container.querySelectorAll("[data-marker-visual]")];
      const hits = [...view.container.querySelectorAll("[data-marker-hit]")];
      expect(visuals.map((visual, index) => cssLength(visual, Number(markers[index].getAttribute("data-marker-size"))))).toEqual([12, 9, 9, 8]);
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
