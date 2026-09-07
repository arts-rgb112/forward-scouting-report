import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { createInfieldStudyMaterial } from './infieldStudy';

describe('local infield material', () => {
  it('gates the PBR fibre response to the distant path without normal tilts', () => {
    const material=createInfieldStudyMaterial(new THREE.MeshPhysicalMaterial(),true,true);
    const shader={vertexShader:'#include <begin_vertex>',fragmentShader:'#include <map_fragment>\n#include <lights_physical_fragment>'};
    material.onBeforeCompile(shader as never,{} as THREE.WebGLRenderer);
    expect(shader.fragmentShader).toContain('#include <lights_physical_fragment>');
    expect(shader.fragmentShader).toContain('material.sheenColor *= distanceBlend');
    expect(shader.fragmentShader).not.toContain('canopyTilt');
    expect(material.customProgramCacheKey()).toBe('infield-study-fibre-v2');
  });
  it('gates broad tone and roughness modulation behind the 18–42m blend', () => {
    const source=new THREE.MeshPhysicalMaterial();
    const near=createInfieldStudyMaterial(source);
    const far=createInfieldStudyMaterial(source,true);
    expect(far.color).toEqual(near.color);
    expect(far.normalScale).toEqual(near.normalScale);
    const shader={vertexShader:'#include <begin_vertex>',fragmentShader:'#include <map_fragment>\n#include <roughnessmap_fragment>'};
    far.onBeforeCompile(shader as never,{} as THREE.WebGLRenderer);
    expect(shader.fragmentShader).toContain('smoothstep(18.0,42.0,turfDistance)');
    expect(shader.fragmentShader).toContain('mix(1.0,distantVariation/variation,distanceBlend)');
    expect(shader.fragmentShader).toContain('roughnessFactor-distanceBlend*');
    expect(far.customProgramCacheKey()).not.toBe(near.customProgramCacheKey());
    for(const distance of [0,.6,8,17.9,18]){
      const t=THREE.MathUtils.smoothstep(distance,18,42);
      expect(t).toBe(0);
    }
  });
  it('borrows original maps without changing the source material', () => {
    const source = new THREE.MeshStandardMaterial({ map:new THREE.Texture(), normalMap:new THREE.Texture(), roughnessMap:new THREE.Texture(), color:0x668844 });
    const color=source.color.clone();
    const candidate=createInfieldStudyMaterial(source);
    expect(candidate).not.toBe(source);
    expect(candidate.map).toBe(source.map);
    expect(candidate.normalMap).toBe(source.normalMap);
    expect(candidate.roughnessMap).toBe(source.roughnessMap);
    expect(source.color).toEqual(color);
    expect(candidate.transparent).toBe(false);
  });
  it('keeps source albedo and roughness hooks with continuous world-space modulation', () => {
    const material=createInfieldStudyMaterial(new THREE.MeshStandardMaterial());
    const shader={vertexShader:'#include <begin_vertex>',fragmentShader:'#include <map_fragment>\n#include <roughnessmap_fragment>'};
    material.onBeforeCompile(shader as never, {} as THREE.WebGLRenderer);
    expect(shader.vertexShader).toContain('modelMatrix*vec4(position,1.0)');
    expect(shader.fragmentShader).toContain('#include <map_fragment>');
    expect(shader.fragmentShader).toContain('diffuseColor.rgb *= variation');
    expect(shader.fragmentShader).toContain('max(0.85, roughnessFactor)');
    expect(material.customProgramCacheKey()).toBe('infield-study-world-grass-v1');
  });
});
