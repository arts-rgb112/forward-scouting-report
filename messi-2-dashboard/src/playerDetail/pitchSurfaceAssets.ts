import * as THREE from 'three';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';
import { GroundedSkybox } from 'three/addons/objects/GroundedSkybox.js';
import { createInfieldStudyMaterial } from './infieldStudy';
import { createDesignSurround } from './pitchArtDirection';
import { createArenaStudio } from './arenaStudio';

export const PITCH_SURFACE_VERSION = 'grass001-fibre-v1';
const ROOT = '/assets/infield-v1/';

/** Approved study material packaged for the existing interactive pitch, without demo data. */
export async function loadPitchSurfaceAssets(presentation: 'full' | 'arena' = 'full') {
  const loader = new THREE.TextureLoader();
  const results = await Promise.allSettled([
    ...['Color', 'NormalGL', 'Roughness', 'AmbientOcclusion'].map(name => loader.loadAsync(`${ROOT}${name}.webp`)),
    ...(presentation === 'full' ? [new HDRLoader().setDataType(THREE.FloatType).loadAsync(`${ROOT}meadow-2-2k.hdr`)] : []),
  ]);
  const textures = results.flatMap(result => result.status === 'fulfilled' ? [result.value] : []);
  if (results.some(result => result.status === 'rejected')) {
    textures.forEach(texture => texture.dispose());
    throw new Error('승인된 잔디·환경 자산을 불러오지 못했습니다.');
  }
  const [map, normalMap, roughnessMap, aoMap, environment] = textures;
  for (const texture of [map, normalMap, roughnessMap, aoMap]) {
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
    texture.repeat.setScalar(2 / 1.4);
    texture.colorSpace = texture === map ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  }
  if (environment) environment.mapping = THREE.EquirectangularReflectionMapping;
  const source = new THREE.MeshPhysicalMaterial({ map, normalMap, roughnessMap, aoMap, aoMapIntensity: .5 });
  const material = createInfieldStudyMaterial(source, true, true);
  source.dispose();
  material.color.setRGB(.80, .95, .70); material.normalScale.set(.55, .55);
  if (material instanceof THREE.MeshPhysicalMaterial) material.specularIntensity = .10;
  material.userData.sharedAssetTextures = true;
  const surround = presentation === 'arena' ? createArenaStudio() : createDesignSurround();
  if (environment) {
    const backdrop = new GroundedSkybox(environment, 45, 350, 96); backdrop.position.y = 44.88;
    surround.add(backdrop);
  }
  const replaced = new Set<THREE.Material>();
  return {
    environment: environment ?? null, surround,
    apply(root: THREE.Object3D) {
      root.traverse(object => {
        if (!(object instanceof THREE.Mesh)) return;
        const replace = (original: THREE.Material) => {
          if (!/^(LightGrass|DarkGrass)$/.test(original.name)) return original;
          replaced.add(original); return material;
        };
        object.material = Array.isArray(object.material) ? object.material.map(replace) : replace(object.material);
      });
    },
    dispose() {
      material.dispose(); textures.forEach(texture => texture.dispose());
      const originals = new Set<THREE.Texture>();
      replaced.forEach(original => { Object.values(original).forEach(value => { if (value instanceof THREE.Texture) originals.add(value); }); original.dispose(); });
      originals.forEach(texture => texture.dispose());
    },
  };
}
