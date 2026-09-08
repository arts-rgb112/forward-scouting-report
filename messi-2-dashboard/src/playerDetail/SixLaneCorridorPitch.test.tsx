// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PitchPenaltyProvider, PitchPenaltyToggle } from "./PitchPenaltyContext";
import { corridorContourPath, clusterCorridorShotGroups, corridorClientPointForPitchPercent, CORRIDOR_CLUSTER_DISTANCE, CORRIDOR_MARKER_RADIUS, CORRIDOR_VIEW_BOX, SixLaneCorridorPitch } from "./SixLaneCorridorPitch";
import { legacyDensityGrid, normalizeDensity, marchingSquares } from './legacyHeatmap';
import { groupPitchShots } from "./PitchShotMarker";
import { DEFAULT_PITCH_LAYERS } from "./pitchLayers";
import { boxSubregionEnvelopeSchema } from "../api/boxSubregionContracts";
import type { BoxSubregionStatsState } from "./useBoxSubregionStats";

// import.meta.url does not resolve to a real filesystem path under jsdom.
const boxFixture = boxSubregionEnvelopeSchema.parse(JSON.parse(readFileSync(
  resolve(import.meta.dirname, "../../../../messi-specs/fixtures/box-subregion-kane-2025-2026-league8.json"),
  "utf-8",
)));

/** Clicks the SVG at an exact pitch-percent (x,y), using the component's own
 * exported forward transform (not a hand-rederived copy of it) to place the
 * synthetic clientX/clientY — so boundary tests exercise the real click
 * handler's real inverse math, including the viewBox/letterbox correction,
 * rather than a square-bbox shortcut that happened to agree with the old
 * (buggy) linear mapping. `rect` need not be square — that was exactly what
 * let the old naive mapping's bug go unnoticed. */
function clickAtPitchPercent(svg: SVGSVGElement, x: number, y: number, rect = { left: 0, top: 0, width: 840, height: 480, right: 840, bottom: 480 }) {
  Object.defineProperty(svg, "getBoundingClientRect", { configurable: true, value: () => rect });
  const { clientX, clientY } = corridorClientPointForPitchPercent(rect, x, y);
  fireEvent.click(svg, { clientX, clientY });
}

const analysis = {
  spatial: {
    available: true,
    heatmapPointCount: 3,
    heatmapPoints: [{ x: 80, y: 40 }, { x: 81, y: 42 }, { x: 82, y: 44 }],
    shotmapSnapshotAvailable: true,
    shotmapPointCount: 4,
    shotmapPoints: [
      { x: 80, y: 40, outcome: "goal", xg: .4, xgot: .6 },
      { x: 80, y: 40, outcome: "on_target", xg: .4, xgot: .6 },
      { x: 89.524, y: 50, outcome: "goal", xg: .79, xgot: .8 },
      { x: 71.049, y: 50, outcome: "off_target", xg: .02, xgot: null },
    ],
    continuousCore: { available: false },
  },
} as never;

describe("SixLaneCorridorPitch", () => {
  it('shrinks only the PK spot and guide, preserving their location', () => {
    const { container } = render(<PitchPenaltyProvider><SixLaneCorridorPitch analysis={analysis} layers={DEFAULT_PITCH_LAYERS} /></PitchPenaltyProvider>);
    expect(container.querySelector('[data-penalty-spot]')).toHaveAttribute('r', '.3');
    expect(container.querySelector('[data-penalty-guide]')).toHaveAttribute('r', '1.2');
    for (const circle of container.querySelectorAll('[data-penalty-spot],[data-penalty-guide]')) {
      expect(circle).toHaveAttribute('cx', '93.999'); expect(circle).toHaveAttribute('cy', '34');
    }
  });
  it('does not mirror screen-space CCA a second time', () => {
    for (const sourceY of [20, 80]) {
      const segments = marchingSquares(normalizeDensity(legacyDensityGrid([{x:80,y:sourceY}])), .5);
      expect(segments.length).toBeGreaterThan(0);
      const coordinates = [...corridorContourPath(segments).matchAll(/[ML]([\d.]+) ([\d.]+)/g)];
      const meanY = coordinates.reduce((sum, point) => sum + Number(point[2]), 0) / coordinates.length;
      expect(meanY).toBeCloseTo((100-sourceY)*.68, 0);
    }
  });
  it("uses the approved result-specific marker radii without resizing the pitch", () => {
    expect(CORRIDOR_MARKER_RADIUS).toEqual({ goal: .72, on_target: .56, off_target: .5, blocked: .5 });
  });

  it("matches the approved result colors, opacity, and outline widths", () => {
    const outcomeAnalysis = {
      spatial: {
        available: true,
        heatmapPointCount: 0,
        heatmapPoints: [],
        shotmapSnapshotAvailable: true,
        shotmapPointCount: 4,
        shotmapPoints: [
          { x: 70, y: 20, outcome: "goal", xg: .2, xgot: .3 },
          { x: 78, y: 35, outcome: "on_target", xg: .2, xgot: .2 },
          { x: 86, y: 55, outcome: "blocked", xg: .1, xgot: null },
          { x: 94, y: 75, outcome: "off_target", xg: .1, xgot: null },
        ],
        continuousCore: { available: false },
      },
    } as never;
    const { container } = render(<PitchPenaltyProvider><SixLaneCorridorPitch analysis={outcomeAnalysis} layers={DEFAULT_PITCH_LAYERS}/></PitchPenaltyProvider>);
    const svg = within(container.querySelector('[data-layout="six-lane-corridor-pitch"]')!).getByRole("img");
    const marker = (outcome: string) => within(svg).getByRole("button", { name: `${outcome} 슛 상세` }).querySelector("[data-marker-radius]")!;
    expect(marker("goal")).toHaveAttribute("r", "0.72");
    expect(marker("goal")).toHaveAttribute("fill", "#BEF264");
    expect(marker("goal")).toHaveAttribute("stroke", "#0A1F10");
    expect(marker("goal")).toHaveAttribute("stroke-width", "1.2");
    expect(marker("on_target")).toHaveAttribute("r", "0.56");
    expect(marker("on_target")).toHaveAttribute("fill", "#38BDF8");
    expect(marker("on_target")).toHaveAttribute("stroke-width", "1");
    expect(marker("blocked")).toHaveAttribute("r", "0.5");
    expect(marker("blocked")).toHaveAttribute("stroke", "#E2E8F0");
    expect(marker("blocked")).toHaveAttribute("stroke-opacity", ".6");
    expect(marker("off_target")).toHaveAttribute("data-marker-radius", "0.5");
    expect(marker("off_target")).toHaveAttribute("stroke", "#94A3B8");
    expect(marker("off_target")).toHaveAttribute("stroke-opacity", ".55");
  });

  it("does not merge nearby but distinct source coordinates", () => {
    const shots = [
      { x: 80, y: 40, outcome: "goal" as const, xg: .4 },
      { x: 80.5, y: 40.2, outcome: "on_target" as const, xg: .3 },
      { x: 81, y: 40.4, outcome: "off_target" as const, xg: .1 },
      { x: 90, y: 70, outcome: "blocked" as const, xg: .1 },
    ];
    const clusters = clusterCorridorShotGroups(groupPitchShots(shots.map((shot, sourceIndex) => ({ shot, sourceIndex }))), shots);
    expect(CORRIDOR_CLUSTER_DISTANCE).toBe(0);
    expect(clusters).toHaveLength(4);
    expect(clusters.map((cluster) => cluster.count)).toEqual([1, 1, 1, 1]);
    expect(clusters.flatMap((cluster) => cluster.sourceIndexes).sort((left, right) => left - right)).toEqual([0, 1, 2, 3]);
  });

  it("draws an explicit outline-only focus ring behind the marker instead of relying on the browser's default (oversized) auto ring", () => {
    const { container, unmount } = render(<PitchPenaltyProvider><PitchPenaltyToggle/><SixLaneCorridorPitch analysis={analysis} layers={DEFAULT_PITCH_LAYERS}/></PitchPenaltyProvider>);
    const corridor = container.querySelector('[data-layout="six-lane-corridor-pitch"]')!;
    const svg = within(corridor).getByRole("img");
    const stack = within(svg).getByRole("button", { name: /묶음 2발/ });
    expect(stack).toHaveClass("corridor-shot-target");
    const ring = stack.querySelector(".corridor-focus-ring")!;
    expect(ring).toBeInTheDocument();
    expect(ring).toHaveAttribute("fill", "none"); // outline-only — can never paint over the ×N count
    // Painted before the marker circle and the ×N stack badge, so it sits behind them.
    expect(Array.from(stack.children).indexOf(ring)).toBe(0);
    expect(Array.from(stack.children).indexOf(stack.querySelector("[data-corridor-shot-stack]")!)).toBeGreaterThan(0);
    unmount(); // this suite's other tests use bare (unscoped) screen.* queries
  });

  it("keeps the field clear, uses simple result markers, and shares the PK state", () => {
    const { container } = render(<PitchPenaltyProvider><PitchPenaltyToggle/><SixLaneCorridorPitch analysis={analysis} layers={DEFAULT_PITCH_LAYERS}/></PitchPenaltyProvider>);
    const corridor = container.querySelector('[data-layout="six-lane-corridor-pitch"]')!;
    const svg = within(corridor).getByRole("img");
    expect(svg.querySelectorAll("text")).toHaveLength(1);
    expect(svg.querySelector("[data-corridor-shot-stack] text")).toHaveTextContent("×2");
    expect(svg.querySelectorAll("[data-lane]")).toHaveLength(6);
    expect(svg.querySelector('[data-layer="positional-grid"]')).not.toBeNull();
    expect(svg.querySelector('[data-layer="pk-axis"]')).toBeNull();
    expect(svg.querySelectorAll('[data-pitch-shot-marker]')).toHaveLength(0);
    expect(within(svg).getAllByRole("button", { name: /슛 상세/ })).toHaveLength(3);
    const stack = within(svg).getByRole("button", { name: /묶음 2발.*득점 1.*유효 1/ });
    expect(stack).toHaveAttribute("data-corridor-shot-count", "2");
    expect(stack.querySelector("[data-corridor-shot-stack]")).toHaveTextContent("×2");
    expect(stack.querySelector("[data-corridor-shot-stack]")?.getAttribute("transform")).toContain("scale(.5)");
    fireEvent.click(screen.getByRole("button", { name: "페널티 제외" }));
    expect(within(svg).getAllByRole("button", { name: /슛 상세/ })).toHaveLength(2);
    fireEvent.click(within(svg).getByRole("button", { name: /goal 슛 상세, 묶음 2발/ }));
    expect(within(corridor).getByLabelText("슈팅 상세")).toHaveTextContent("xG 0.40");
    expect(within(corridor).getByRole("list", { name: "묶음 슈팅 이벤트" })).toHaveTextContent("#2 · on_target");
    fireEvent.click(within(corridor).getByRole("button", { name: "확대" }));
    expect(within(corridor).getByText("1.2배")).toBeInTheDocument();
    Object.defineProperty(corridor.querySelector('[data-zoom-pan]')!.parentElement!, "getBoundingClientRect", { value: () => ({ width: 300, height: 190 }) });
    fireEvent.pointerDown(svg, { pointerId: 1, clientX: 50, clientY: 50 });
    fireEvent.pointerMove(svg, { pointerId: 1, clientX: 70, clientY: 60 });
    fireEvent.pointerUp(svg, { pointerId: 1 });
    expect(corridor.querySelector('[data-zoom-pan]')).toHaveStyle({ transform: "translate(20px, 10px) scale(1.2)" });
  });

  it("resolves the exact server box region by real half-open bounds, not the generic 6-lane depth grid", () => {
    const boxSubregion: BoxSubregionStatsState = { kind: "ready", key: "k", data: boxFixture };
    const { container } = render(<SixLaneCorridorPitch analysis={analysis} layers={DEFAULT_PITCH_LAYERS} boxSubregion={boxSubregion} />);
    const svg = container.querySelector("svg")!;
    // x=84.28 is just outside the box's xMinInclusive=84.29 — must fall back
    // to the legacy generic lane/depth label, never a box region.
    clickAtPitchPercent(svg, 84.28, 50);
    expect(within(container).getByLabelText("선택 구역 정보")).not.toHaveAttribute("data-corridor-box-zone");
    expect(container.textContent).toContain("깊이");
    // x=84.29, y=63 sits exactly on the L4/L3L boundary — half-open means 63 resolves to L4.
    clickAtPitchPercent(svg, 84.29, 63);
    expect(container.querySelector("[data-corridor-box-zone='L4']")).toBeInTheDocument();
    expect(container.querySelector("[data-corridor-box-zone='L4']")).toHaveTextContent("슛 9 · 득점 2 · xG 0.33");
    // y=50 sits exactly on the L3R/L3L boundary — half-open means 50 resolves to L3L, not L3R.
    clickAtPitchPercent(svg, 84.29, 50);
    expect(container.querySelector("[data-corridor-box-zone='L3L']")).toBeInTheDocument();
    expect(container.querySelector("[data-corridor-box-zone='L3L']")).toHaveTextContent("슛 31 · 득점 7");
    // y=36.99 sits just under the L2/L3R boundary at 37 — resolves to L2, not L3R.
    clickAtPitchPercent(svg, 84.29, 36.99);
    expect(container.querySelector("[data-corridor-box-zone='L2']")).toBeInTheDocument();
    expect(container.querySelector("[data-corridor-box-zone='L2']")).toHaveTextContent("슛 11 · 득점 0");
    // y=37 exactly resolves to L3R (half-open upper bound of L2, inclusive
    // lower bound of L3R). The click round-trips through the full letterbox
    // transform and its inverse, which can land a hair off an exact literal
    // boundary — resolveBoxSubregionId snaps to 1e-6 precision specifically
    // so this exact value still resolves correctly rather than needing a
    // deliberately-nudged input to dodge float noise.
    clickAtPitchPercent(svg, 84.29, 37);
    expect(container.querySelector("[data-corridor-box-zone='L3R']")).toBeInTheDocument();
    expect(container.querySelector("[data-corridor-box-zone='L3R']")).toHaveTextContent("슛 33 · 득점 11");
  });

  it("maps a real (non-square) letterboxed rect back to the exact pitch percent it was hand-computed for — proof independent of the component's own inverse", () => {
    // Hand-derived, not reusing corridorClientPointForPitchPercent: viewBox
    // is 109×72 (aspect ≈1.514), the rect below is 900×500 (aspect 1.8) —
    // wider than the viewBox, so xMidYMid meet is height-constrained
    // (scale=500/72≈6.9444) and letterboxes left/right, NOT top/bottom.
    const rect = { left: 10, top: 20, width: 900, height: 500, right: 910, bottom: 520 };
    // meet picks the smaller of the two axis scales so the whole viewBox fits:
    // 900/109≈8.257 vs 500/72≈6.944 — height is the binding constraint.
    const scale = 500 / 72;
    const offsetX = (900 - 109 * scale) / 2; // content narrower than element on this axis → letterboxed left/right
    const offsetY = (500 - 72 * scale) / 2; // ≈ 0 — height exactly fills the element
    // Pitch centre (52.5, 34) → local svg point (55.125, 23.12) via world().
    const localX = 52.5 * 1.05, localY = (100 - 34) * .68;
    const clientX = rect.left + offsetX + (localX - CORRIDOR_VIEW_BOX.x) * scale;
    const clientY = rect.top + offsetY + (localY - CORRIDOR_VIEW_BOX.y) * scale;
    const boxSubregion: BoxSubregionStatsState = { kind: "ready", key: "k", data: boxFixture };
    const { container } = render(<SixLaneCorridorPitch analysis={analysis} layers={DEFAULT_PITCH_LAYERS} boxSubregion={boxSubregion} />);
    const svg = container.querySelector("svg")!;
    Object.defineProperty(svg, "getBoundingClientRect", { configurable: true, value: () => rect });
    fireEvent.click(svg, { clientX, clientY });
    // (52.5, 34) is outside the box (x<84.29) — legacy lane/depth label proves
    // the click landed at pitch-centre, not at some letterbox-skewed point.
    // y=34 falls in L2 [21.82,37); x=52.5 → ceil(52.5/(100/6))=4.
    expect(within(container).getByLabelText("선택 구역 정보")).toHaveTextContent("L2 · 깊이 4");
  });

  it("clears a previously-selected shot stack when a genuine field/box click lands, instead of leaving the stale stack inspector showing", () => {
    const boxSubregion: BoxSubregionStatsState = { kind: "ready", key: "k", data: boxFixture };
    const { container } = render(<PitchPenaltyProvider><SixLaneCorridorPitch analysis={analysis} layers={DEFAULT_PITCH_LAYERS} boxSubregion={boxSubregion} /></PitchPenaltyProvider>);
    const svg = within(container.querySelector('[data-layout="six-lane-corridor-pitch"]')!).getByRole("img");
    fireEvent.click(within(svg).getByRole("button", { name: /goal 슛 상세, 묶음 2발/ }));
    expect(within(container).getByLabelText("슈팅 상세")).toBeInTheDocument();
    clickAtPitchPercent(svg, 84.29, 63); // a real box-region click
    expect(container.querySelector("[data-corridor-box-zone='L4']")).toBeInTheDocument();
    expect(within(container).queryByLabelText("슈팅 상세")).not.toBeInTheDocument();
  });

  it("shows an honest unavailable box-zone inspector while the route is still 404ing, never a fabricated count", () => {
    const { container } = render(<SixLaneCorridorPitch analysis={analysis} layers={DEFAULT_PITCH_LAYERS} boxSubregion={{ kind: "error", key: "k" }} />);
    const svg = container.querySelector("svg")!;
    clickAtPitchPercent(svg, 90, 30);
    const zone = container.querySelector("[data-corridor-box-zone='L2']")!;
    expect(zone).toHaveAttribute("data-corridor-box-zone-state", "unavailable");
    expect(zone).toHaveTextContent("박스 우"); // static definitional label still shown, just no numbers
    expect(zone).toHaveTextContent("박스 구역 통계를 사용할 수 없습니다");
  });
});
