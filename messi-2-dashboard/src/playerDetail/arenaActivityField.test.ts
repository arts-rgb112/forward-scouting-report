import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { createArenaActivityField } from "./arenaActivityField";
import { createArenaTurf } from "./arenaTurf";
import { fullActivityDensityGrid, normalizeDensity, marchingSquares } from "./legacyHeatmap";
import { pitchPercentToWorld } from "./pitchWebglGeometry";

describe("new arena visual language", () => {
  it("has no inherited photographic turf maps", () => {
    const turf = createArenaTurf();
    expect(turf.map).toBeNull();
    expect(turf.normalMap).toBeNull();
    expect(turf.name).toBe("arena-olive-turf-v2");
    expect(turf.roughness).toBeGreaterThan(.9);
    turf.dispose();
  });
  it("accepts only explicitly supplied original maps with bounded tactile relief", () => {
    const map = new THREE.Texture(), bump = new THREE.Texture();
    const turf = createArenaTurf(map, bump);
    expect(turf.map).toBe(map);
    expect(turf.bumpMap).toBe(bump);
    expect(turf.bumpScale).toBe(.018);
    expect(turf.normalMap).toBeNull();
    turf.dispose(); map.dispose(); bump.dispose();
  });
  it("leaves empty density transparent and creates no dot accents", () => {
    const field = createArenaActivityField(Array(704).fill(0));
    const rgba = (field.children[0] as THREE.Mesh).geometry.getAttribute("color");
    for (let i = 0; i < rgba.count; i++) expect(rgba.getW(i)).toBe(0);
    expect(field.children.slice(1).every(child => child instanceof THREE.LineSegments)).toBe(true);
    expect(field.userData.encoding).toBe("within-player-relative-density-display-height");
  });
  it("keeps source counts and contour coordinates unchanged, with only bounded display elevation", () => {
    const counts = Array(704).fill(0); counts[320] = 10;
    const before = [...counts];
    const field = createArenaActivityField(counts);
    expect(counts).toEqual(before);
    const expected = marchingSquares(normalizeDensity(fullActivityDensityGrid(counts)), .5);
    const actual = (field.children[1] as THREE.LineSegments).geometry.getAttribute("position");
    expect(actual.count).toBe(expected.length * 2);
    expected.forEach(([x, y], i) => {
      const world = pitchPercentToWorld({ x, y: 100 - y });
      expect(actual.getX(i * 2)).toBeCloseTo(world.x, 4);
      expect(actual.getZ(i * 2)).toBeCloseTo(world.z, 4);
    });
    const positions = (field.children[0] as THREE.Mesh).geometry.getAttribute("position");
    for (let i = 0; i < positions.count; i++) expect(positions.getY(i)).toBeLessThanOrEqual(.511);
    const rgba = (field.children[0] as THREE.Mesh).geometry.getAttribute("color");
    const alphas = Array.from({ length: rgba.count }, (_, i) => rgba.getW(i));
    expect(Math.max(...alphas)).toBeGreaterThan(.3);
    expect(Math.max(...alphas)).toBeLessThanOrEqual(.421);
    expect(field.children).toHaveLength(4);
  });
});
