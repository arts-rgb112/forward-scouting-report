import type { PitchShotGroup } from "./PitchShotMarker";
import { bilinearDensity, displayHeatmapColor, fullActivityDensityGrid, normalizeDensity } from "./legacyHeatmap";
import { GLB_PITCH_LENGTH_METERS, GLB_PITCH_WIDTH_METERS, WEBGL_OVERLAY_Y_METERS, pitchPercentToWorld, type WorldPoint } from "./pitchWebglGeometry";

/** Approved dot-matrix projection density. These are view-only cells, never a scoring raster. */
export const WEBGL_DOTMATRIX_COLUMNS = 64;
export const WEBGL_DOTMATRIX_ROWS = 24;
export const WEBGL_DOTMATRIX_DENSITY_CUTOFF = .05;

export type WebglDensityDot = {
  row: number;
  column: number;
  density: number;
  radiusMeters: number;
  world: WorldPoint;
  color: readonly [number, number, number, number];
};

export type WebglShotPlacement = {
  key: string;
  radiusMeters: number;
  offsetMeters: readonly [number, number];
  world: WorldPoint;
};

const clamp = (value: number, minimum: number, maximum: number) => Math.min(maximum, Math.max(minimum, value));

/** B-4 radius rule transposed from screen cell spacing to the 105 × 68m pitch. */
export function webglDotRadiusMeters(density: number) {
  const rmax = .47 * Math.min(GLB_PITCH_WIDTH_METERS / WEBGL_DOTMATRIX_COLUMNS, GLB_PITCH_LENGTH_METERS / WEBGL_DOTMATRIX_ROWS);
  const normalized = clamp((density - WEBGL_DOTMATRIX_DENSITY_CUTOFF) / (1 - WEBGL_DOTMATRIX_DENSITY_CUTOFF), 0, 1);
  return rmax * (.26 + .74 * Math.pow(normalized, .55));
}

/**
 * Uses the established 32 × 22 full-activity histogram and its approved
 * colour function. It deliberately contains no blur, canvas raster, or new
 * palette; only the draw primitive becomes a dot.
 */
export function buildWebglDensityDots(cellCounts: readonly number[]): WebglDensityDot[] {
  const normalized = normalizeDensity(fullActivityDensityGrid(cellCounts));
  const dots: WebglDensityDot[] = [];
  for (let row = 0; row < WEBGL_DOTMATRIX_ROWS; row += 1) for (let column = 0; column < WEBGL_DOTMATRIX_COLUMNS; column += 1) {
    const x = (column + .5) * 100 / WEBGL_DOTMATRIX_COLUMNS;
    const y = (row + .5) * 100 / WEBGL_DOTMATRIX_ROWS;
    const density = bilinearDensity(normalized, x, y);
    if (density <= WEBGL_DOTMATRIX_DENSITY_CUTOFF) continue;
    dots.push({
      row,
      column,
      density,
      radiusMeters: webglDotRadiusMeters(density),
      world: pitchPercentToWorld({ x, y }, WEBGL_OVERLAY_Y_METERS + .018),
      color: displayHeatmapColor(density),
    });
  }
  return dots.sort((left, right) => left.density - right.density || left.row - right.row || left.column - right.column);
}

/** Small, flat footprint preserves xG ordering without the former ball-sized spheres. */
export function webglShotMarkerRadius(xg: number | null | undefined, medianXg: number | null) {
  const value = typeof xg === "number" && Number.isFinite(xg) && xg >= 0 ? xg : medianXg;
  const safe = typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : .25;
  return .115 + .255 * Math.sqrt(safe);
}

/**
 * Preserve every source event while preventing close 3D discs from visually
 * piling up. Offsets are deterministic, bounded and exposed to the DOM; the
 * tooltip always retains the original source coordinate.
 */
export function layoutWebglShotMarkers(groups: readonly PitchShotGroup[], medianXg: number | null): Map<string, WebglShotPlacement> {
  const placed: WebglShotPlacement[] = [];
  const output = new Map<string, WebglShotPlacement>();
  const ordered = [...groups].sort((left, right) => left.sourceIndexes[0] - right.sourceIndexes[0] || left.key.localeCompare(right.key));
  for (const group of ordered) {
    const base = pitchPercentToWorld(group.shot, WEBGL_OVERLAY_Y_METERS + .03);
    const radiusMeters = webglShotMarkerRadius(group.shot.xg, medianXg);
    let candidate: WebglShotPlacement | null = null;
    for (let attempt = 0; attempt < 64; attempt += 1) {
      const ring = attempt === 0 ? 0 : Math.ceil(attempt / 8);
      const angle = attempt * 2.399963229728653;
      const distance = ring * .16;
      const offsetX = Math.cos(angle) * distance;
      const offsetZ = Math.sin(angle) * distance;
      const next: WebglShotPlacement = {
        key: group.key,
        radiusMeters,
        offsetMeters: [offsetX, offsetZ],
        world: { x: base.x + offsetX, y: base.y, z: base.z + offsetZ },
      };
      const overlaps = placed.some((other) => Math.hypot(other.world.x - next.world.x, other.world.z - next.world.z) < other.radiusMeters + next.radiusMeters + .035);
      if (!overlaps) { candidate = next; break; }
    }
    // A pathological 64-disc pile still receives a small visible separation.
    const final = candidate ?? {
      key: group.key,
      radiusMeters,
      offsetMeters: [.64, 0],
      world: { x: base.x + .64, y: base.y, z: base.z },
    };
    placed.push(final);
    output.set(group.key, final);
  }
  return output;
}
