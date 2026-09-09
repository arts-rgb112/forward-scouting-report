import type { NativePitchEvent } from "../api/nativePitchEventsContracts";
import type { NativePitchEventV2 } from "../api/nativePitchEventsV2Contracts";
import { pitchPercentToWorld, WEBGL_OVERLAY_Y_METERS, type WorldPoint } from "./pitchWebglGeometry";
import { shotSilhouetteYawRadians } from "./shotSilhouetteStyle";

export const NATIVE_SCHEMATIC_PARAMETERS = Object.freeze({
  id: "native-low-arc-v1" as const,
  footContactMeters: WEBGL_OVERLAY_Y_METERS + .12,
  headContactOffsetMeters: 1.55,
  endpointDisplayMeters: WEBGL_OVERLAY_Y_METERS + .12,
  arcRiseMeters: .35,
});
export type NativeReplayGeometry = {
  key: string; provider: "sportsapi"; observedHeightMeters: null;
  definition: "source-planar-schematic-height-v1" | "source-validated-terminal-planar-schematic-v2";
  destinationKind: "goal_plane_projection" | "block_projection" | "goal_plane" | "block";
  parameters: typeof NATIVE_SCHEMATIC_PARAMETERS;
  from: WorldPoint; to: WorldPoint;
};
export type NativePosePlacement = {
  key: string; provider: "sportsapi"; observedHeightMeters: null;
  motion: "head" | "left_foot" | "right_foot"; assetUrl: string;
  groundPosition: WorldPoint; yawRadians: number;
  orientation: "recorded-terminal-planar" | "schematic-attacking-goal-center";
};
const percent = (n: number | null): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 100;
function located(event: NativePitchEvent | NativePitchEventV2) {
  return event.plot.state === "projected" && event.plot.reason === null && percent(event.plot.x) && percent(event.plot.y);
}

/** Planar endpoints are recorded; ALL vertical coordinates are presentation parameters. */
export function buildNativeReplayGeometry(event: NativePitchEvent | NativePitchEventV2): NativeReplayGeometry | null {
  const d = event.destination;
  if (!located(event) || d.observedHeightMeters !== null || d.reason !== null || !percent(d.x) || !percent(d.y)) return null;
  if (event.shotType === "goal") {
    if ((d.kind !== "goal_plane_projection" && d.kind !== "goal_plane") || d.x !== 100) return null;
  } else if (event.shotType === "save" || event.shotType === "block") {
    if (d.kind !== "block_projection" && d.kind !== "block") return null;
  } else {
    // A provider goal-mouth drawing coordinate is not an observed terminal
    // point for a miss/post. Keep its marker and pose, never invent a path.
    return null;
  }
  const p = NATIVE_SCHEMATIC_PARAMETERS;
  return {
    key: event.key, provider: "sportsapi", observedHeightMeters: null,
    definition: "quality" in event ? "source-validated-terminal-planar-schematic-v2" : "source-planar-schematic-height-v1", destinationKind: d.kind as NativeReplayGeometry["destinationKind"], parameters: p,
    from: pitchPercentToWorld({ x: event.plot.x!, y: event.plot.y! }, p.footContactMeters + (event.bodyPart === "head" ? p.headContactOffsetMeters : 0)),
    to: pitchPercentToWorld({ x: d.x, y: d.y }, p.endpointDisplayMeters),
  };
}

/** Shared by static lines and moving balls; throws on invalid time instead of emitting NaN. */
export function nativeReplayPoint(geometry: NativeReplayGeometry, progress: number): WorldPoint {
  if (!Number.isFinite(progress)) throw new RangeError("Finite schematic progress required");
  const t = Math.max(0, Math.min(1, progress));
  const { from, to, parameters } = geometry;
  if (t === 0) return { ...from };
  if (t === 1) return { ...to };
  return { x: from.x + (to.x - from.x) * t,
    y: from.y + (to.y - from.y) * t + parameters.arcRiseMeters * 4 * t * (1 - t),
    z: from.z + (to.z - from.z) * t };
}
export function nativeReplayPolyline(geometry: NativeReplayGeometry, segments = 48): WorldPoint[] {
  if (!Number.isInteger(segments) || segments < 1 || segments > 512) throw new RangeError("Segments must be 1..512");
  return Array.from({ length: segments + 1 }, (_, index) => nativeReplayPoint(geometry, index / segments));
}

function recordedPoseTarget(event: NativePitchEvent | NativePitchEventV2): WorldPoint | null {
  // Keep exactly the same terminal admissibility as the replay. In particular,
  // goal-mouth drawing coordinates for miss/post are not recorded endpoints.
  return buildNativeReplayGeometry(event)?.to ?? null;
}

/**
 * Pose direction uses the provider terminal point when it is present. When it
 * is absent, only the pose may face the attacking goal as a labelled schematic
 * fallback; no trajectory or endpoint is constructed for that event.
 */
export function nativePosePlacement(event: NativePitchEvent | NativePitchEventV2): NativePosePlacement | null {
  if (!located(event)) return null;
  const motion = event.bodyPart === "head" ? "head" : event.bodyPart === "leftFoot" ? "left_foot" : event.bodyPart === "rightFoot" ? "right_foot" : null;
  if (!motion) return null;
  const groundPosition = pitchPercentToWorld({ x: event.plot.x!, y: event.plot.y! }, WEBGL_OVERLAY_Y_METERS);
  const recordedTarget = recordedPoseTarget(event);
  const target = recordedTarget ?? pitchPercentToWorld({ x: 100, y: 50 }, WEBGL_OVERLAY_Y_METERS);
  return { key: event.key, provider: "sportsapi", observedHeightMeters: null, motion,
    assetUrl: `/assets/shot-silhouette/${motion}.glb?v=2`, groundPosition,
    yawRadians: shotSilhouetteYawRadians(groundPosition, target),
    orientation: recordedTarget ? "recorded-terminal-planar" : "schematic-attacking-goal-center" };
}
