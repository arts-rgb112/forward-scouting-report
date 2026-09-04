import { describe, expect, it } from "vitest";

import { activityHistogramGrid, displayHeatmapColor } from "./legacyHeatmap";
import { groupPitchShots } from "./PitchShotMarker";
import {
  WEBGL_DOTMATRIX_COLUMNS,
  WEBGL_DOTMATRIX_ROWS,
  buildWebglDensityDots,
  layoutWebglShotMarkers,
  webglShotMarkerRadius,
} from "./webglDotMatrix";

describe("WebGL dot-matrix primitives", () => {
  it("uses the server 32×22 histogram and established legacy palette without a raster blur", () => {
    const counts = new Array(32 * 22).fill(0);
    counts[11 * 32 + 24] = 25;
    const dots = buildWebglDensityDots(counts);
    expect(dots.length).toBeGreaterThan(0);
    expect(dots.every((dot) => dot.row >= 0 && dot.row < WEBGL_DOTMATRIX_ROWS && dot.column >= 0 && dot.column < WEBGL_DOTMATRIX_COLUMNS)).toBe(true);
    const hottest = dots.at(-1)!;
    expect(hottest.color).toEqual(displayHeatmapColor(hottest.density));
    expect(hottest.radiusMeters).toBeGreaterThan(0);
    expect(activityHistogramGrid(counts)).toHaveLength(32 * 22);
  });

  it("keeps xG size ordering while using a small, flat footprint", () => {
    expect(webglShotMarkerRadius(.8, .2)).toBeGreaterThan(webglShotMarkerRadius(.05, .2));
    expect(webglShotMarkerRadius(.8, .2)).toBeLessThan(.5);
  });

  it("deterministically separates close shot discs instead of allowing a sphere pile", () => {
    const groups = groupPitchShots([
      { sourceIndex: 0, shot: { x: 88, y: 50, xg: .4, outcome: "goal" as const } },
      { sourceIndex: 1, shot: { x: 88.1, y: 50.1, xg: .3, outcome: "on_target" as const } },
      { sourceIndex: 2, shot: { x: 88.2, y: 50.2, xg: .2, outcome: "blocked" as const } },
    ]);
    const first = layoutWebglShotMarkers(groups, .3);
    const second = layoutWebglShotMarkers(groups, .3);
    expect([...first.values()].map((placement) => placement.offsetMeters)).toEqual([...second.values()].map((placement) => placement.offsetMeters));
    expect([...first.values()].filter((placement) => placement.offsetMeters[0] !== 0 || placement.offsetMeters[1] !== 0)).toHaveLength(2);
  });
});
