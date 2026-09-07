import { expect, it } from 'vitest';
import * as THREE from 'three';
import { applyNaturalTurf, createPitchSurround } from './turfMaterial';

it('preserves asset colour, normal and roughness maps without a procedural shader override', () => {
  const map = new THREE.Texture(), normalMap = new THREE.Texture(), roughnessMap = new THREE.Texture();
  const m = new THREE.MeshStandardMaterial({ map, normalMap, roughnessMap });
  m.onBeforeCompile = shader => { shader.fragmentShader = 'old procedural override'; };
  applyNaturalTurf(m);
  const shader = { vertexShader: '#include <begin_vertex>', fragmentShader: '#include <map_fragment>' };
  m.onBeforeCompile(shader as Parameters<typeof m.onBeforeCompile>[0], {} as THREE.WebGLRenderer);
  expect(shader.fragmentShader).toBe('#include <map_fragment>');
  expect(shader.vertexShader).toBe('#include <begin_vertex>');
  expect(m.map).toBe(map); expect(m.normalMap).toBe(normalMap); expect(m.roughnessMap).toBe(roughnessMap);
  expect(m.color.getHex()).toBe(0xffffff);
  expect(m.normalScale.x).toBeGreaterThan(0); expect(m.normalScale.y).toBeGreaterThan(0);
  expect(m.metalness).toBe(0); expect(map.anisotropy).toBe(8);
  m.dispose(); map.dispose(); normalMap.dispose(); roughnessMap.dispose();
});

it('bounds shiny exported roughness while keeping albedo and normal sampling intact', () => {
  const m = new THREE.MeshPhysicalMaterial();
  applyNaturalTurf(m);
  const shader = { fragmentShader: '#include <map_fragment>\n#include <roughnessmap_fragment>\n#include <normal_fragment_maps>' };
  m.onBeforeCompile(shader as Parameters<typeof m.onBeforeCompile>[0], {} as THREE.WebGLRenderer);
  expect(shader.fragmentShader).toContain('roughnessFactor = max(0.85, roughnessFactor)');
  expect(shader.fragmentShader).toContain('#include <normal_fragment_maps>');
  expect(shader.fragmentShader).not.toContain('diffuseColor');
  expect(m.specularIntensity).toBe(.25);
  m.dispose();
});

it('places apron below pitch and fence posts outside both touchlines', () => {
  const scene = createPitchSurround();
  const apron = scene.children.find(o => o instanceof THREE.Mesh && o.geometry instanceof THREE.PlaneGeometry)!;
  expect(apron.position.y).toBeLessThan(-.027);
  for (const object of scene.children) {
    if (object instanceof THREE.Mesh && object.geometry instanceof THREE.CylinderGeometry) expect(Math.abs(object.position.x) >= 43 || Math.abs(object.position.z) >= 65).toBe(true);
  }
  scene.traverse(o => { if (o instanceof THREE.Mesh || o instanceof THREE.Line) { o.geometry.dispose(); (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => m.dispose()); } });
});
