import * as THREE from "three";

export const AERIAL_CAMERA = { position: { x: -76, y: 91, z: 0 }, yaw: 90, pitch: -50 };
export const DAYLIGHT_BACKGROUND = 0xc8e4f2;

/** Fab export contains all-zero UVs on these meshes. Reconstruct display UVs only. */
export function repairPitchUV(mesh: THREE.Mesh) {
  const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  const name = materials[0]?.name ?? '';
  if (!/Football|Fencing|Grass/.test(name)) return;
  const old = mesh.geometry.getAttribute('uv');
  if (old && Array.from({ length: old.count }, (_, i) => Math.abs(old.getX(i)) + Math.abs(old.getY(i))).some(v => v > 1e-6)) return;
  const geometry = mesh.geometry;
  const positions = geometry.getAttribute('position'), normals = geometry.getAttribute('normal');
  geometry.computeBoundingBox();
  const center = geometry.boundingBox!.getCenter(new THREE.Vector3());
  const uv: number[] = [];
  for (let i = 0; i < positions.count; i++) {
    const point = new THREE.Vector3().fromBufferAttribute(positions, i);
    if (/Football/.test(name)) {
      point.sub(center).normalize();
      uv.push(.5 + Math.atan2(point.z, point.x) / (2 * Math.PI), .5 + Math.asin(point.y) / Math.PI);
    } else if (/Grass/.test(name)) {
      point.applyMatrix4(mesh.matrixWorld);
      uv.push(point.x * .5, point.z * .5);
    } else {
      // Each flat net face gets a planar projection in world metres.
      const normal = new THREE.Vector3().fromBufferAttribute(normals, i).transformDirection(mesh.matrixWorld);
      point.applyMatrix4(mesh.matrixWorld);
      if (Math.abs(normal.y) > .7) uv.push(point.x * .5, point.z * .5);
      else uv.push((Math.abs(normal.x) > Math.abs(normal.z) ? point.z : point.x) * .5, point.y * .5);
    }
  }
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  materials.forEach(material => {
    if (!(material instanceof THREE.MeshStandardMaterial)) return;
    for (const texture of [material.map, material.normalMap, material.roughnessMap, material.metalnessMap]) {
      if (!texture) continue;
      texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
      texture.needsUpdate = true;
    }
  });
  mesh.userData.uvRepair = 'display-only-zero-uv-reconstruction';
}

/** Runtime-only art direction. Purchased meshes/maps and source file remain intact. */
export function stylePitchMaterial(material: THREE.Material) {
  if (!(material instanceof THREE.MeshStandardMaterial)) return;
  if (/Grass/i.test(material.name)) {
    material.color.set(/Dark/i.test(material.name) ? "#598363" : "#658e6e");
    material.metalness = 0;
    material.roughness = .95;
    material.envMapIntensity = .12;
    // Grass is diffuse; a zero-valued exported roughness texel otherwise makes a mirror.
    material.roughnessMap = null;
    material.metalnessMap = null;
  } else if (/White|Football/i.test(material.name)) {
    material.metalness = 0;
    material.roughness = .72;
  }
  if (/Fencing/i.test(material.name)) {
    // Keep the purchased net's alpha cutouts, but replace its black RGB albedo.
    // Colour multiplication alone cannot turn black texture texels into white rope.
    material.color.set('#ffffff');
    material.metalness = 0;
    material.metalnessMap = null;
    material.roughness = .85;
    material.roughnessMap = null;
    material.side = THREE.DoubleSide;
    material.emissive.set('#ffffff');
    material.emissiveIntensity = .15;
    material.onBeforeCompile = shader => {
      shader.fragmentShader = shader.fragmentShader.replace('#include <map_fragment>',
        '#include <map_fragment>\n diffuseColor.rgb = vec3(0.92);');
    };
    material.customProgramCacheKey = () => 'white-net-preserve-alpha-v1';
    material.alphaTest = .4;
    material.transparent = false;
    material.depthWrite = true;
    material.needsUpdate = true;
  }
}
