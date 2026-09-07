import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { AERIAL_CAMERA, repairPitchUV, stylePitchMaterial } from './pitchPresentation';
import { clampFreeflyCamera } from './pitchWebglGeometry';

describe('3D presentation', () => {
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
