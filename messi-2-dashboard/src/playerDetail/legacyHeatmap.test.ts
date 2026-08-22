import { describe, expect, it } from "vitest";

import { HEATMAP_COLUMNS, HEATMAP_ROWS, bilinearDensity, legacyDensityGrid, legacyHeatmapColor, marchingSquares, normalizeDensity, rawActivityHistogram } from "./legacyHeatmap";

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

  it("interpolates the exact legacy rgba stops", () => {
    expect(legacyHeatmapColor(0)).toEqual([0, 0, 0, 0]);
    expect(legacyHeatmapColor(.08)).toEqual([124, 151, 71, .18]);
    expect(legacyHeatmapColor(1)).toEqual([222, 63, 31, .98]);
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
