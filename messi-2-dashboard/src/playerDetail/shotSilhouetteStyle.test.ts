import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { SHOT_SILHOUETTE_FORWARD_AXIS, shotSilhouetteYawRadians, styleShotSilhouette } from "./shotSilhouetteStyle";

describe("recorded anatomical shot highlight", () => {
  it.each([
    [{ x: 0, z: 0 }, { x: 1, z: 0 }, 1, 0],
    [{ x: 0, z: 0 }, { x: -1, z: 0 }, -1, 0],
    [{ x: 0, z: 0 }, { x: 0, z: 1 }, 0, 1],
    [{ x: 0, z: 0 }, { x: 0, z: -1 }, 0, -1],
  ])("maps the authored local +Z front to each recorded planar direction", (from, to, expectedX, expectedZ) => {
    expect(SHOT_SILHOUETTE_FORWARD_AXIS).toBe("+Z");
    const yaw = shotSilhouetteYawRadians(from, to);
    expect(Math.sin(yaw)).toBeCloseTo(expectedX);
    expect(Math.cos(yaw)).toBeCloseTo(expectedZ);
  });

  it("keeps neutral yaw for a recorded point with no planar heading", () => {
    expect(shotSilhouetteYawRadians({ x: 4, z: -2 }, { x: 4, z: -2 })).toBe(0);
    expect(() => shotSilhouetteYawRadians({ x: NaN, z: 0 }, { x: 0, z: 0 })).toThrow(RangeError);
  });

  it.each([
    ["leftFoot", ["left_boot", "left_joint", "left_shin"]],
    ["rightFoot", ["right_boot", "right_joint", "right_shin"]],
    ["head", ["head"]],
    ["unknown", []],
    ["other", []],
  ] as const)("colors only authored %s meshes", (part, expected) => {
    const figure = new THREE.Group();
    const source = new THREE.MeshStandardMaterial({ color: 0xffffff });
    const names = ["head", "shirt", "left_boot", "left_joint", "left_shin", "right_boot", "right_joint", "right_shin"];
    for (const name of names) {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(), source);
      mesh.name = name;
      figure.add(mesh);
    }
    figure.rotation.y = Math.PI; // Camera/view orientation cannot swap sides.
    styleShotSilhouette(figure, part);
    const highlighted: string[] = [];
    figure.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      const material = object.material as THREE.MeshStandardMaterial;
      if (material.color.getHex() === 0xf16d78) highlighted.push(object.name);
      if (expected.some(name => name === object.name)) {
        expect(material).toBeInstanceOf(THREE.MeshBasicMaterial);
        expect(material.toneMapped).toBe(false);
      }
      expect(material.opacity).toBe(1);
      expect(material).not.toBe(source);
    });
    expect(highlighted.sort()).toEqual([...expected].sort());
    expect(source.color.getHex()).toBe(0xffffff);
  });
});
