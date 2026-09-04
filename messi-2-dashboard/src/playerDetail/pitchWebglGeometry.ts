export type PitchPercentPoint = { x: number; y: number };
export type WorldPoint = { x: number; y: number; z: number };
export type CameraAngle = "left" | "right" | "goalFront" | "goalBack";
export type OrbitCameraState = { azimuth: number; elevation: number; distance: number };
export type FreeflyCameraState = { position: WorldPoint; yaw: number; pitch: number };
export type FreeflyMove = { forward?: number; right?: number; vertical?: number };

/** Measured directly from Object_2/Object_26, the dense white-line meshes in footballpitchv3.glb. */
export const GLB_PITCH_WIDTH_METERS = 68;
export const GLB_PITCH_LENGTH_METERS = 105.3855703125;
export const GLB_PITCH_HALF_WIDTH_METERS = GLB_PITCH_WIDTH_METERS / 2;
export const GLB_PITCH_HALF_LENGTH_METERS = GLB_PITCH_LENGTH_METERS / 2;
export const GLB_PITCH_SURFACE_Y_METERS = -0.02705;
export const WEBGL_OVERLAY_Y_METERS = 0.075;
export const FIFA_PENALTY_SPOT_FROM_GOAL_METERS = 11;
export const PROVIDER_PENALTY_X = 89.524;

export const DEFAULT_WEBGL_CAMERA: OrbitCameraState = {
  azimuth: -48,
  elevation: 30,
  distance: 84,
};

export const WEBGL_CAMERA_PRESETS: Readonly<Record<CameraAngle, OrbitCameraState>> = {
  left: { azimuth: 90, elevation: 30, distance: 84 },
  right: { azimuth: 270, elevation: 30, distance: 84 },
  goalFront: { azimuth: 180, elevation: 27, distance: 84 },
  goalBack: { azimuth: 0, elevation: 27, distance: 84 },
};

export const WEBGL_ZOOM = { minimum: 1, maximum: 3, step: 0.25 } as const;
export const FREEFLY_MOVE_STEP_METERS = 2.5;
export const FREEFLY_HEIGHT_STEP_METERS = 1.5;
export const FREEFLY_MOUSE_SENSITIVITY = 0.18;
export const FREEFLY_BOUNDS = {
  minX: -GLB_PITCH_HALF_WIDTH_METERS - 16,
  maxX: GLB_PITCH_HALF_WIDTH_METERS + 16,
  minY: GLB_PITCH_SURFACE_Y_METERS + 1.1,
  maxY: 42,
  minZ: -GLB_PITCH_HALF_LENGTH_METERS - 20,
  maxZ: GLB_PITCH_HALF_LENGTH_METERS + 20,
} as const;

export function clampWebglZoom(value: number) {
  return Math.min(WEBGL_ZOOM.maximum, Math.max(WEBGL_ZOOM.minimum, value));
}

/**
 * Sports data is attack-relative (x length, y width, both 0..100). The loaded
 * glTF is already Y-up after its authored root transforms: width is world X,
 * length is world Z, and the line mesh is centred on the origin. y=0 remains
 * the player's right touchline, hence the intentional width-axis inversion.
 */
export function pitchPercentToWorld(
  point: PitchPercentPoint,
  elevationMeters = WEBGL_OVERLAY_Y_METERS,
): WorldPoint {
  const xPct = Math.min(100, Math.max(0, point.x));
  const yPct = Math.min(100, Math.max(0, point.y));
  return {
    x: ((50 - yPct) / 100) * GLB_PITCH_WIDTH_METERS,
    y: elevationMeters,
    z: ((xPct - 50) / 100) * GLB_PITCH_LENGTH_METERS,
  };
}

export function worldToPitchPercent(point: Pick<WorldPoint, "x" | "z">): PitchPercentPoint {
  return {
    x: (point.z / GLB_PITCH_LENGTH_METERS) * 100 + 50,
    y: 50 - (point.x / GLB_PITCH_WIDTH_METERS) * 100,
  };
}

export function fifaPenaltySpotWorld(attacking = true): WorldPoint {
  return {
    x: 0,
    y: WEBGL_OVERLAY_Y_METERS,
    z: (attacking ? 1 : -1) *
      (GLB_PITCH_HALF_LENGTH_METERS - FIFA_PENALTY_SPOT_FROM_GOAL_METERS),
  };
}

export function providerPenaltyAlignmentErrorMeters() {
  const provider = pitchPercentToWorld({ x: PROVIDER_PENALTY_X, y: 50 });
  return Math.abs(provider.z - fifaPenaltySpotWorld(true).z);
}

export function cameraPositionFromOrbit(
  state: OrbitCameraState,
  target: WorldPoint,
  zoom = 1,
): WorldPoint {
  const azimuth = state.azimuth * Math.PI / 180;
  const elevation = state.elevation * Math.PI / 180;
  const radius = state.distance / clampWebglZoom(zoom);
  const horizontal = Math.cos(elevation) * radius;
  return {
    x: target.x + Math.sin(azimuth) * horizontal,
    y: target.y + Math.sin(elevation) * radius,
    z: target.z - Math.cos(azimuth) * horizontal,
  };
}

export function freeflyStateFromOrbit(
  state: OrbitCameraState,
  target: WorldPoint,
  zoom = 1,
): FreeflyCameraState {
  const position = cameraPositionFromOrbit(state, target, zoom);
  const dx = target.x - position.x;
  const dy = target.y - position.y;
  const dz = target.z - position.z;
  const distance = Math.hypot(dx, dy, dz) || 1;
  return clampFreeflyCamera({
    position,
    yaw: Math.atan2(dx, -dz) * 180 / Math.PI,
    pitch: Math.asin(dy / distance) * 180 / Math.PI,
  });
}

export function clampFreeflyCamera(state: FreeflyCameraState): FreeflyCameraState {
  const clamp = (value: number, minimum: number, maximum: number) =>
    Math.min(maximum, Math.max(minimum, value));
  return {
    ...state,
    position: {
      x: clamp(state.position.x, FREEFLY_BOUNDS.minX, FREEFLY_BOUNDS.maxX),
      y: clamp(state.position.y, FREEFLY_BOUNDS.minY, FREEFLY_BOUNDS.maxY),
      z: clamp(state.position.z, FREEFLY_BOUNDS.minZ, FREEFLY_BOUNDS.maxZ),
    },
    pitch: clamp(state.pitch, -80, 80),
  };
}

export function moveFreeflyCamera(state: FreeflyCameraState, move: FreeflyMove): FreeflyCameraState {
  const yaw = state.yaw * Math.PI / 180;
  const forward = move.forward ?? 0;
  const right = move.right ?? 0;
  return clampFreeflyCamera({
    ...state,
    position: {
      x: state.position.x + Math.sin(yaw) * forward + Math.cos(yaw) * right,
      y: state.position.y + (move.vertical ?? 0),
      z: state.position.z - Math.cos(yaw) * forward + Math.sin(yaw) * right,
    },
  });
}

export function rotateFreeflyCamera(
  state: FreeflyCameraState,
  deltaYaw: number,
  deltaPitch: number,
): FreeflyCameraState {
  const yaw = ((state.yaw + deltaYaw + 180) % 360 + 360) % 360 - 180;
  return clampFreeflyCamera({ ...state, yaw, pitch: state.pitch + deltaPitch });
}

export function freeflyLookTarget(state: FreeflyCameraState, distance = 100): WorldPoint {
  const yaw = state.yaw * Math.PI / 180;
  const pitch = state.pitch * Math.PI / 180;
  const horizontal = Math.cos(pitch) * distance;
  return {
    x: state.position.x + Math.sin(yaw) * horizontal,
    y: state.position.y + Math.sin(pitch) * distance,
    z: state.position.z - Math.cos(yaw) * horizontal,
  };
}

export function trajectoryWorldPoints(
  start: PitchPercentPoint,
  endY: number,
  endHeightMeters: number | null | undefined,
  segments = 24,
): WorldPoint[] {
  const from = pitchPercentToWorld(start, WEBGL_OVERLAY_Y_METERS + 0.12);
  const to = pitchPercentToWorld(
    { x: 100, y: endY },
    Math.max(0.15, endHeightMeters ?? 1.05),
  );
  const apex = Math.max(from.y, to.y) + Math.max(1.1, (to.z - from.z) * 0.035);
  return Array.from({ length: segments + 1 }, (_, index) => {
    const t = index / segments;
    const oneMinusT = 1 - t;
    return {
      x: from.x * oneMinusT + to.x * t,
      y: oneMinusT * oneMinusT * from.y + 2 * oneMinusT * t * apex + t * t * to.y,
      z: from.z * oneMinusT + to.z * t,
    };
  });
}
