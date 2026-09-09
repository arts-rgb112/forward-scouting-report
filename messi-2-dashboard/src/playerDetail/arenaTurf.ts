import * as THREE from "three";

/** New arena-only procedural turf. No photographic tile or meadow dependency. */
export function createArenaTurf() {
  const material = new THREE.MeshStandardMaterial({ color: "#454c32", roughness: .96, metalness: 0 });
  material.name = "arena-olive-turf-v1";
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader.replace("#include <common>", "#include <common>\nvarying vec3 turfWorld;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nturfWorld=(modelMatrix*vec4(position,1.0)).xyz;");
    shader.fragmentShader = shader.fragmentShader.replace("#include <common>", `#include <common>
      varying vec3 turfWorld;
      float turfHash(vec2 p) { return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453); }
      float turfNoise(vec2 p) {
        vec2 i=floor(p),f=fract(p); f=f*f*(3.0-2.0*f);
        return mix(mix(turfHash(i),turfHash(i+vec2(1.,0.)),f.x),mix(turfHash(i+vec2(0.,1.)),turfHash(i+vec2(1.,1.)),f.x),f.y);
      }
    `).replace("#include <color_fragment>", `#include <color_fragment>
      vec2 metres=turfWorld.xz;
      float broad=turfNoise(metres*.65);
      float blade=turfNoise(metres*vec2(95.,32.));
      float footprint=max(length(dFdx(metres)),length(dFdy(metres)));
      float detail=1.0-smoothstep(.025,.13,footprint);
      float mowing=sin(metres.y*.59)*.035;
      diffuseColor.rgb *= .90 + broad*.16 + (blade-.5)*.23*detail + mowing;
    `);
  };
  material.customProgramCacheKey = () => "arena-olive-turf-v1";
  return material;
}
