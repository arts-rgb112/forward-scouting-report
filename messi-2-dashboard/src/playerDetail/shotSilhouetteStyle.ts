import * as THREE from "three";

type RecordedPart = "head" | "leftFoot" | "rightFoot" | "other" | "unknown";
const PART_MESHES: Partial<Record<RecordedPart, readonly string[]>> = {
  head: ["head"],
  leftFoot: ["left_boot", "left_joint", "left_shin"],
  rightFoot: ["right_boot", "right_joint", "right_shin"],
};

/** Authored anatomical names, never screen position or inferred shot direction. */
export function styleShotSilhouette(figure: THREE.Object3D, part: RecordedPart): void {
  const highlighted = PART_MESHES[part] ?? [];
  figure.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    const active = highlighted.includes(object.name);
    // GLTF meshes may share a material. Clone per mesh so highlighting one
    // shin cannot recolor the opposite leg or another selected player.
    const style = (source: THREE.Material) => {
      // This is a semantic UI highlight: environment lighting must not turn
      // the selected coral head/foot purple or imply a different category.
      if (active) return new THREE.MeshBasicMaterial({
        color: 0xf16d78, toneMapped: false, side: source.side,
        transparent: false, opacity: 1,
      });
      const material = source.clone();
      if (material instanceof THREE.MeshStandardMaterial) {
        material.color.setHex(active ? 0xf16d78 : 0x354252);
        material.emissive.setHex(active ? 0xf16d78 : 0x000000);
        material.emissiveIntensity = active ? 0.28 : 0;
        material.roughness = 0.85;
        material.metalness = 0;
      }
      material.transparent = false;
      material.opacity = 1;
      return material;
    };
    object.material = Array.isArray(object.material) ? object.material.map(style) : style(object.material);
    object.userData.highlightedBodyPart = active ? part : null;
  });
}
