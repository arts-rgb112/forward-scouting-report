import * as THREE from 'three';
import { applyNaturalTurf } from './turfMaterial';

/** Local art-direction candidate. Shared source textures are borrowed, never rewritten. */
export function createInfieldStudyMaterial(source: THREE.MeshStandardMaterial, distanceVariation = false, directionalCanopy = false) {
  const material = source.clone();
  applyNaturalTurf(material);
  material.name = 'InfieldStudyGrass';
  material.color.setRGB(.68, .74, .66);
  material.normalScale.set(.65, .65);
  if(distanceVariation && directionalCanopy && material instanceof THREE.MeshPhysicalMaterial){
    material.sheen=.6;
    material.sheenColor.setRGB(.30,.42,.16);
    material.sheenRoughness=.85;
  }
  const originalCompile = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    originalCompile(shader, renderer);
    shader.vertexShader = 'varying vec2 turfWorld;\n' + shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>',
      '#include <begin_vertex>\n turfWorld=(modelMatrix*vec4(position,1.0)).xz;');
    shader.fragmentShader = `varying vec2 turfWorld;
      float turfHash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
      float turfNoise(vec2 p){
        vec2 i=floor(p),f=fract(p); f=f*f*(3.0-2.0*f);
        return mix(mix(turfHash(i),turfHash(i+vec2(1,0)),f.x),
          mix(turfHash(i+vec2(0,1)),turfHash(i+vec2(1,1)),f.x),f.y);
      }
    ` + shader.fragmentShader;
    // Multiply, do not replace, the purchased albedo. Spatial variation is decor, not data.
    // Both former stripe meshes share this world-space field, so no material seam remains.
    shader.fragmentShader = shader.fragmentShader.replace('#include <map_fragment>', `
      #include <map_fragment>
      float macro=turfNoise(turfWorld*.19);
      float detail=turfNoise(turfWorld*.83+vec2(17.0,9.0));
      float mowing=sin(turfWorld.y*0.5962);
      float variation=.86+.22*macro+.06*(detail-.5)+.065*mowing;
      diffuseColor.rgb *= variation;
      ${distanceVariation ? `
      // Keep the approved close material exactly unchanged within 18m.
      float turfDistance=length(cameraPosition-vec3(turfWorld.x,0.0,turfWorld.y));
      float distanceBlend=smoothstep(18.0,42.0,turfDistance);
      float broadTone=turfNoise(turfWorld*.055+vec2(4.0,11.0));
      float softMow=sin(turfWorld.y*.5962+.35*turfNoise(turfWorld*.08));
      // Replace (not stack on) the close macro pattern: its blobs read as clouds from above.
      float distantVariation=1.16+${directionalCanopy ? '0.0' : '.035'}*softMow+.02*(broadTone-.5);
      diffuseColor.rgb *= mix(1.0,distantVariation/variation,distanceBlend);
      ` : ''}
    `);
    if (distanceVariation) shader.fragmentShader = shader.fragmentShader.replace(
      'roughnessFactor = max(0.85, roughnessFactor);',
      'roughnessFactor = max(0.85, roughnessFactor);\n roughnessFactor = clamp(roughnessFactor-distanceBlend*.025*broadTone,0.85,1.0);');
    if(distanceVariation && directionalCanopy){
      // Approximate the aggregate fibre response with Three's Charlie sheen BRDF.
      // No painted bands/normal tilts. Zero sheen within 18m preserves the approved close view.
      shader.fragmentShader=shader.fragmentShader.replace('#include <lights_physical_fragment>', `
        #include <lights_physical_fragment>
        #ifdef USE_SHEEN
          material.sheenColor *= distanceBlend;
        #endif
      `);
    }
  };
  material.customProgramCacheKey = () => distanceVariation ? (directionalCanopy ? 'infield-study-fibre-v2' : 'infield-study-distance-v1') : 'infield-study-world-grass-v1';
  return material;
}
