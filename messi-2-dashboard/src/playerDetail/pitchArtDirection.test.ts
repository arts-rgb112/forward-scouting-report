import { expect, it } from 'vitest';
import * as THREE from 'three';
import { createDesignSurround } from './pitchArtDirection';

it('leaves the pitch interior empty and uses no rejected low-poly vegetation', () => {
  const scene = createDesignSurround();
  expect(scene.getObjectByName('daylight-sky')?.visible).toBe(false);
  expect(scene.getObjectByName('tree-canopies')).toBeUndefined();
  expect(scene.getObjectByName('tree-trunks')).toBeUndefined();
  for (const object of scene.children) {
    if (!(object instanceof THREE.Mesh)) continue;
    if (object.geometry instanceof THREE.CylinderGeometry || object.geometry instanceof THREE.BoxGeometry) {
      expect(Math.abs(object.position.x) >= 43 || Math.abs(object.position.z) >= 65).toBe(true);
    }
  }
  scene.traverse(o => {
    if (o instanceof THREE.Mesh || o instanceof THREE.Line) {
      o.geometry.dispose();
      (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => m.dispose());
    }
  });
});
