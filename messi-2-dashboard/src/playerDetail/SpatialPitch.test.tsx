// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
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

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

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
    expect(shot).toHaveAttribute("aria-hidden", "true");
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
    expect(container.querySelectorAll("[data-shot-marker][tabindex]")).toHaveLength(0);
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
});
