import * as THREE from 'three';

const GRID = 480;
const SPACING = .05;
const GROUND = -.027;
const HALF_LENGTH = 52.69278515625;

function random(x: number, z: number, salt: number) {
  const n = Math.sin(x * 127.1 + z * 311.7 + salt * 74.7) * 43758.5453;
  return n - Math.floor(n);
}

/** Study-only close-range grass: world-anchored, seeded and capped at 230,400 tufts.
 * No source meshes/maps/data are modified. Distant detail collapses into the base turf.
 */
export function createTurfRelief() {
  const geometry = new THREE.BufferGeometry();
  // Two intersecting tapered blades, 2cm tall. No billboard sprites or alpha texture.
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([
    -.002,0,0, .002,0,0, .003,.02,.002,
    0,0,-.002, 0,0,.002, -.002,.018,.003,
  ], 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute([
    .8,.8,.8, .8,.8,.8, 1,1,1,
    .8,.8,.8, .8,.8,.8, .94,.94,.94,
  ], 3));
  // A mown canopy receives light from above; vertical card normals make black hairs.
  geometry.setAttribute('normal',new THREE.Float32BufferAttribute([
    0,1,0, 0,1,0, 0,1,0, 0,1,0, 0,1,0, 0,1,0,
  ],3));
  const material = new THREE.MeshStandardMaterial({
    color:0xffffff, roughness:1, metalness:0, side:THREE.DoubleSide, vertexColors:true,
    envMapIntensity:.25,
  });
  material.onBeforeCompile = shader => {
    shader.fragmentShader = shader.fragmentShader.replace('#include <normal_fragment_begin>',
      '#include <normal_fragment_begin>\n normal *= faceDirection;');
    shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', `
      #include <begin_vertex>
      vec3 tuftOrigin=(modelMatrix*instanceMatrix*vec4(0.0,0.0,0.0,1.0)).xyz;
      float tuftDistance=length(cameraPosition.xz-tuftOrigin.xz);
      transformed.y *= 1.0-smoothstep(8.0,12.0,tuftDistance);
    `);
  };
  material.customProgramCacheKey = () => 'short-turf-relief-v1';
  const mesh = new THREE.InstancedMesh(geometry,material,GRID*GRID);
  mesh.name = 'close-range-turf-relief';
  mesh.frustumCulled = false;
  mesh.receiveShadow = true;
  const dummy = new THREE.Object3D();
  const color = new THREE.Color();
  function update(camera: THREE.Vector3) {
    mesh.visible = camera.y < 8;
    if (!mesh.visible) return;
    const startX = Math.floor(camera.x/SPACING)-GRID/2;
    const startZ = Math.floor(camera.z/SPACING)-GRID/2;
    let count=0;
    for (let ix=0;ix<GRID;ix++) for(let iz=0;iz<GRID;iz++) {
      const gx=startX+ix, gz=startZ+iz;
      const x=(gx+random(gx,gz,0))*SPACING;
      const z=(gz+random(gx,gz,1))*SPACING;
      if(Math.abs(x)>33.95 || Math.abs(z)>HALF_LENGTH-.05) continue;
      if(Math.hypot(x-camera.x,z-camera.z)>12) continue;
      dummy.position.set(x,GROUND,z);
      dummy.rotation.set(0,random(gx,gz,2)*Math.PI*2,0);
      dummy.scale.setScalar(.65+random(gx,gz,3)*.5);
      dummy.updateMatrix(); mesh.setMatrixAt(count,dummy.matrix);
      color.setRGB(.055+.025*random(gx,gz,4),.095+.035*random(gx,gz,5),.018+.012*random(gx,gz,6));
      mesh.setColorAt(count,color); count++;
    }
    mesh.count=count;
    mesh.instanceMatrix.needsUpdate=true;
    if(mesh.instanceColor)mesh.instanceColor.needsUpdate=true;
  }
  return {mesh,update};
}
