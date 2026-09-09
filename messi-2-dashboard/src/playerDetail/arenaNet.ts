import * as THREE from "three";

/** Display-only rope grid on the existing goal-net geometry, in world metres.
 * Derivative antialiasing retains fine ropes at the analysis camera distance. */
export function createArenaNet() {
  const material = new THREE.MeshStandardMaterial({ color: "#d9ded7", roughness: .88, metalness: 0, side: THREE.DoubleSide, transparent: true, depthWrite: false });
  material.name = "arena-goal-net-v1";
  material.onBeforeCompile = shader => {
    shader.vertexShader = shader.vertexShader.replace("#include <common>", "#include <common>\nvarying vec2 netMetres;")
      .replace("#include <begin_vertex>", `#include <begin_vertex>
        vec3 netPosition=(modelMatrix*vec4(position,1.0)).xyz;
        vec3 netNormal=normalize(mat3(modelMatrix)*normal);
        netMetres=abs(netNormal.y)>.7 ? netPosition.xz : (abs(netNormal.x)>abs(netNormal.z) ? netPosition.zy : netPosition.xy);
      `);
    shader.fragmentShader = shader.fragmentShader.replace("#include <common>", "#include <common>\nvarying vec2 netMetres;")
      .replace("#include <alphatest_fragment>", `
        vec2 netGrid=netMetres/.12;
        vec2 netAA=max(fwidth(netGrid),vec2(.001));
        vec2 netDistance=abs(fract(netGrid-.5)-.5);
        vec2 netRope=1.0-smoothstep(vec2(.022),vec2(.022)+netAA*.8,netDistance);
        diffuseColor.a*=max(netRope.x,netRope.y);
        if(diffuseColor.a<.015) discard;
        #include <alphatest_fragment>
      `);
  };
  material.customProgramCacheKey = () => "arena-goal-net-v1";
  return material;
}
