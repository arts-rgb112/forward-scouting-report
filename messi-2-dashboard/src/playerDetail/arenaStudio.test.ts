import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createArenaStudio, ARENA_STUDIO_VERSION } from "./arenaStudio";
import { FREEFLY_BOUNDS, GLB_PITCH_SURFACE_Y_METERS } from "./pitchWebglGeometry";

describe("arena studio display environment", () => {
  it("uses real concrete receivers and a single shadow light, without the training surround", () => {
    const scene = createArenaStudio();
    expect(scene.name).toBe(ARENA_STUDIO_VERSION);
    const lights: THREE.Light[] = [];
    scene.traverse((object) => { if (object instanceof THREE.Light && object.castShadow) lights.push(object); });
    expect(lights).toHaveLength(1);
    expect(lights[0].name).toBe("studio-daylight");
    expect(scene.getObjectByName("daylight-sky")).toBeUndefined();
    const floor = scene.getObjectByName("studio-floor")!;
    expect(new THREE.Box3().setFromObject(floor).max.y).toBeLessThan(GLB_PITCH_SURFACE_Y_METERS);
    expect((floor as THREE.Mesh).receiveShadow).toBe(true);
  });

  it("keeps enclosing walls outside the existing horizontal camera movement limits", () => {
    const scene = createArenaStudio();
    const bounds = (name: string) => new THREE.Box3().setFromObject(scene.getObjectByName(name)!);
    expect(bounds("studio-left-wall").max.x).toBeLessThan(FREEFLY_BOUNDS.minX);
    expect(bounds("studio-right-wall").min.x).toBeGreaterThan(FREEFLY_BOUNDS.maxX);
    expect(bounds("studio-rear-panel-0").min.z).toBeGreaterThan(FREEFLY_BOUNDS.maxZ);
  });

  it("loads the meadow environment only for full presentation and passes the actual presentation to surface loading", () => {
    const surface = readFileSync("src/playerDetail/pitchSurfaceAssets.ts", "utf8");
    expect(surface).toContain("presentation === 'full' ? [new HDRLoader()");
    expect(surface).toContain("presentation === 'arena' ? createArenaStudio()");
    const renderer = readFileSync("src/playerDetail/WebGLSpatialPitch.tsx", "utf8");
    expect(renderer).toContain("await loadPitchSurfaceAssets(presentation)");
  });
});
