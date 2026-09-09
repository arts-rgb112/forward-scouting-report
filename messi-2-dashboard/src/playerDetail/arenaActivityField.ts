import * as THREE from "three";
import { bilinearDensity, fullActivityDensityGrid, marchingSquares, normalizeDensity } from "./legacyHeatmap";
import { pitchPercentToWorld } from "./pitchWebglGeometry";

/** Relative activity only: height is a display encoding, not ball/player altitude.
 * Retains the existing smoothing and per-player normalization, with no CCA change. */
export function createArenaActivityField(counts: readonly number[]) {
  const grid = normalizeDensity(fullActivityDensityGrid(counts));
  const root = new THREE.Group();
  root.name = "arena-relative-activity-field";
  root.userData.encoding = "within-player-relative-density-display-height";
  const positions: number[] = [], colors: number[] = [], indices: number[] = [];
  const columns = 96, rows = 64;
  const height = (density: number) => .06 + density * .22;
  const tint = new THREE.Color("#c9d2c6");
  for (let row = 0; row <= rows; row++) for (let column = 0; column <= columns; column++) {
    const x = column / columns * 100, y = row / rows * 100;
    const density = bilinearDensity(grid, x, y);
    const world = pitchPercentToWorld({ x, y }, height(density));
    positions.push(world.x, world.y, world.z);
    colors.push(tint.r, tint.g, tint.b, .16 * density * density);
    if (row < rows && column < columns) {
      const a = row * (columns + 1) + column, b = a + columns + 1;
      indices.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 4));
  geometry.setIndex(indices);
  const surface = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, side: THREE.DoubleSide, toneMapped: false }));
  surface.renderOrder = 2;
  root.add(surface);
  for (const threshold of [.3, .5, .7, .9]) {
    const points: THREE.Vector3[] = [];
    for (const [x1, y1, x2, y2] of marchingSquares(grid, threshold)) {
      // marchingSquares outputs SVG-oriented Y; restore provider orientation.
      for (const [x, y] of [[x1, y1], [x2, y2]]) {
        const p = pitchPercentToWorld({ x, y: 100 - y }, height(threshold) + .004);
        points.push(new THREE.Vector3(p.x, p.y, p.z));
      }
    }
    const contour = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(points), new THREE.LineBasicMaterial({ color: "#c9d2c6", transparent: true, opacity: .16 + threshold * .32, depthWrite: false, toneMapped: false }));
    contour.name = `relative-density-${threshold}`;
    contour.renderOrder = 3;
    root.add(contour);
  }
  return root;
}
