import * as THREE from "three";
import { GLB_PITCH_WIDTH_METERS, GLB_PITCH_SURFACE_Y_METERS } from "./pitchWebglGeometry";
import { type WebglDensityDot } from "./webglDotMatrix";
import { bilinearDensity, fullActivityDensityGrid, normalizeDensity } from "./legacyHeatmap";
import { pitchPercentToWorld } from "./pitchWebglGeometry";

export const GROUND_COLUMNS = 192;
export const GROUND_ROWS = 124;

/** Within-player peak-normalized display palette, not cross-player activity volume. */
export function groundDensityColor(density: number): [number, number, number] {
  const d = Number.isFinite(density) ? THREE.MathUtils.clamp(density, 0, 1) : 0;
  const warm = THREE.MathUtils.clamp((d - .4) / .4, 0, 1);
  const orange = THREE.MathUtils.smoothstep(d, .8, 1);
  return [49 + 204 * warm + 1 * orange, 224 + 13 * warm - 112 * orange, 220 - 165 * warm - 23 * orange];
}

/** Continuous display interpolation, not additional observations or control probability. */
export function continuousGroundGeometry(counts: readonly number[]) {
  const grid = normalizeDensity(fullActivityDensityGrid(counts));
  const positions: number[] = [], colors: number[] = [], indices: number[] = [];
  for (let row = 0; row <= GROUND_ROWS; row++) for (let column = 0; column <= GROUND_COLUMNS; column++) {
    const x = column / GROUND_COLUMNS * 100, y = row / GROUND_ROWS * 100;
    const density = bilinearDensity(grid, x, y);
    const rgb = groundDensityColor(density);
    const color = new THREE.Color().setRGB(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255, THREE.SRGBColorSpace);
    const strength = THREE.MathUtils.clamp((density - .035) / .965, 0, 1);
    const world = pitchPercentToWorld({ x, y }, GLB_PITCH_SURFACE_Y_METERS + .008);
    positions.push(world.x, world.y, world.z);
    colors.push(color.r, color.g, color.b, .62 * Math.pow(strength, .65));
    if (row < GROUND_ROWS && column < GROUND_COLUMNS) {
      const a = row * (GROUND_COLUMNS + 1) + column, b = a + GROUND_COLUMNS + 1;
      indices.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 4));
  geometry.setIndex(indices);
  return geometry;
}

export function createContinuousGroundHeatmap(counts: readonly number[]) {
  const mesh = new THREE.Mesh(continuousGroundGeometry(counts), new THREE.MeshBasicMaterial({
    vertexColors: true, transparent: true, depthTest: true, depthWrite: false,
    toneMapped: false, side: THREE.DoubleSide,
    polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
  }));
  mesh.name = "continuous-ground-density";
  mesh.renderOrder = 2;
  return mesh;
}

export function highDensityAccents(dots: readonly WebglDensityDot[]): WebglDensityDot[] {
  return dots.filter(dot => dot.density >= .65 && dot.column % 2 === 0 && dot.row % 2 === 0)
    .map(dot => ({ ...dot, radiusMeters: .085, color: [dot.color[0], dot.color[1], dot.color[2], .45] }));
}
/** View interpolation only. More samples do not imply more observed coordinates. */
export function buildGroundDensityDots(counts: readonly number[]): WebglDensityDot[] {
  const grid = normalizeDensity(fullActivityDensityGrid(counts));
  const dots: WebglDensityDot[] = [];
  for (let row = 0; row < GROUND_ROWS; row++) for (let column = 0; column < GROUND_COLUMNS; column++) {
    const x = (column + .5) / GROUND_COLUMNS * 100;
    const y = (row + .5) / GROUND_ROWS * 100;
    const density = bilinearDensity(grid, x, y);
    if (density <= .05) continue;
    const strength = (density - .05) / .95;
    const rgb = groundDensityColor(density);
    dots.push({ row, column, density,
      radiusMeters: .245 * Math.pow(strength, .48),
      world: pitchPercentToWorld({ x, y }, GLB_PITCH_SURFACE_Y_METERS + .012),
      color: [...rgb, .18 + .8 * Math.sqrt(strength)],
    });
  }
  return dots;
}

/** Display-only geometry: source density, filtering and RGBA remain untouched. */
export function groundHeatmapGeometry(dots: readonly WebglDensityDot[]) {
  const positions: number[] = [];
  const colors: number[] = [];
  const normals: number[] = [];
  const y = GLB_PITCH_SURFACE_Y_METERS + .012;
  for (const dot of dots) {
      const x = dot.world.x, z = dot.world.z, radius = dot.radiusMeters;
      const color = new THREE.Color().setRGB(dot.color[0] / 255, dot.color[1] / 255, dot.color[2] / 255, THREE.SRGBColorSpace);
      for (let segment = 0; segment < 12; segment++) {
        const a = segment / 12 * Math.PI * 2, b = (segment + 1) / 12 * Math.PI * 2;
        for (const [dx, dz] of [[0, 0], [Math.cos(b) * radius, Math.sin(b) * radius], [Math.cos(a) * radius, Math.sin(a) * radius]]) {
          positions.push(x + dx, y, z + dz);
          normals.push(0, 1, 0);
          colors.push(color.r, color.g, color.b, dot.color[3]);
        }
      }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 4));
  return geometry;
}

export function createGroundHeatmap(dots: readonly WebglDensityDot[]) {
  // Analytical colours must not change with exposure or lights; pitch and balls remain PBR.
  const material = new THREE.MeshBasicMaterial({
    toneMapped: false,
    vertexColors: true, transparent: true, depthTest: true, depthWrite: false,
    polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(groundHeatmapGeometry(dots), material);
  mesh.name = "ground-density-dots-192x124";
  mesh.renderOrder = 2;
  return mesh;
}

/** Soccerlab custom four strips, not an official tactical zoning standard. */
export function penaltyStripBoundaries() {
  const penaltyWidth = 40.32;
  const goalAreaWidth = 18.32;
  return [-penaltyWidth / 2, -goalAreaWidth / 2, 0, goalAreaWidth / 2, penaltyWidth / 2]
    .map((metres) => (metres / GLB_PITCH_WIDTH_METERS + .5) * 100);
}
