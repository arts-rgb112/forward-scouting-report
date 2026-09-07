import * as THREE from 'three';

/** Preserve the purchased turf maps; never replace their albedo with generated noise. */
export function applyNaturalTurf(material: THREE.MeshStandardMaterial) {
  material.color.set('#ffffff');
  material.normalScale.set(.45, .45);
  material.metalness = 0;
  material.roughness = 1;
  material.envMapIntensity = .25;
  // Reset the previous procedural hook if this material was already styled.
  material.onBeforeCompile = shader => {
    // Retain the map's variation but bound the exported low roughness: turf is not polished.
    shader.fragmentShader = shader.fragmentShader.replace('#include <roughnessmap_fragment>',
      '#include <roughnessmap_fragment>\n roughnessFactor = max(0.85, roughnessFactor);');
  };
  if (material instanceof THREE.MeshPhysicalMaterial) material.specularIntensity = .25;
  material.customProgramCacheKey = () => 'asset-turf-maps-v2';
  for (const texture of [material.map, material.normalMap, material.roughnessMap]) {
    if (!texture) continue;
    texture.anisotropy = 8;
    texture.needsUpdate = true;
  }
  material.needsUpdate = true;
}

/** Quiet training-ground surround outside the unchanged 68m x 105.4m pitch. */
export function createPitchSurround() {
  const group = new THREE.Group(); group.name = 'training-ground-surround';
  const sky = new THREE.Mesh(new THREE.SphereGeometry(180,32,16), new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false,
    vertexShader: 'varying vec3 skyP; void main(){skyP=position;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}',
    fragmentShader: 'varying vec3 skyP; void main(){float h=clamp(normalize(skyP).y,0.0,1.0); vec3 col=mix(vec3(.32,.50,.65),vec3(.08,.27,.55),pow(h,.55));gl_FragColor=vec4(col,1.0);\n#include <tonemapping_fragment>\n#include <colorspace_fragment>\n}',
  }));
  sky.name='daylight-sky'; group.add(sky);
  const apronMaterial = new THREE.MeshStandardMaterial({color:'#53673c',roughness:1,metalness:0});
  const apron = new THREE.Mesh(new THREE.PlaneGeometry(130,170),apronMaterial);
  apron.rotation.x = -Math.PI/2; apron.position.y = -.09; apron.receiveShadow=true; group.add(apron);
  const postMaterial = new THREE.MeshStandardMaterial({color:'#465251',roughness:.85});
  const wireMaterial = new THREE.LineBasicMaterial({color:'#66776c',transparent:true,opacity:.14});
  const points: THREE.Vector3[]=[];
  for (const x of [-43,43]) {
    for (let z=-65; z<=65; z+=5) {
      const post=new THREE.Mesh(new THREE.CylinderGeometry(.045,.045,4,6),postMaterial);
      post.position.set(x,2,z); group.add(post);
    }
    for(let y=.4;y<=4;y+=.4) points.push(new THREE.Vector3(x,y,-65),new THREE.Vector3(x,y,65));
    for(let z=-65;z<=65;z+=.6) points.push(new THREE.Vector3(x,0,z),new THREE.Vector3(x,4,z));
  }
  for (const z of [-65,65]) {
    for (let x=-43; x<=43; x+=5) {
      const post=new THREE.Mesh(new THREE.CylinderGeometry(.045,.045,4,6),postMaterial);
      post.position.set(x,2,z); group.add(post);
    }
    for(let y=.4;y<=4;y+=.4) points.push(new THREE.Vector3(-43,y,z),new THREE.Vector3(43,y,z));
    for(let x=-43;x<=43;x+=.6) points.push(new THREE.Vector3(x,0,z),new THREE.Vector3(x,4,z));
  }
  group.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(points),wireMaterial));
  return group;
}
