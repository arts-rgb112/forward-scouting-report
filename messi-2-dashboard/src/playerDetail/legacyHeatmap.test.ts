import { describe, expect, it } from "vitest";

import { DISPLAY_HEATMAP_COLOR_STAGES, DISPLAY_HEATMAP_COLUMNS, DISPLAY_HEATMAP_ROWS, HEATMAP_COLUMNS, HEATMAP_DISPLAY_GAMMA, HEATMAP_ROWS, HEATMAP_STOPS, activityHistogramGrid, bilinearDensity, displayDensityGrid, displayHeatmapColor, fullActivityDensityGrid, legacyDensityGrid, legacyHeatmapColor, marchingSquares, normalizeDensity, rawActivityHistogram } from "./legacyHeatmap";

describe("legacy 32 x 22 spatial raster", () => {
  it("keeps numpy-compatible endpoint values in the final bin", () => {
    const histogram = rawActivityHistogram([{ x: 0, y: 0 }, { x: 100, y: 100 }]);
    expect(histogram[0]).toBe(1);
    expect(histogram[HEATMAP_ROWS * HEATMAP_COLUMNS - 1]).toBe(1);
    expect([...histogram].reduce((sum, value) => sum + value, 0)).toBe(2);
  });

  it("uses edge-replicated separable [1,4,6,4,1]/16 smoothing", () => {
    const density = legacyDensityGrid([{ x: 0, y: 0 }]);
    expect(density).toBeInstanceOf(Float64Array);
    expect(density[0]).toBeCloseTo(121 / 256, 12);
    expect(density[1]).toBeCloseTo(55 / 256, 12);
    expect(density[HEATMAP_COLUMNS]).toBeCloseTo(55 / 256, 12);
  });

  it("normalizes only by the observed peak and bilinearly samples cell centres", () => {
    const density = normalizeDensity(legacyDensityGrid([{ x: 50, y: 50 }]));
    expect(Math.max(...density)).toBe(1);
    expect(bilinearDensity(density, 51.5625, 52.272727)).toBeCloseTo(1, 6);
    expect(bilinearDensity(density, -1, 50)).toBe(0);
  });

  it("uses the approved six-stop gold-to-red ramp with stop-owned alpha", () => {
    expect(HEATMAP_STOPS).toHaveLength(6);
    expect(HEATMAP_STOPS.every(([, color]) => color.length === 4)).toBe(true);
    expect(legacyHeatmapColor(0)).toEqual([0, 0, 0, 0]);
    expect(legacyHeatmapColor(1)).toEqual([222, 63, 31, .98]);
  });

  it("applies gamma and twelve-stage quantization only when selecting display colours", () => {
    const native = .24;
    expect(HEATMAP_DISPLAY_GAMMA).toBe(.6);
    expect(DISPLAY_HEATMAP_COLOR_STAGES).toBe(12);
    expect(displayHeatmapColor(native)).toEqual(legacyHeatmapColor(native ** .6));
    const quantized = Math.round((.05 ** HEATMAP_DISPLAY_GAMMA) * (DISPLAY_HEATMAP_COLOR_STAGES - 1)) / (DISPLAY_HEATMAP_COLOR_STAGES - 1);
    const low = HEATMAP_STOPS[1], high = HEATMAP_STOPS[2];
    const expectedAlpha = low[1][3] + (high[1][3] - low[1][3]) * ((quantized - low[0]) / (high[0] - low[0]));
    expect(displayHeatmapColor(.05)[3]).toBeCloseTo(expectedAlpha, 6);
    expect(legacyHeatmapColor(.051)).toEqual(legacyHeatmapColor(.052));
    expect(displayHeatmapColor(0)[3]).toBe(0);
    expect(native).toBe(.24);
  });

  it("smooths a server count-weighted histogram without reconstructing points", () => {
    const counts = new Array(HEATMAP_COLUMNS * HEATMAP_ROWS).fill(0); counts[0] = 4;
    expect([...activityHistogramGrid(counts)].reduce((sum, value) => sum + value, 0)).toBe(4);
    const density = fullActivityDensityGrid(counts);
    expect(density[0]).toBeCloseTo(4 * 121 / 256, 12);
  });

  it("upsamples only the display mesh and leaves the 32 by 22 scoring raster intact", () => {
    const source = normalizeDensity(legacyDensityGrid([{ x: 50, y: 50 }]));
    const display = displayDensityGrid(source);
    expect(display).toHaveLength(DISPLAY_HEATMAP_COLUMNS * DISPLAY_HEATMAP_ROWS);
    expect(source).toHaveLength(HEATMAP_COLUMNS * HEATMAP_ROWS);
    expect(Math.max(...display)).toBeLessThanOrEqual(1);
    expect(source).toEqual(normalizeDensity(legacyDensityGrid([{ x: 50, y: 50 }])));
  });

  it("uses deterministic saddle pairing and inverted render-y contour coordinates", () => {
    const grid = new Float64Array(HEATMAP_ROWS * HEATMAP_COLUMNS);
    grid[0] = 1; // source-y 0 is rendered at the bottom edge.
    const segments = marchingSquares(grid, .5);
    expect(segments).toHaveLength(1);
    expect(segments[0][1]).toBeGreaterThan(90);
    const saddle = new Float64Array(HEATMAP_ROWS * HEATMAP_COLUMNS);
    saddle[0] = 1; saddle[HEATMAP_COLUMNS + 1] = 1;
    const first = marchingSquares(saddle, .5);
    expect(first).toEqual(marchingSquares(saddle, .5));
    expect(first).toHaveLength(5);
  });
});
