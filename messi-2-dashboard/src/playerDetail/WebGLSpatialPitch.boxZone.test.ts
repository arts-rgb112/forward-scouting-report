// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { addBoxZoneHitMeshes, addZoneHitMeshes } from "./WebGLSpatialPitch";
import { pitchPercentToWorld, worldToPitchPercent } from "./pitchWebglGeometry";
import { resolveBoxSubregionId, BOX_SUBREGION_X_MIN_INCLUSIVE } from "../api/boxSubregionContracts";

/**
 * Independent review (1788840101.320959, then 1788842156.254879) found two
 * real defects in the raw 3D ray hit, both proven here against the actual
 * production `addBoxZoneHitMeshes` with a real THREE.Raycaster — never a
 * parallel formula:
 *
 * 1. Four separate coplanar meshes sharing an edge (y=37/50/63) could
 *    resolve to either side depending on which one the raycaster happened
 *    to report closest — the fix (already independently verified good) is
 *    that the FINAL region id always comes from the analytic half-open
 *    resolver at the real hit point, never from mesh identity.
 * 2. A ray at the box's exact x=84.29 boundary could report NO hit at all
 *    against a mesh whose edge sat exactly there (float32 vertex rounding),
 *    so the shared resolver above never even ran. The fix is a single
 *    combined hit surface whose near edge sits a safety margin BELOW 84.29
 *    (see `BOX_HIT_SURFACE_MARGIN`) — hit ACQUISITION now reliably includes
 *    the exact boundary, while region CLASSIFICATION still runs through the
 *    same exact analytic resolver, so a hit inside that safety margin (e.g.
 *    x=84.28) correctly resolves to no region at all, never a fabricated one.
 */
function castDownAt(root: THREE.Group, x: number, y: number) {
  const target = pitchPercentToWorld({ x, y }, 0);
  const origin = new THREE.Vector3(target.x, 50, target.z);
  const raycaster = new THREE.Raycaster(origin, new THREE.Vector3(0, -1, 0));
  return raycaster.intersectObjects(root.children, false)[0];
}

describe("box-region 3D ray hit — real THREE.Raycaster against the real production hit surface", () => {
  const root = new THREE.Group();
  addBoxZoneHitMeshes(root);
  // Production only raycasts after `runtime.render()` has traversed the
  // scene, which is what actually updates the mesh's matrixWorld from the
  // position/rotation set directly on it. Outside that render loop the
  // matrix stays at its identity default, so this must be forced explicitly.
  root.updateMatrixWorld(true);

  it("builds exactly one combined hit surface — no internal seams for a ray to fall between", () => {
    expect(root.children).toHaveLength(1);
    expect(root.children[0].userData.isBoxHitSurface).toBe(true);
  });

  it("resolves the exact half-open region at every shared y boundary (37/50/63), never the wrong adjacent side", () => {
    const cases: [number, string][] = [
      [63, "L4"], // >= 63 is L4, not L3L
      [62.999, "L3L"],
      [50, "L3L"], // >= 50 is L3L, not L3R
      [49.999, "L3R"],
      [37, "L3R"], // >= 37 is L3R, not L2
      [36.999, "L2"],
    ];
    for (const [y, expected] of cases) {
      const hit = castDownAt(root, 92, y);
      expect(hit).toBeDefined();
      const point = worldToPitchPercent(hit!.point);
      expect(resolveBoxSubregionId(point.x, point.y)).toBe(expected);
    }
  });

  it("acquires a real hit at the exact x=84.29 boundary (the actual production bug), and classifies it correctly", () => {
    expect(BOX_SUBREGION_X_MIN_INCLUSIVE).toBe(84.29);
    const hit = castDownAt(root, 84.29, 50);
    expect(hit).toBeDefined(); // this used to be `undefined` against the old per-region mesh edge
    const point = worldToPitchPercent(hit!.point);
    expect(resolveBoxSubregionId(point.x, point.y)).toBe("L3L");
  });

  it("still classifies a point just past the boundary as a real region, and one just short of it as none at all", () => {
    const inside = castDownAt(root, 84.3, 50);
    expect(inside).toBeDefined();
    const insidePoint = worldToPitchPercent(inside!.point);
    expect(resolveBoxSubregionId(insidePoint.x, insidePoint.y)).toBe("L3L");

    // 84.28 sits inside the hit surface's safety margin (acquisition
    // succeeds — that's the point) but must still resolve to no region at
    // all, exactly the original half-open boundary, never a fabricated one.
    const dead = castDownAt(root, 84.28, 50);
    expect(dead).toBeDefined();
    const deadPoint = worldToPitchPercent(dead!.point);
    expect(resolveBoxSubregionId(deadPoint.x, deadPoint.y)).toBeNull();
  });

  it("never hits the box surface at all once safely past its margin", () => {
    expect(castDownAt(root, 83.5, 50)).toBeUndefined();
  });

  it("the resolver used by both 2D and 3D returns null outside the box entirely", () => {
    expect(resolveBoxSubregionId(50, 50)).toBeNull(); // well inside the pitch, outside the box
    expect(resolveBoxSubregionId(90, 10)).toBeNull(); // inside box's x range but outside every region's y band
  });
});

/**
 * Independent review (1788851444.721799) found that the elevated box hit
 * surface, being the closest intersection wherever it overlaps the legacy
 * 30-zone mesh below it, silently swallowed legacy hover across its own
 * acquisition margin (x∈[83.79,84.29)): the box surface was hit, resolved to
 * no region, but carries no `zoneKey`, so looking at only the CLOSEST hit
 * lost the real legacy zone underneath. This exercises the actual combined
 * production layering (both real hit surfaces together, exactly as
 * `runtime.zoneHitRoot` holds them) and the same full-intersection-list
 * selection algorithm the component uses, proving 84.28 still resolves to
 * the legacy zone while 84.29 resolves to the box.
 */
function resolveHoverSelection(root: THREE.Group, x: number, y: number) {
  const target = pitchPercentToWorld({ x, y }, 0);
  const origin = new THREE.Vector3(target.x, 50, target.z);
  const raycaster = new THREE.Raycaster(origin, new THREE.Vector3(0, -1, 0));
  const hits = raycaster.intersectObjects(root.children, false);
  const boxHit = hits.find((candidate) => candidate.object.userData.isBoxHitSurface === true);
  const boxPoint = boxHit ? worldToPitchPercent(boxHit.point) : null;
  const boxRegionId = boxPoint ? resolveBoxSubregionId(boxPoint.x, boxPoint.y) : null;
  if (boxRegionId) return { kind: "box" as const, id: boxRegionId };
  const zoneHit = hits.find((candidate) => typeof candidate.object.userData.zoneKey === "string");
  return zoneHit ? { kind: "legacy" as const, zoneKey: zoneHit.object.userData.zoneKey as string } : { kind: "none" as const };
}

describe("combined box + legacy hit layering — the actual production selection algorithm", () => {
  const root = new THREE.Group();
  // The real depth-5/lane-2 cell (x:[83.33,100], y:[37,63]) is exactly the
  // legacy zone the box's own acquisition margin (x∈[83.79,84.29)) overlaps.
  addZoneHitMeshes(root, [{
    cell: { depth: 5, lane: 2, occupancyPct: 10 },
    summary: { shots: 0, goals: 0, xg: 0, shotSharePct: 0 },
    point: { x: (83.33 + 100) / 2, y: (37 + 63) / 2 },
  }]);
  addBoxZoneHitMeshes(root);
  root.updateMatrixWorld(true);

  it("84.28 (inside the box's acquisition margin, outside the real box) still resolves to the legacy zone underneath, not nothing", () => {
    expect(resolveHoverSelection(root, 84.28, 50)).toEqual({ kind: "legacy", zoneKey: "5-2" });
  });

  it("84.29 (the real box boundary) resolves to the box region, not the legacy zone", () => {
    expect(resolveHoverSelection(root, 84.29, 50)).toEqual({ kind: "box", id: "L3L" });
  });

  it("83.5 (safely outside the box's margin entirely) still resolves to the legacy zone", () => {
    expect(resolveHoverSelection(root, 83.5, 50)).toEqual({ kind: "legacy", zoneKey: "5-2" });
  });
});
