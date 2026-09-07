import * as THREE from 'three';
import { createPitchSurround } from './turfMaterial';

/** Local study only: photographic HDRI supplies the distant landscape, not fake tree meshes. */
export function createDesignSurround() {
  const group = createPitchSurround();
  group.name = 'empty-pitch-art-direction';
  group.getObjectByName('daylight-sky')!.visible = false;
  for (const x of [-46, 46]) for (const z of [-60, 60]) {
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(.11, .2, 20, 8), new THREE.MeshStandardMaterial({ color: '#65706c', roughness: .7 }));
    pole.position.set(x, 10, z); group.add(pole);
    const lamp = new THREE.Mesh(new THREE.BoxGeometry(2.4, .65, .4), new THREE.MeshStandardMaterial({ color: '#acb7b5', roughness: .7 }));
    lamp.position.set(x, 20, z); group.add(lamp);
  }
  return group;
}
