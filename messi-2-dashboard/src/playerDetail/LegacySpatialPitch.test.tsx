// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LegacySpatialPitch } from "./LegacySpatialPitch";

const core = { available: true, definitionVersion: "continuous-hdr-50-v1", targetDensityPct: 50, achievedDensityPct: 50, coreAreaPct: 5, densityThreshold: .1, thresholdOfPeak: .5, gridColumns: 32, gridRows: 22 };
const baseSpatial = { available: true, source: "messi-static-cohort", heatmapPointCount: 2, heatmapPoints: [{ x: 10, y: 20 }, { x: 90, y: 80 }], shotmapSnapshotAvailable: true, shotmapPointCount: 4, shotmapPoints: [{ x: 10, y: 20, outcome: "goal" }, { x: 20, y: 30, outcome: "on_target" }, { x: 30, y: 40, outcome: "off_target" }, { x: 40, y: 50, outcome: "blocked" }], continuousCore: core, inBoxRatio: null, outBoxFinalRatio: null, midThirdRatio: null, finalThirdRatio: null, ccaAreaPct: null, laneRatios: [], depthRatios: [], positionalGrid: [], trueCore: { available: false, definitionVersion: "true-core-30-zone-v1", targetDensityPct: 50, achievedDensityPct: 0, coreAreaPct: 0, zoneIds: [], zones: [] }, dangerZoneDensity: null, deepBoxZoneScore: null };
const analysis = (spatial: unknown) => ({ spatial }) as never;
const clearRect = vi.fn();
const putImageData = vi.fn();
const resizeCallbacks: ResizeObserverCallback[] = [];
const originalResizeObserver = globalThis.ResizeObserver;
const bounds = (width: number, height: number) => ({ x: 0, y: 0, width, height, top: 0, right: width, bottom: height, left: 0, toJSON: () => ({}) }) as DOMRect;

beforeEach(() => {
  clearRect.mockReset(); putImageData.mockReset(); resizeCallbacks.length = 0;
  vi.spyOn(HTMLCanvasElement.prototype, "getBoundingClientRect").mockReturnValue(bounds(108, 70.9));
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => ({ clearRect, createImageData: (width: number, height: number) => ({ width, height, colorSpace: "srgb", data: new Uint8ClampedArray(width * height * 4) }), putImageData }) as never);
  Object.defineProperty(window, "devicePixelRatio", { configurable: true, value: 3 });
  globalThis.ResizeObserver = class { constructor(callback: ResizeObserverCallback) { resizeCallbacks.push(callback); } observe() { /* test spy is the registered callback */ } unobserve() { /* no-op */ } disconnect() { /* no-op */ } } as never;
});

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); globalThis.ResizeObserver = originalResizeObserver; });

function expectCanvasClearedAfter(nextSpatial: unknown) {
  const view = render(<LegacySpatialPitch analysis={analysis(baseSpatial)} />);
  const canvas = view.container.querySelector("canvas")!;
  expect(canvas.width).toBe(216); expect(canvas.height).toBe(142); expect(putImageData).toHaveBeenCalledTimes(1);
  view.rerender(<LegacySpatialPitch analysis={analysis(nextSpatial)} />);
  expect(clearRect).toHaveBeenLastCalledWith(0, 0, 216, 142); expect(canvas.width).toBe(0); expect(canvas.height).toBe(0); expect(putImageData).toHaveBeenCalledTimes(1);
}

describe("LegacySpatialPitch", () => {
  it("renders exact legacy marker styles and unfiltered total counts", () => {
    render(<LegacySpatialPitch analysis={analysis(baseSpatial)} />);
    const section = screen.getByRole("region", { name: "Spatial pitch" });
    expect(within(section).getByText("2 activity points. 4 shots. Goal ◇ · on target ● · off target × · blocked ■.", { selector: "figcaption" })).toBeInTheDocument();
    expect(section.querySelectorAll("[data-shot-index]")).toHaveLength(4);
    expect(section.querySelector('[data-shot-outcome="goal"]')).toHaveAttribute("data-marker-symbol", "star");
    expect(section.querySelector('[data-shot-outcome="goal"]')).toHaveAttribute("data-marker-size", "12");
    expect(section.querySelector('[data-shot-outcome="blocked"]')).toHaveAttribute("data-marker-symbol", "diamond-open");
    expect(section.querySelector('[data-shot-outcome="blocked"]')).toHaveAttribute("data-marker-size", "8");
    expect(within(section).getAllByRole("button")).toHaveLength(4);
    expect(section).toHaveTextContent("Goals 1"); expect(section).toHaveTextContent("On target 1"); expect(section).toHaveTextContent("Off target 1"); expect(section).toHaveTextContent("Blocked 1");
  });

  it("fails closed on heatmap or shot count integrity mismatches", () => {
    const { rerender, container } = render(<LegacySpatialPitch analysis={analysis({ ...baseSpatial, heatmapPointCount: 3 })} />);
    expect(screen.getAllByText(/Activity heatmap integrity mismatch/)).toHaveLength(2);
    rerender(<LegacySpatialPitch analysis={analysis({ ...baseSpatial, shotmapPointCount: 3 })} />);
    expect(screen.getAllByText(/Shot snapshot integrity mismatch/)).toHaveLength(2);
    expect(container.querySelectorAll("[data-shot-index]")).toHaveLength(0); expect(container.querySelectorAll('button[aria-pressed]')).toHaveLength(0);
  });

  it("distinguishes unavailable snapshots from verified zero snapshots", () => {
    const { rerender, container } = render(<LegacySpatialPitch analysis={analysis({ ...baseSpatial, available: false, heatmapPointCount: 0, heatmapPoints: [], shotmapSnapshotAvailable: false, shotmapPointCount: 0, shotmapPoints: [] })} />);
    expect(screen.getAllByText(/Activity heatmap unavailable.*Shot snapshot unavailable/)).toHaveLength(2); expect(container.querySelectorAll('button[aria-pressed]')).toHaveLength(0);
    rerender(<LegacySpatialPitch analysis={analysis({ ...baseSpatial, heatmapPointCount: 0, heatmapPoints: [], shotmapPointCount: 0, shotmapPoints: [] })} />);
    expect(screen.getAllByText(/Verified zero activity points.*Verified zero shots/)).toHaveLength(2); expect(container.querySelectorAll('button[aria-pressed]')).toHaveLength(0);
  });

  it("clears the painted raster on populated to unavailable transitions", () => expectCanvasClearedAfter({ ...baseSpatial, available: false, heatmapPointCount: 0, heatmapPoints: [] }));
  it("clears the painted raster on populated to integrity-mismatch transitions", () => expectCanvasClearedAfter({ ...baseSpatial, heatmapPointCount: 3 }));
  it("clears the painted raster on populated to verified-zero transitions", () => expectCanvasClearedAfter({ ...baseSpatial, heatmapPointCount: 0, heatmapPoints: [] }));

  it("caps DPR at two and redraws through the canvas ResizeObserver", () => {
    const rectSpy = vi.spyOn(HTMLCanvasElement.prototype, "getBoundingClientRect");
    const { container } = render(<LegacySpatialPitch analysis={analysis(baseSpatial)} />); const canvas = container.querySelector("canvas")!;
    expect(canvas.width).toBe(216); expect(canvas.height).toBe(142); expect(resizeCallbacks).toHaveLength(2);
    rectSpy.mockReturnValue(bounds(54, 35.45)); act(() => resizeCallbacks[0]([], {} as ResizeObserver));
    expect(canvas.width).toBe(108); expect(canvas.height).toBe(71); expect(putImageData).toHaveBeenCalledTimes(2);
  });

  it("toggles marker visibility only after the single-click decision window", () => {
    vi.useFakeTimers(); const { container } = render(<LegacySpatialPitch analysis={analysis(baseSpatial)} />); const goals = screen.getByRole("button", { name: /Goals, 1 shots/ });
    fireEvent.click(goals, { detail: 1 }); expect(container.querySelectorAll("[data-shot-index]")).toHaveLength(4);
    act(() => vi.advanceTimersByTime(350)); expect(goals).toHaveAttribute("aria-pressed", "false"); expect(container.querySelectorAll('[data-shot-outcome="goal"]')).toHaveLength(0);
    expect(container.querySelectorAll("[data-shot-index]")).toHaveLength(3); expect(container.querySelector('[data-layer="legacy-density"]')).toBeInTheDocument(); expect(container.querySelector('[data-layer="cca-contour"]')).toBeInTheDocument(); expect(container.querySelector("ul")).toHaveTextContent("Goals 1");
  });

  it("isolates an outcome without firing the pending single click", () => {
    vi.useFakeTimers(); const { container } = render(<LegacySpatialPitch analysis={analysis(baseSpatial)} />); const goals = screen.getByRole("button", { name: /Goals, 1 shots/ });
    fireEvent.click(goals, { detail: 1 }); fireEvent.doubleClick(goals); act(() => vi.advanceTimersByTime(350));
    expect(container.querySelectorAll("[data-shot-index]")).toHaveLength(1); expect(container.querySelectorAll('[data-shot-outcome="goal"]')).toHaveLength(1); expect(goals).toHaveAttribute("aria-pressed", "true");
  });

  it("commits a rapid different-outcome click before scheduling the next one", () => {
    vi.useFakeTimers(); const { container } = render(<LegacySpatialPitch analysis={analysis(baseSpatial)} />);
    fireEvent.click(screen.getByRole("button", { name: /Goals, 1 shots/ }), { detail: 1 });
    fireEvent.click(screen.getByRole("button", { name: /On target, 1 shots/ }), { detail: 1 });
    expect(container.querySelectorAll('[data-shot-outcome="goal"]')).toHaveLength(0);
    expect(container.querySelectorAll('[data-shot-outcome="on_target"]')).toHaveLength(1);
    act(() => vi.advanceTimersByTime(350));
    expect(container.querySelectorAll('[data-shot-outcome="on_target"]')).toHaveLength(0);
    expect(container.querySelectorAll("[data-shot-index]")).toHaveLength(2);
  });

  it("drops a pending click when the context identity changes", () => {
    vi.useFakeTimers(); const { container, rerender } = render(<LegacySpatialPitch analysis={analysis(baseSpatial)} contextIdentity="player-1|2025" />);
    fireEvent.click(screen.getByRole("button", { name: /Goals, 1 shots/ }), { detail: 1 });
    rerender(<LegacySpatialPitch analysis={analysis(baseSpatial)} contextIdentity="player-1|2026" />);
    act(() => vi.advanceTimersByTime(350));
    expect(container.querySelectorAll("[data-shot-index]")).toHaveLength(4);
    expect(screen.getByRole("button", { name: /Goals, 1 shots/ })).toHaveAttribute("aria-pressed", "true");
  });

  it("treats native keyboard button activation as an immediate toggle", () => {
    vi.useFakeTimers(); const { container } = render(<LegacySpatialPitch analysis={analysis(baseSpatial)} />); const goals = screen.getByRole("button", { name: /Goals, 1 shots/ });
    fireEvent.keyDown(goals, { key: "Enter" }); fireEvent.click(goals, { detail: 0 });
    expect(container.querySelectorAll('[data-shot-outcome="goal"]')).toHaveLength(0);
    fireEvent.keyDown(goals, { key: " " }); fireEvent.click(goals, { detail: 0 });
    expect(container.querySelectorAll('[data-shot-outcome="goal"]')).toHaveLength(1); expect(vi.getTimerCount()).toBe(0);
  });

  it("resets a changed context and exposes xG/xGOT through one roving marker tab stop", () => {
    const richSpatial = { ...baseSpatial, shotmapPoints: [{ x: 10, y: 20, outcome: "goal" as const, xg: .36, xgot: null }, ...baseSpatial.shotmapPoints.slice(1)] };
    const { container, rerender } = render(<LegacySpatialPitch analysis={analysis(richSpatial)} contextIdentity="player-1|2025" />); const goals = screen.getByRole("button", { name: /Goals, 1 shots/ });
    fireEvent.click(goals); expect(container.querySelectorAll("[data-shot-index]")).toHaveLength(3);
    rerender(<LegacySpatialPitch analysis={analysis(richSpatial)} contextIdentity="player-1|2026" />); expect(container.querySelectorAll("[data-shot-index]")).toHaveLength(4);
    fireEvent.focus(container.querySelector('[data-shot-outcome="goal"]')!); expect(screen.getByRole("tooltip")).toHaveTextContent("xG 0.36"); expect(screen.getByRole("tooltip")).toHaveTextContent("xGOT —"); expect(container.querySelectorAll('[data-shot-index][tabindex="0"]')).toHaveLength(1);
  });

  it("keeps one roving tab stop for 119 shots and uses em dashes for null tooltip metrics", () => {
    const manyShots = Array.from({ length: 119 }, (_, index) => ({ x: index % 100, y: (index * 3) % 100, outcome: "goal" as const, xg: null, xgot: null }));
    const { container } = render(<LegacySpatialPitch analysis={analysis({ ...baseSpatial, shotmapPointCount: 119, shotmapPoints: manyShots })} />);
    expect(container.querySelectorAll("[data-shot-index]")).toHaveLength(119); expect(container.querySelectorAll('[data-shot-index][tabindex="0"]')).toHaveLength(1);
    fireEvent.focus(container.querySelector('[data-shot-index][tabindex="0"]')!); expect(screen.getByRole("tooltip")).toHaveTextContent("xG —"); expect(screen.getByRole("tooltip")).toHaveTextContent("xGOT —");
  });

  it("uses a two-column, 44px native-button control grid at 320px", () => {
    const { container } = render(<LegacySpatialPitch analysis={analysis(baseSpatial)} />); const controls = screen.getByRole("group", { name: "Shot outcome visibility" });
    expect(controls).toHaveClass("grid", "grid-cols-2"); expect(container.querySelectorAll('button[aria-pressed]')).toHaveLength(4);
    container.querySelectorAll('button[aria-pressed]').forEach((button) => expect(button).toHaveClass("min-h-11", "min-w-11"));
  });
});
