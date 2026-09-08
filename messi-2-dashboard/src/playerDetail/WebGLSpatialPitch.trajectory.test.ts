// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { addShots, excludeReplayingShot, ShotTrajectoryCurve } from "./WebGLSpatialPitch";
import { trajectoryArcPoint } from "./pitchWebglGeometry";
import type { ShotmapPoint } from "../dashboard/types";

const trajectory = (endY: number, endZMeters: number) =>
  ({ schemaVersion: "shotmap-trajectory-v1" as const, endpointKind: "goal_mouth" as const, endX: 100, endY, endZMeters, source: "fotmob" as const });

const TOLERANCE_M = 0.01; // the bound requested in review

describe("ShotTrajectoryCurve + real TubeGeometry — the mesh itself lands on the analytic curve", () => {
  const start = { x: 87, y: 48 };
  const curve = new ShotTrajectoryCurve(start, 51, 0.06);

  it("ring centres match the curve at arc-length-mapped t, not raw i/tubularSegments — TubeGeometry samples via getPointAt internally", () => {
    // three's TubeGeometry.generateSegment() calls path.getPointAt(i/tubularSegments),
    // and the base Curve's getPointAt maps that fraction through getUtoTmapping
    // (numeric arc-length integration) before calling getPoint. A test that
    // compares getPoint(i/tubularSegments) directly — uniform t — would silently
    // pass or fail for the wrong reason whenever arc length isn't ~linear in t.
    const tubularSegments = 64, radialSegments = 6;
    const geometry = new THREE.TubeGeometry(curve, tubularSegments, 0.025, radialSegments, false);
    const position = geometry.getAttribute("position");
    const stride = radialSegments + 1; // TubeGeometry duplicates the seam vertex (j=0 and j=radialSegments coincide)
    for (const i of [0, 12, 27, 40, 55, tubularSegments]) {
      let sx = 0, sy = 0, sz = 0;
      for (let j = 0; j < radialSegments; j++) { // average the distinct ring vertices only — drop the duplicate seam
        const idx = i * stride + j;
        sx += position.getX(idx); sy += position.getY(idx); sz += position.getZ(idx);
      }
      const center = { x: sx / radialSegments, y: sy / radialSegments, z: sz / radialSegments };
      const t = curve.getUtoTmapping(i / tubularSegments); // exactly what the geometry itself used
      const expected = trajectoryArcPoint(start, 51, 0.06, t);
      const deviation = Math.hypot(center.x - expected.x, center.y - expected.y, center.z - expected.z);
      expect(deviation).toBeLessThanOrEqual(TOLERANCE_M);
    }
  });

  it("preserves the exact endpoint even when endZMeters is 0, not just the previously-tested 0.06", () => {
    const zero = new ShotTrajectoryCurve(start, 51, 0);
    const end = zero.getPoint(1);
    const expected = trajectoryArcPoint(start, 51, 0, 1);
    expect(end.toArray()).toEqual([expected.x, expected.y, expected.z]);
  });
});

describe("addShots — the real static THREE.Line geometry, not a self-comparison", () => {
  const layers = { heatmap: false, cca: false, trajectories: true, markers: false };

  function buildLine(start: { x: number; y: number }, endY: number, endZMeters: number) {
    const shot: ShotmapPoint = { x: start.x, y: start.y, outcome: "goal", trajectory: trajectory(endY, endZMeters) };
    const root = new THREE.Group();
    addShots(root, [], [{ shot }], null, layers, new Map());
    const found = root.children.find((child): child is THREE.Line => child instanceof THREE.Line);
    if (!found) throw new Error("addShots drew no line for an eligible trajectory");
    return found;
  }

  it("keeps every chord midpoint within tolerance of the analytic curve, across the longest/shortest/highest/ground-level shots", () => {
    const cases: { start: { x: number; y: number }; endY: number; endZMeters: number }[] = [
      { start: { x: 5, y: 50 }, endY: 51, endZMeters: 0.06 },   // longest run to goal
      { start: { x: 97, y: 50 }, endY: 49, endZMeters: 1.5 },   // shortest
      { start: { x: 60, y: 45 }, endY: 53, endZMeters: 0 },     // ground-level endpoint
      { start: { x: 70, y: 55 }, endY: 47, endZMeters: 2.3 },   // near-crossbar endpoint
    ];
    for (const { start, endY, endZMeters } of cases) {
      const line = buildLine(start, endY, endZMeters);
      const position = line.geometry.getAttribute("position");
      const segments = position.count - 1; // trajectoryWorldPoints' current sampling
      let maxDeviation = 0;
      for (let i = 0; i < segments; i++) {
        const midChord = {
          x: (position.getX(i) + position.getX(i + 1)) / 2,
          y: (position.getY(i) + position.getY(i + 1)) / 2,
          z: (position.getZ(i) + position.getZ(i + 1)) / 2,
        };
        const tMid = (i + 0.5) / segments; // the polyline's actual parametrisation, not an assumed one
        const expected = trajectoryArcPoint(start, endY, endZMeters, tMid);
        maxDeviation = Math.max(maxDeviation, Math.hypot(midChord.x - expected.x, midChord.y - expected.y, midChord.z - expected.z));
      }
      // The current 24-segment sampling is expected to clear this bound; if a
      // future change to the curve or segment count breaks it, this must fail
      // rather than being quietly widened.
      expect(maxDeviation).toBeLessThanOrEqual(TOLERANCE_M);
    }
  });
});

describe("excludeReplayingShot + addShots — the actual production selection, not a re-implementation of it", () => {
  const layers = { heatmap: false, cca: false, trajectories: true, markers: false };
  const sharedCoordinate = { x: 89.5, y: 50 }; // ten real Kane goals land on this exact spot in production data
  const replaying = { shot: { x: sharedCoordinate.x, y: sharedCoordinate.y, outcome: "goal" as const, trajectory: trajectory(51, 0.2) }, sourceIndex: 5 };
  const sibling = { shot: { x: sharedCoordinate.x, y: sharedCoordinate.y, outcome: "goal" as const, trajectory: trajectory(48, 0.4) }, sourceIndex: 10 };
  const unrelated = { shot: { x: 92, y: 55, outcome: "on_target" as const, trajectory: trajectory(53, 0.1) }, sourceIndex: 40 };

  it("drops exactly the replaying raw event and keeps the same-origin sibling and the unrelated shot, each at its own endpoint", () => {
    const framedShots = [replaying, sibling, unrelated];
    const selected = excludeReplayingShot(framedShots, replaying.sourceIndex); // the exact call production makes
    expect(selected).toEqual([sibling, unrelated]);

    const root = new THREE.Group();
    addShots(root, [], selected, null, layers, new Map());
    const lines = root.children.filter((child): child is THREE.Line => child instanceof THREE.Line);
    expect(lines).toHaveLength(2);

    const endpoints = lines.map((l) => {
      const position = l.geometry.getAttribute("position");
      const last = position.count - 1;
      return { x: position.getX(last), y: position.getY(last), z: position.getZ(last) };
    });
    const expectedSibling = trajectoryArcPoint(sharedCoordinate, 48, 0.4, 1);
    const expectedUnrelated = trajectoryArcPoint({ x: 92, y: 55 }, 53, 0.1, 1);
    // BufferGeometry stores Float32Array, so compare at float32 precision
    // (~1e-6 relative) rather than double precision — still far tighter than
    // the 0.01m bound this test exists to enforce.
    expect(endpoints).toContainEqual(expect.objectContaining({
      x: expect.closeTo(expectedSibling.x, 3), y: expect.closeTo(expectedSibling.y, 3), z: expect.closeTo(expectedSibling.z, 3),
    }));
    expect(endpoints).toContainEqual(expect.objectContaining({
      x: expect.closeTo(expectedUnrelated.x, 3), y: expect.closeTo(expectedUnrelated.y, 3), z: expect.closeTo(expectedUnrelated.z, 3),
    }));
  });
});
