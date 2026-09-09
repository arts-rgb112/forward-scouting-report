import * as THREE from "three";

/** Arena-only original texture plus multiscale shading; no inherited turf/HDR. */
export function createArenaTurf(map?: THREE.Texture, bumpMap?: THREE.Texture) {
  const material = new THREE.MeshStandardMaterial({ color: map ? "#b3baa4" : "#485639", map: map ?? null, bumpMap: bumpMap ?? null, bumpScale: .018, roughness: .96, metalness: 0 });
  material.name = "arena-olive-turf-v2";
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
      float medium=turfNoise(metres*vec2(9.,14.));
      float blade=turfNoise(metres*vec2(95.,32.));
      float footprint=max(length(dFdx(metres)),length(dFdy(metres)));
      float detail=1.0-smoothstep(.025,.13,footprint);
      float mowing=sin(metres.y*.59)*.035;
      diffuseColor.rgb *= .86 + broad*.14 + medium*.12 + (blade-.5)*.30*detail + mowing;
    `).replace("#include <map_fragment>", `#include <map_fragment>
      float turfLuma=dot(diffuseColor.rgb,vec3(.2126,.7152,.0722));
      diffuseColor.rgb=mix(vec3(turfLuma),diffuseColor.rgb,.65);
    `);
  };
  material.customProgramCacheKey = () => "arena-olive-turf-v2";
  return material;
}
