/**
 * The legacy Streamlit heatmap used this exact 32 × 22 raster for both its
 * colours and CCA contour.  This module deliberately only turns the server's
 * raw activity coordinates into pixels; it never derives a new player metric.
 */
export const HEATMAP_COLUMNS = 32;
export const HEATMAP_ROWS = 22;
/** Display-only resolution. The 32 × 22 grid remains the sole scoring/CCA raster. */
export const DISPLAY_HEATMAP_COLUMNS = 96;
export const DISPLAY_HEATMAP_ROWS = 66;
/** Display-only tone mapping. Native density stays unchanged for CCA/HDR. */
export const DISPLAY_HEATMAP_COLOR_STAGES = 12;
export const HEATMAP_DISPLAY_GAMMA = .6;
export const HEATMAP_KERNEL = [1, 4, 6, 4, 1] as const;
export const HEATMAP_STOPS = [
  [0, [0, 0, 0, 0]],
  [.08, [124, 151, 71, .18]],
  [.24, [188, 185, 65, .56]],
  [.48, [244, 209, 60, .78]],
  [.72, [247, 135, 39, .9]],
  [1, [222, 63, 31, .98]],
] as const;
export const HEATMAP_OPACITY = .55;
export const TWO_D_HEATMAP_BLUR_PX = 0;
export const THREE_D_HEATMAP_BLUR = 4;

export type ActivityPoint = { x: number; y: number };
export type HeatmapGrid = Float64Array;
export type ContourSegment = readonly [number, number, number, number];

const finitePitchPoint = (point: ActivityPoint) => Number.isFinite(point.x) && Number.isFinite(point.y) && point.x >= 0 && point.x <= 100 && point.y >= 0 && point.y <= 100;
const clamp = (value: number, minimum: number, maximum: number) => Math.min(maximum, Math.max(minimum, value));
const at = (grid: HeatmapGrid, row: number, column: number) => grid[row * HEATMAP_COLUMNS + column] ?? 0;

/** Numpy histogram2d endpoints: 100 belongs to the last bin, never a 33rd one. */
export function rawActivityHistogram(points: readonly ActivityPoint[]): HeatmapGrid {
  const grid = new Float64Array(HEATMAP_ROWS * HEATMAP_COLUMNS);
  for (const point of points) {
    if (!finitePitchPoint(point)) continue;
    const column = Math.min(HEATMAP_COLUMNS - 1, Math.floor((point.x / 100) * HEATMAP_COLUMNS));
    const row = Math.min(HEATMAP_ROWS - 1, Math.floor((point.y / 100) * HEATMAP_ROWS));
    grid[row * HEATMAP_COLUMNS + column] += 1;
  }
  return grid;
}

/** Server-owned count-weighted Tier 3 histogram; no coordinate reconstruction. */
export function activityHistogramGrid(cellCounts: readonly number[]): HeatmapGrid {
  if (cellCounts.length !== HEATMAP_ROWS * HEATMAP_COLUMNS || cellCounts.some((value) => !Number.isInteger(value) || value < 0)) return new Float64Array(HEATMAP_ROWS * HEATMAP_COLUMNS);
  return Float64Array.from(cellCounts);
}

function smoothAxis(source: HeatmapGrid, axis: "row" | "column"): HeatmapGrid {
  const target = new Float64Array(source.length);
  for (let row = 0; row < HEATMAP_ROWS; row += 1) for (let column = 0; column < HEATMAP_COLUMNS; column += 1) {
    let sum = 0;
    for (let offset = -2; offset <= 2; offset += 1) {
      const sourceRow = axis === "row" ? clamp(row + offset, 0, HEATMAP_ROWS - 1) : row;
      const sourceColumn = axis === "column" ? clamp(column + offset, 0, HEATMAP_COLUMNS - 1) : column;
      sum += at(source, sourceRow, sourceColumn) * HEATMAP_KERNEL[offset + 2];
    }
    target[row * HEATMAP_COLUMNS + column] = sum / 16;
  }
  return target;
}

/** Edge-replicated [1,4,6,4,1]/16 smoothing: rows, then columns, matching continuous_core.py. */
export function legacyDensityGrid(points: readonly ActivityPoint[]): HeatmapGrid {
  return smoothAxis(smoothAxis(rawActivityHistogram(points), "row"), "column");
}

/** Apply the established display smoothing directly to the server histogram. */
export function fullActivityDensityGrid(cellCounts: readonly number[]): HeatmapGrid {
  return smoothAxis(smoothAxis(activityHistogramGrid(cellCounts), "row"), "column");
}

export function normalizeDensity(grid: HeatmapGrid): HeatmapGrid {
  let peak = 0;
  for (const value of grid) peak = Math.max(peak, value);
  if (peak <= 0) return new Float64Array(grid.length);
  return Float64Array.from(grid, (value) => value / peak);
}

/** Manual, centre-of-cell bilinear interpolation used when painting the raster canvas. */
export function bilinearDensity(grid: HeatmapGrid, x: number, sourceY: number): number {
  if (!Number.isFinite(x) || !Number.isFinite(sourceY) || x < 0 || x > 100 || sourceY < 0 || sourceY > 100) return 0;
  const rawColumn = x / (100 / HEATMAP_COLUMNS) - .5;
  const rawRow = sourceY / (100 / HEATMAP_ROWS) - .5;
  const left = clamp(Math.floor(rawColumn), 0, HEATMAP_COLUMNS - 1);
  const top = clamp(Math.floor(rawRow), 0, HEATMAP_ROWS - 1);
  const right = clamp(left + 1, 0, HEATMAP_COLUMNS - 1);
  const bottom = clamp(top + 1, 0, HEATMAP_ROWS - 1);
  const tx = clamp(rawColumn - Math.floor(rawColumn), 0, 1);
  const ty = clamp(rawRow - Math.floor(rawRow), 0, 1);
  const upper = at(grid, top, left) * (1 - tx) + at(grid, top, right) * tx;
  const lower = at(grid, bottom, left) * (1 - tx) + at(grid, bottom, right) * tx;
  return upper * (1 - ty) + lower * ty;
}

/**
 * Resamples only the already-smoothed display raster. It deliberately has no
 * caller in HDR/CCA calculation paths: those stay on the native 32 × 22 grid.
 */
export function displayDensityGrid(grid: HeatmapGrid, columns = DISPLAY_HEATMAP_COLUMNS, rows = DISPLAY_HEATMAP_ROWS): HeatmapGrid {
  const output = new Float64Array(columns * rows);
  for (let row = 0; row < rows; row += 1) for (let column = 0; column < columns; column += 1) {
    const x = (column + .5) * 100 / columns;
    const y = (row + .5) * 100 / rows;
    output[row * columns + column] = bilinearDensity(grid, x, y);
  }
  return output;
}

export function legacyHeatmapColor(value: number): readonly [number, number, number, number] {
  const normalized = Math.round(clamp(value, 0, 1) * (DISPLAY_HEATMAP_COLOR_STAGES - 1)) / (DISPLAY_HEATMAP_COLOR_STAGES - 1);
  const upperIndex = HEATMAP_STOPS.findIndex(([stop]) => normalized <= stop);
  const upper = HEATMAP_STOPS[upperIndex < 0 ? HEATMAP_STOPS.length - 1 : upperIndex];
  const lower = HEATMAP_STOPS[Math.max(0, (upperIndex < 0 ? HEATMAP_STOPS.length - 1 : upperIndex) - 1)];
  const amount = upper[0] === lower[0] ? 0 : (normalized - lower[0]) / (upper[0] - lower[0]);
  return [
    lower[1][0] + (upper[1][0] - lower[1][0]) * amount,
    lower[1][1] + (upper[1][1] - lower[1][1]) * amount,
    lower[1][2] + (upper[1][2] - lower[1][2]) * amount,
    lower[1][3] + (upper[1][3] - lower[1][3]) * amount,
  ];
}

/**
 * Maps native normalized density to the visual ramp only. Do not feed this
 * value to contour/HDR calculations: their threshold contract uses native
 * normalized density from the 32 × 22 grid.
 */
export function displayHeatmapColor(nativeNormalizedDensity: number): readonly [number, number, number, number] {
  return legacyHeatmapColor(Math.pow(clamp(nativeNormalizedDensity, 0, 1), HEATMAP_DISPLAY_GAMMA));
}

/** Paint to the same logical coordinate plane as the SVG: x=-4..104, y=0..100. */
export function renderLegacyHeatmap(ctx: CanvasRenderingContext2D, width: number, height: number, normalized: HeatmapGrid): void {
  const pixels = ctx.createImageData(width, height);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const sourceX = -4 + ((x + .5) / width) * 108;
    const sourceY = 100 - ((y + .5) / height) * 100;
    const [red, green, blue, alpha] = displayHeatmapColor(bilinearDensity(normalized, sourceX, sourceY));
    const offset = (y * width + x) * 4;
    pixels.data[offset] = Math.round(red);
    pixels.data[offset + 1] = Math.round(green);
    pixels.data[offset + 2] = Math.round(blue);
    pixels.data[offset + 3] = Math.round(alpha * HEATMAP_OPACITY * 255);
  }
  ctx.putImageData(pixels, 0, 0);
}

/** Paint the 96 × 66 display-only interpolation; never use this for contours. */
/**
 * Paint a display-only heatmap. Opacity is a view concern: callers must not
 * feed it back into the native density/CCA path.
 */
export function renderDisplayHeatmap(ctx: CanvasRenderingContext2D, width: number, height: number, display: HeatmapGrid, opacity = HEATMAP_OPACITY): void {
  const pixels = ctx.createImageData(width, height);
  const atDisplay = (row: number, column: number) => display[Math.min(DISPLAY_HEATMAP_ROWS - 1, Math.max(0, row)) * DISPLAY_HEATMAP_COLUMNS + Math.min(DISPLAY_HEATMAP_COLUMNS - 1, Math.max(0, column))] ?? 0;
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const sourceX = -4 + ((x + .5) / width) * 108;
    const sourceY = 100 - ((y + .5) / height) * 100;
    const rawColumn = sourceX / (100 / DISPLAY_HEATMAP_COLUMNS) - .5;
    const rawRow = sourceY / (100 / DISPLAY_HEATMAP_ROWS) - .5;
    const left = Math.floor(rawColumn), top = Math.floor(rawRow);
    const tx = clamp(rawColumn - left, 0, 1), ty = clamp(rawRow - top, 0, 1);
    const upper = atDisplay(top, left) * (1 - tx) + atDisplay(top, left + 1) * tx;
    const lower = atDisplay(top + 1, left) * (1 - tx) + atDisplay(top + 1, left + 1) * tx;
    const [red, green, blue, alpha] = displayHeatmapColor(upper * (1 - ty) + lower * ty);
    const offset = (y * width + x) * 4;
    pixels.data[offset] = Math.round(red); pixels.data[offset + 1] = Math.round(green); pixels.data[offset + 2] = Math.round(blue); pixels.data[offset + 3] = Math.round(alpha * opacity * 255);
  }
  ctx.putImageData(pixels, 0, 0);
}

type Point = readonly [number, number];
const lerp = (from: Point, to: Point, fromValue: number, toValue: number, threshold: number): Point => {
  const amount = fromValue === toValue ? .5 : clamp((threshold - fromValue) / (toValue - fromValue), 0, 1);
  return [from[0] + (to[0] - from[0]) * amount, from[1] + (to[1] - from[1]) * amount];
};

/**
 * Deterministic marching squares over density cell centres.  5/10 saddle cells
 * use their bilinear centre value to pick a stable pairing; equal values pick
 * the outside pairing, avoiding browser-dependent contour islands.
 */
export function marchingSquares(grid: HeatmapGrid, threshold: number): ContourSegment[] {
  if (!(threshold > 0) || !Number.isFinite(threshold)) return [];
  const segments: ContourSegment[] = [];
  const add = (first: Point, second: Point) => segments.push([first[0], first[1], second[0], second[1]]);
  for (let row = 0; row < HEATMAP_ROWS - 1; row += 1) for (let column = 0; column < HEATMAP_COLUMNS - 1; column += 1) {
    const topLeft = at(grid, row, column), topRight = at(grid, row, column + 1), bottomRight = at(grid, row + 1, column + 1), bottomLeft = at(grid, row + 1, column);
    const code = (topLeft >= threshold ? 1 : 0) | (topRight >= threshold ? 2 : 0) | (bottomRight >= threshold ? 4 : 0) | (bottomLeft >= threshold ? 8 : 0);
    if (code === 0 || code === 15) continue;
    const x0 = (column + .5) * (100 / HEATMAP_COLUMNS), x1 = (column + 1.5) * (100 / HEATMAP_COLUMNS);
    const y0 = 100 - (row + .5) * (100 / HEATMAP_ROWS), y1 = 100 - (row + 1.5) * (100 / HEATMAP_ROWS);
    const tl: Point = [x0, y0], tr: Point = [x1, y0], br: Point = [x1, y1], bl: Point = [x0, y1];
    const top = lerp(tl, tr, topLeft, topRight, threshold), right = lerp(tr, br, topRight, bottomRight, threshold), bottom = lerp(bl, br, bottomLeft, bottomRight, threshold), left = lerp(tl, bl, topLeft, bottomLeft, threshold);
    if (code === 5 || code === 10) {
      const centreInside = (topLeft + topRight + bottomRight + bottomLeft) / 4 >= threshold;
      if (code === 5) centreInside ? (add(top, right), add(bottom, left)) : (add(top, left), add(right, bottom));
      else centreInside ? (add(top, left), add(right, bottom)) : (add(top, right), add(bottom, left));
      continue;
    }
    const pairs: Record<number, readonly [Point, Point]> = {
      1: [top, left], 2: [top, right], 3: [left, right], 4: [right, bottom], 6: [top, bottom], 7: [left, bottom],
      8: [bottom, left], 9: [top, bottom], 11: [right, bottom], 12: [left, right], 13: [top, right], 14: [top, left],
    };
    const pair = pairs[code];
    if (pair) add(pair[0], pair[1]);
  }
  return segments;
}
