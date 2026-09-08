import * as THREE from "three";
import type { ShotmapPoint } from "../dashboard/types";
import { trajectoryArcPoint } from "./pitchWebglGeometry";

export const REPLAY_DURATION_MS = 2400; // Presentation time, never measured ball speed.
export const SHOT_BALL_COLORS = { goal: 0xbef264, on_target: 0x38bdf8, off_target: 0xfb923c, blocked: 0xc4b5fd } as const;

/** Opaque textured footballs; selection uses a ring, never ghosted background balls. */
export function styleShotBall(ball: THREE.Mesh, outcome: ShotmapPoint['outcome']) {
  ball.castShadow = true;
  ball.receiveShadow = true;
  const materials = Array.isArray(ball.material) ? ball.material : [ball.material];
  for (const material of materials) {
    material.transparent = false;
    material.opacity = 1;
    material.depthWrite = true;
    if (material instanceof THREE.MeshStandardMaterial) {
      material.color.setHex(SHOT_BALL_COLORS[outcome]);
      material.emissive.setHex(SHOT_BALL_COLORS[outcome]);
      material.emissiveIntensity = .12;
      material.metalness = 0;
      material.roughness = .72;
    }
    material.needsUpdate = true;
  }
}
export function canReplayGoal(shot: ShotmapPoint) {
  const end = shot.trajectory;
  return (shot.outcome === "goal" || shot.outcome === "on_target") && end?.endpointKind === "goal_mouth" &&
    Number.isFinite(shot.x) && shot.x >= 0 && shot.x <= 100 &&
    Number.isFinite(shot.y) && shot.y >= 0 && shot.y <= 100 &&
    end.endX === 100 && Number.isFinite(end.endY) &&
    end.endY >= 44.61764705882353 && end.endY <= 55.38235294117647 &&
    typeof end.endZMeters === "number" && Number.isFinite(end.endZMeters) &&
    end.endZMeters >= 0 && end.endZMeters <= 2.44;
}

/** Endpoint-backed schematic arc. Intermediate height/time are illustrative. */
/** Same arc as the static trajectory line (trajectoryArcPoint) — the ball and
 * the line must never diverge for the same shot. */
export function replayPosition(shot: ShotmapPoint, progress: number) {
  if (!canReplayGoal(shot)) throw new Error("재생 가능한 득점·유효슛 좌표가 없습니다.");
  const t = Math.max(0, Math.min(1, Number.isFinite(progress) ? progress : 0));
  const point = trajectoryArcPoint(shot, shot.trajectory!.endY, shot.trajectory!.endZMeters, t);
  return new THREE.Vector3(point.x, point.y, point.z);
}

/** Use the purchased football mesh, not a replacement procedural sphere. */
export function cloneReplayBall(asset: THREE.Object3D) {
  const football = asset.getObjectByName("Football_13");
  if (!football) throw new Error("구매 에셋의 Football_13 공을 찾을 수 없습니다.");
  asset.updateMatrixWorld(true);
  let source: THREE.Mesh | undefined;
  football.traverse((object) => { if (!source && object instanceof THREE.Mesh) source = object; });
  if (!source) throw new Error("공 메시가 없습니다.");
  const geometry = source.geometry.clone().applyMatrix4(source.matrixWorld);
  geometry.computeBoundingBox();
  const bounds = geometry.boundingBox!;
  const size = bounds.getSize(new THREE.Vector3());
  const diameter = Math.max(size.x, size.y, size.z);
  if (!Number.isFinite(diameter) || diameter <= 0) { geometry.dispose(); throw new Error("공 치수 검증 실패"); }
  const center = bounds.getCenter(new THREE.Vector3());
  geometry.translate(-center.x, -center.y, -center.z);
  geometry.scale(.22 / diameter, .22 / diameter, .22 / diameter);
  const material = Array.isArray(source.material) ? source.material.map(m => m.clone()) : source.material.clone();
  (Array.isArray(material) ? material : [material]).forEach(m => { m.userData.sharedAssetTextures = true; });
  const ball = new THREE.Mesh(geometry, material);
  ball.name = "selected-shot-asset-football";
  return ball;
}
