import * as THREE from "three";

/** Authored display architecture, not a reconstruction of a real stadium. */
export const ARENA_STUDIO_VERSION = "concrete-studio-v1";

function concreteMaterial() {
  const material = new THREE.MeshStandardMaterial({ color: "#777874", roughness: .94, metalness: 0 });
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader.replace("#include <common>", "#include <common>\nvarying vec3 studioPosition;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nstudioPosition = (modelMatrix * vec4(position, 1.0)).xyz;");
    shader.fragmentShader = shader.fragmentShader.replace("#include <common>", `#include <common>
      varying vec3 studioPosition;
      float studioNoise(vec3 p) { return fract(sin(dot(p, vec3(12.9898,78.233,37.719))) * 43758.5453); }
    `).replace("#include <color_fragment>", `#include <color_fragment>
      float fine = studioNoise(floor(studioPosition * 160.0));
      float broad = sin(studioPosition.x * .73 + sin(studioPosition.z * .42)) * sin(studioPosition.y * .58 + studioPosition.z * .17);
      diffuseColor.rgb *= .94 + fine * .08 + broad * .045;
    `);
  };
  material.customProgramCacheKey = () => ARENA_STUDIO_VERSION;
  return material;
}

export function createArenaStudio() {
  const root = new THREE.Group();
  root.name = ARENA_STUDIO_VERSION;
  const concrete = concreteMaterial();
  const graphite = new THREE.MeshStandardMaterial({ color: "#343737", roughness: .9 });
  const box = (name: string, size: [number, number, number], position: [number, number, number], material = concrete) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), material);
    mesh.name = name;
    mesh.position.set(...position);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    root.add(mesh);
    return mesh;
  };
  box("studio-floor", [270, .5, 190], [0, -.32, 0]);
  // Formwork joints are actual narrow gaps between architectural slabs.
  for (let index = 0; index < 10; index++) {
    box(`studio-rear-panel-${index}`, [25.18, 36, 1.2], [-113.4 + index * 25.2, 17.7, 80]);
  }
  box("studio-left-wall", [1.2, 36, 165], [-126.6, 17.7, -2]);
  box("studio-right-wall", [1.2, 36, 165], [126.6, 17.7, -2]);
  // An open skylight and its structural beams create real cast shadows.
  for (let index = 0; index < 5; index++) {
    box(`studio-skylight-beam-${index}`, [252, 1.1, 1.4], [0, 35.1, 20 + index * 11], graphite);
  }
  const fill = new THREE.HemisphereLight(0xd7dce0, 0x33352f, 1.05);
  root.add(fill);
  const sun = new THREE.DirectionalLight(0xfff5e6, 3.1);
  sun.name = "studio-daylight";
  sun.position.set(42, 68, -18);
  sun.target.position.set(-18, 0, 48);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -80, right: 80, top: 80, bottom: -80, near: 1, far: 200 });
  sun.shadow.normalBias = .035;
  sun.shadow.bias = -.0002;
  root.add(sun, sun.target);
  return root;
}
