import { describe, expect, it } from "vitest";

import { DISPLAY_HEATMAP_COLUMNS, DISPLAY_HEATMAP_ROWS, HEATMAP_COLUMNS, HEATMAP_DISPLAY_GAMMA, HEATMAP_ROWS, HEATMAP_STOPS, activityHistogramGrid, bilinearDensity, displayDensityGrid, displayHeatmapColor, fullActivityDensityGrid, legacyDensityGrid, legacyHeatmapColor, marchingSquares, normalizeDensity, rawActivityHistogram } from "./legacyHeatmap";

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

  it("uses the approved purple-to-red B ramp with visible positive low density", () => {
    expect(legacyHeatmapColor(0)).toEqual([47, 30, 78, 0]);
    expect(HEATMAP_STOPS).toEqual([[0, [47, 30, 78]], [.3, [124, 42, 110]], [.6, [196, 70, 60]], [.85, [232, 99, 42]], [1, [222, 63, 31]]]);
    expect(legacyHeatmapColor(.001)[3]).toBeGreaterThan(.06);
    expect(legacyHeatmapColor(1)).toEqual([222, 63, 31, .58]);
  });

  it("applies gamma only when selecting display colours", () => {
    const native = .24;
    expect(HEATMAP_DISPLAY_GAMMA).toBe(.65);
    expect(displayHeatmapColor(native)).toEqual(legacyHeatmapColor(native ** .65));
    expect(displayHeatmapColor(.05)[3]).toBeCloseTo(.06 + .52 * (.05 ** .65), 6);
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
