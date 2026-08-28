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
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => ({
    clearRect,
    createImageData: (width: number, height: number) => ({ width, height, colorSpace: "srgb", data: new Uint8ClampedArray(width * height * 4) }),
    putImageData,
  }) as never);
  Object.defineProperty(window, "devicePixelRatio", { configurable: true, value: 3 });
  globalThis.ResizeObserver = class {
    constructor(callback: ResizeObserverCallback) { resizeCallbacks.push(callback); }
    observe() { /* test spy is the registered callback */ }
    unobserve() { /* no-op */ }
    disconnect() { /* no-op */ }
  } as never;
});

afterEach(() => {
  cleanup(); vi.restoreAllMocks(); vi.useRealTimers();
  globalThis.ResizeObserver = originalResizeObserver;
});

function expectCanvasClearedAfter(nextSpatial: unknown) {
  const view = render(<LegacySpatialPitch analysis={analysis(baseSpatial)} />);
  const canvas = view.container.querySelector("canvas")!;
  expect(canvas.width).toBe(216); expect(canvas.height).toBe(142); expect(putImageData).toHaveBeenCalledTimes(1);
  view.rerender(<LegacySpatialPitch analysis={analysis(nextSpatial)} />);
  expect(clearRect).toHaveBeenLastCalledWith(0, 0, 216, 142);
  expect(canvas.width).toBe(0); expect(canvas.height).toBe(0); expect(putImageData).toHaveBeenCalledTimes(1);
}

describe("LegacySpatialPitch", () => {
  it("renders one source shot per marker and retains the exact legacy summary/count lines", () => {
    render(<LegacySpatialPitch analysis={analysis(baseSpatial)} />);
    const section = screen.getByRole("region", { name: "2D 회랑" });
    expect(within(section).getByText("활동 좌표 2개 · 슛 4개 · 득점 ◇ · 유효 슛 ● · 빗나감 × · 블록 ■")).toBeInTheDocument();
    expect(section.querySelectorAll("[data-shot-index]")).toHaveLength(4);
    expect(section.querySelectorAll('[data-shot-outcome="goal"]')).toHaveLength(1);
    expect(section.querySelector('[data-layer="cca-contour"]')).toHaveAttribute("stroke", "#C084FC");
    expect(section.querySelector('[data-layer="cca-contour"]')).toHaveAttribute("stroke-width", "1.15");
    expect(section.querySelector('[data-layer="cca-contour"]')).toHaveAttribute("stroke-opacity", "0.46");
    expect(section.querySelector("image")).toBeNull();
    expect(section.querySelector('[data-layer="guardiola-20-zone-guide"]')).toBeInTheDocument();
    expect(section).toHaveTextContent("득점 1"); expect(section).toHaveTextContent("유효 슛 1"); expect(section).toHaveTextContent("빗나감 1"); expect(section).toHaveTextContent("블록 1");
  });

  it("fails closed on heatmap or shot count integrity mismatches", () => {
    const { rerender, container } = render(<LegacySpatialPitch analysis={analysis({ ...baseSpatial, heatmapPointCount: 3 })} />);
    expect(screen.getAllByText(/활동 히트맵 무결성 불일치/)).toHaveLength(2);
    rerender(<LegacySpatialPitch analysis={analysis({ ...baseSpatial, shotmapPointCount: 3 })} />);
    expect(screen.getAllByText(/슈팅 스냅샷 무결성 불일치/)).toHaveLength(2);
    expect(container.querySelectorAll("[data-shot-index]")).toHaveLength(0);
  });

  it("distinguishes unavailable snapshots from verified zero snapshots", () => {
    const { rerender } = render(<LegacySpatialPitch analysis={analysis({ ...baseSpatial, available: false, heatmapPointCount: 0, heatmapPoints: [], shotmapSnapshotAvailable: false, shotmapPointCount: 0, shotmapPoints: [] })} />);
    expect(screen.getAllByText(/활동 히트맵 사용 불가.*슈팅 스냅샷 사용 불가/)).toHaveLength(2);
    rerender(<LegacySpatialPitch analysis={analysis({ ...baseSpatial, heatmapPointCount: 0, heatmapPoints: [], shotmapPointCount: 0, shotmapPoints: [] })} />);
    expect(screen.getAllByText(/관측된 활동 좌표 0개.*관측된 슛 0개/)).toHaveLength(2);
  });

  it("clears the painted raster on populated to unavailable transitions", () => {
    expectCanvasClearedAfter({ ...baseSpatial, available: false, heatmapPointCount: 0, heatmapPoints: [] });
  });

  it("clears the painted raster on populated to integrity-mismatch transitions", () => {
    expectCanvasClearedAfter({ ...baseSpatial, heatmapPointCount: 3 });
  });

  it("clears the painted raster on populated to verified-zero transitions", () => {
    expectCanvasClearedAfter({ ...baseSpatial, heatmapPointCount: 0, heatmapPoints: [] });
  });

  it("caps DPR at two and redraws through ResizeObserver using the new responsive dimensions", () => {
    const rectSpy = vi.spyOn(HTMLCanvasElement.prototype, "getBoundingClientRect");
    const { container } = render(<LegacySpatialPitch analysis={analysis(baseSpatial)} />);
    const canvas = container.querySelector("canvas")!;
    expect(canvas.width).toBe(216); expect(canvas.height).toBe(142); expect(resizeCallbacks).toHaveLength(2);
    rectSpy.mockReturnValue(bounds(54, 35.45));
    act(() => resizeCallbacks[0]([], {} as ResizeObserver));
    expect(canvas.width).toBe(108); expect(canvas.height).toBe(71); expect(putImageData).toHaveBeenCalledTimes(2);
  });

  it("preserves legacy caption symbols while using legacy Plotly marker geometry", () => {
    const { container } = render(<LegacySpatialPitch analysis={analysis(baseSpatial)} />);
    expect(screen.getByText("활동 좌표 2개 · 슛 4개 · 득점 ◇ · 유효 슛 ● · 빗나감 × · 블록 ■", { selector: "figcaption" })).toBeInTheDocument();
    expect(container.querySelector('[data-shot-outcome="goal"]')).toHaveAttribute("data-marker-symbol", "star");
    expect(container.querySelector('[data-shot-outcome="blocked"]')).toHaveAttribute("data-marker-symbol", "diamond-open");
    fireEvent.focus(container.querySelector('[data-shot-outcome="goal"]')!); expect(screen.getByRole("tooltip")).toHaveTextContent("xG —"); expect(screen.getByRole("tooltip")).toHaveTextContent("xGOT —");
  });

  it("keeps the six shooting corridors visual-only and opt-in while explaining the permanent PK exclusion", () => {
    const { container } = render(<LegacySpatialPitch analysis={analysis(baseSpatial)} />);
    expect(screen.getByText("페널티는 분할선 위라 회랑 집계에서 항상 제외")).toBeInTheDocument();
    expect(container.querySelector('[data-layer="shot-corridors"]')).toBeNull();
    const toggle = screen.getByRole("button", { name: "6레인 슈팅 회랑" });
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    expect(container.querySelectorAll('[data-layer="shot-corridors"] path')).toHaveLength(5);
  });

  it("uses thin white zone guides without bands and confines the sky PK axis to the penalty boxes", () => {
    const { container } = render(<LegacySpatialPitch analysis={analysis(baseSpatial)} />);
    const zoneGrid = container.querySelector('[data-layer="positional-grid"]')!;
    const pkAxis = container.querySelector('[data-layer="pk-axis"]')!;
    expect(container.querySelector('[data-layer="zone-grid"]')).toBeNull();
    expect(zoneGrid).toHaveAttribute("stroke", "#FFFFFF");
    expect(zoneGrid).toHaveAttribute("stroke-width", "1");
    expect(zoneGrid).toHaveAttribute("stroke-opacity", "0.13");
    expect(zoneGrid.closest('[data-layer="guardiola-20-zone-guide"]')).toHaveAttribute("fill", "none");
    expect(pkAxis).toHaveAttribute("stroke", "#7DD3FC");
    expect(pkAxis).toHaveAttribute("stroke-width", "2");
    expect(pkAxis?.querySelectorAll("path")).toHaveLength(2);
    expect([...pkAxis!.querySelectorAll("path")].every((path) => !path.getAttribute("d")?.includes("H100"))).toBe(true);
  });

  it("keeps one roving marker tab stop while exact-coordinate groups preserve all source counts", () => {
    const many = Array.from({ length: 119 }, (_, index) => ({ x: index % 100, y: index % 100, outcome: "goal" as const }));
    const { container } = render(<LegacySpatialPitch analysis={analysis({ ...baseSpatial, shotmapPointCount: 119, shotmapPoints: many })} />);
    expect(container.querySelectorAll('[data-shot-index][tabindex="0"]')).toHaveLength(1); expect(container.querySelectorAll("[data-shot-index]")).toHaveLength(100);
    expect([...container.querySelectorAll("[data-shot-index]")].reduce((sum, marker) => sum + Number(marker.getAttribute("data-marker-count")), 0)).toBe(119);
    const controls = screen.getByRole("group", { name: "Shot outcome visibility" }); expect(controls).toHaveClass("grid-cols-2"); expect(screen.getByRole("button", { name: /득점, 119 shots/ })).toHaveClass("min-h-11", "min-w-11");
  });
});
