import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { AERIAL_CAMERA, DAYLIGHT_BACKGROUND, repairPitchUV, stylePitchMaterial } from './pitchPresentation';
import { clampFreeflyCamera } from './pitchWebglGeometry';

describe('3D presentation', () => {
  it('uses a bright daylight background', () => {
    const colour = new THREE.Color(DAYLIGHT_BACKGROUND);
    expect(Math.min(colour.r, colour.g, colour.b)).toBeGreaterThan(.5);
  });
  it('whitens net albedo without replacing alpha cutouts or net geometry', () => {
    const map = new THREE.Texture();
    const material = new THREE.MeshStandardMaterial({ map });
    material.name = 'FencingShader1';
    stylePitchMaterial(material);
    const shader = { fragmentShader: '#include <map_fragment>\n#include <alphatest_fragment>' };
    material.onBeforeCompile(shader as Parameters<typeof material.onBeforeCompile>[0], {} as THREE.WebGLRenderer);
    expect(shader.fragmentShader).toContain('diffuseColor.rgb = vec3(0.92)');
    expect(shader.fragmentShader).toContain('#include <alphatest_fragment>');
    expect(shader.fragmentShader).not.toContain('diffuseColor.a =');
    expect(material.map).toBe(map);
    expect(material.side).toBe(THREE.DoubleSide);
    expect(material.depthWrite).toBe(true);
    material.dispose(); map.dispose();
  });
  it('repairs zero UV footballs without moving vertices, and keeps valid UVs', () => {
    const geometry = new THREE.SphereGeometry(1, 8, 6);
    const original = Array.from(geometry.getAttribute('position').array);
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(geometry.getAttribute('position').count * 2), 2));
    const material = new THREE.MeshStandardMaterial(); material.name = 'FootballShader';
    const mesh = new THREE.Mesh(geometry, material);
    repairPitchUV(mesh);
    expect(Array.from(geometry.getAttribute('position').array)).toEqual(original);
    const uv = geometry.getAttribute('uv');
    expect(new Set(uv.array).size).toBeGreaterThan(5);
    repairPitchUV(mesh); expect(geometry.getAttribute('uv')).toBe(uv);
    geometry.dispose(); material.dispose();
  });
  it('keeps aerial preset within freeflight bounds without a first-input jump', () => {
    expect(clampFreeflyCamera(AERIAL_CAMERA)).toEqual(AERIAL_CAMERA);
  });
  it('preserves maps while correcting grass metal response and net depth', () => {
    const material = new THREE.MeshStandardMaterial({ map: new THREE.Texture() });
    const map = material.map; material.name = 'LightGrassShader';
    stylePitchMaterial(material);
    expect(material.map).toBe(map); expect(material.metalness).toBe(0);
    material.name = 'FencingShader1'; stylePitchMaterial(material);
    expect(material.alphaTest).toBe(.4); expect(material.transparent).toBe(false);
    material.dispose(); map?.dispose();
  });
});
