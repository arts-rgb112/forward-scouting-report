import { expect,it } from 'vitest';
import * as THREE from 'three';
import { createTurfRelief } from './turfRelief';

it('caps geometry, stays inside the pitch and reproduces world-seeded tufts',()=>{
  const {mesh,update}=createTurfRelief();
  const camera=new THREE.Vector3(29,1.15,43);
  update(camera);
  expect(mesh.count).toBeGreaterThan(0);
  expect(mesh.count).toBeLessThanOrEqual(230400);
  const first=Array.from(mesh.instanceMatrix.array);
  const matrix=new THREE.Matrix4();
  for(let i=0;i<mesh.count;i++){
    mesh.getMatrixAt(i,matrix);
    const p=new THREE.Vector3().setFromMatrixPosition(matrix);
    expect(Math.abs(p.x)).toBeLessThanOrEqual(33.95);
    expect(Math.abs(p.z)).toBeLessThan(52.693);
    expect(p.y).toBeCloseTo(-.027);
  }
  update(camera);
  expect(Array.from(mesh.instanceMatrix.array)).toEqual(first);
  update(new THREE.Vector3(0,91,0));
  expect(mesh.visible).toBe(false);
  mesh.geometry.dispose(); mesh.material.dispose();
});

it('uses short blades and distance collapse without transparent sorting',()=>{
  const {mesh}=createTurfRelief();
  mesh.geometry.computeBoundingBox();
  expect(mesh.geometry.boundingBox!.max.y).toBeLessThan(.04);
  expect(mesh.material.transparent).toBe(false);
  const shader={vertexShader:'#include <begin_vertex>',fragmentShader:'#include <normal_fragment_begin>'};
  mesh.material.onBeforeCompile(shader as never,{} as THREE.WebGLRenderer);
  expect(shader.vertexShader).toContain('smoothstep(8.0,12.0,tuftDistance)');
  mesh.geometry.dispose();mesh.material.dispose();
});
