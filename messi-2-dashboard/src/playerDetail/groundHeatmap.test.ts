import { describe, expect, it } from "vitest";
import { Color, SRGBColorSpace } from "three";
import { buildGroundDensityDots, createGroundHeatmap, continuousGroundGeometry, highDensityAccents, groundDensityColor, groundHeatmapGeometry, penaltyStripBoundaries } from "./groundHeatmap";
import { GLB_PITCH_SURFACE_Y_METERS, GLB_PITCH_WIDTH_METERS } from "./pitchWebglGeometry";

describe("ground density rendering", () => {
  const source = Array(32 * 22).fill(0); source[320] = 10;
  const dots = buildGroundDensityDots(source);
  it("adds orange only above normalized .8 with a continuous shared palette", () => {
    expect(groundDensityColor(0)).toEqual([49, 224, 220]);
    expect(groundDensityColor(.8)).toEqual([253, 237, 55]);
    expect(groundDensityColor(1)).toEqual([254, 125, 32]);
    expect(groundDensityColor(2)).toEqual(groundDensityColor(1));
    expect(groundDensityColor(NaN)).toEqual(groundDensityColor(0));
    const before = groundDensityColor(.8 - .000001), after = groundDensityColor(.8 + .000001);
    before.forEach((channel, i) => expect(Math.abs(channel - after[i])).toBeLessThan(.001));
  });
  it("keeps empty continuous surface transparent and interpolation within the pitch", () => {
    const empty = continuousGroundGeometry(Array(704).fill(0));
    const colors = empty.getAttribute("color");
    expect(colors.count).toBe(193 * 125);
    for (let i = 0; i < colors.count; i++) expect(colors.getW(i)).toBe(0);
    const populated = continuousGroundGeometry(source);
    const rgba = populated.getAttribute("color");
    let peak = 0;
    for (let i = 0; i < rgba.count; i++) peak = Math.max(peak, rgba.getW(i));
    expect(peak).toBeGreaterThan(.4);
    expect(peak).toBeLessThanOrEqual(.620001);
    empty.dispose(); populated.dispose();
  });
  it("uses sparse accents only at high density without changing source dots", () => {
    const before = JSON.stringify(dots);
    const accents = highDensityAccents(dots);
    expect(accents.length).toBeGreaterThan(0);
    expect(accents.length).toBeLessThan(dots.length / 4);
    expect(accents.every(dot => dot.density >= .65 && dot.radiusMeters === .085)).toBe(true);
    expect(JSON.stringify(dots)).toBe(before);
  });
  it("preserves source RGBA, centres, cell count and density inputs", () => {
    const before = JSON.stringify(dots);
    const geometry = groundHeatmapGeometry(dots);
    const positions = geometry.getAttribute("position");
    const colors = geometry.getAttribute("color");
    const verticesPerCell = 12 * 3;
    expect(positions.count).toBe(dots.length * verticesPerCell);
    dots.forEach((dot, i) => {
      const center = i * verticesPerCell;
      const expected = new Color().setRGB(dot.color[0] / 255, dot.color[1] / 255, dot.color[2] / 255, SRGBColorSpace);
      expect(positions.getX(center)).toBeCloseTo(dot.world.x, 4);
      expect(positions.getZ(center)).toBeCloseTo(dot.world.z, 4);
      expect(colors.getX(center)).toBeCloseTo(expected.r);
      expect(colors.getY(center)).toBeCloseTo(expected.g);
      expect(colors.getZ(center)).toBeCloseTo(expected.b);
      expect(colors.getW(center)).toBeCloseTo(dot.color[3]);
      expect(positions.getY(center) - GLB_PITCH_SURFACE_Y_METERS).toBeCloseTo(.012);
    });
    expect(JSON.stringify(dots)).toBe(before);
    geometry.dispose();
  });
  it("keeps analytic colours independent of light and exposure on depth-tested ground", () => {
    const mesh = createGroundHeatmap(dots);
    expect(mesh.isMesh).toBe(true);
    expect(mesh.material.isMeshBasicMaterial).toBe(true);
    expect(mesh.material.toneMapped).toBe(false);
    expect(mesh.material.depthTest).toBe(true);
    expect(mesh.material.depthWrite).toBe(false);
    expect(mesh.material.polygonOffset).toBe(true);
    mesh.geometry.dispose(); mesh.material.dispose();
  });
  it("interpolates actual density rather than repeating nine equal dots and preserves empty space", () => {
    const before = [...source];
    expect(buildGroundDensityDots(Array(704).fill(0))).toHaveLength(0);
    expect(new Set(dots.map(dot => dot.density.toFixed(5))).size).toBeGreaterThan(50);
    expect(dots.length).toBeLessThan(192 * 124 / 2);
    expect(dots.every(dot => dot.radiusMeters > 0 && dot.radiusMeters <= .245)).toBe(true);
    expect(source).toEqual(before);
  });
  it("derives symmetric custom penalty strips in metres", () => {
    const edges = penaltyStripBoundaries();
    expect(edges[2]).toBe(50);
    expect(edges[0] + edges[4]).toBeCloseTo(100);
    expect(edges[1] + edges[3]).toBeCloseTo(100);
    expect((edges[1] - edges[0]) * GLB_PITCH_WIDTH_METERS / 100).toBeCloseTo(11);
    expect((edges[2] - edges[1]) * GLB_PITCH_WIDTH_METERS / 100).toBeCloseTo(9.16);
  });
});
