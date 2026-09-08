import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { nativePitchEventsEnvelopeSchema, type NativePitchEvent } from "../api/nativePitchEventsContracts";
import { buildNativeReplayGeometry, nativeReplayPoint, nativeReplayPolyline, nativePosePlacement } from "./nativePitchReplayGeometry";
import { worldToPitchPercent } from "./pitchWebglGeometry";

const fixture = nativePitchEventsEnvelopeSchema.parse(JSON.parse(readFileSync(new URL("../../../../messi-specs/evidence/native-pitch-http-20260908-canonical-v2/included.json", import.meta.url), "utf8")));
const shot = (id = 5473386): NativePitchEvent => structuredClone(fixture.events.find(e => e.identity.shotId === id)!);
describe("same-native schematic geometry", () => {
  it.each([
    [6390845, 91.5, 56.6, 51.2, "head"],
    [5473386, 92, 62.2, 45.7, "left_foot"],
    [5473363, 85, 71.9, 45.8, "right_foot"],
  ] as const)("preserves actual event %i endpoints and pose", (id, x, y, endY, motion) => {
    const e = shot(id), g = buildNativeReplayGeometry(e)!;
    const from = worldToPitchPercent(nativeReplayPoint(g, 0));
    const to = worldToPitchPercent(nativeReplayPoint(g, 1));
    expect(from.x).toBeCloseTo(x); expect(from.y).toBeCloseTo(y);
    expect(to.x).toBeCloseTo(100); expect(to.y).toBeCloseTo(endY);
    expect(g.key).toBe(e.key); expect(g.observedHeightMeters).toBeNull();
    expect(g.parameters.id).toBe("native-low-arc-v1");
    const pose = nativePosePlacement(e)!;
    expect(pose.motion).toBe(motion); expect(pose.assetUrl).toContain(`${motion}.glb`);
    expect(pose.observedHeightMeters).toBeNull();
    expect(pose.orientation).toBe("schematic-attacking-goal-center");
    // Existing rig's local -Z rotates toward the actual attacking goal center.
    expect(-Math.sin(pose.yawRadians)).toBeLessThan(0);
    expect(-Math.cos(pose.yawRadians)).toBeGreaterThan(0);
  });
  it("uses identical static and moving samples for every located source event", () => {
    for (const e of fixture.events) {
      const g = buildNativeReplayGeometry(e); if (!g) continue;
      nativeReplayPolyline(g).forEach((p, i) => {
        expect(p).toEqual(nativeReplayPoint(g, i / 48));
        expect(Object.values(p).every(Number.isFinite)).toBe(true);
      });
      expect(nativeReplayPoint(g, -1)).toEqual(g.from);
      expect(nativeReplayPoint(g, 2)).toEqual(g.to);
    }
  });
  it("requires the recorded block endpoint, never a goal target", () => {
    const e = shot(); e.shotType = "block"; e.outcome = "blocked";
    expect(buildNativeReplayGeometry(e)).toBeNull();
    e.destination = { kind: "block_projection", x: 95, y: 52, observedHeightMeters: null, reason: null };
    const target = worldToPitchPercent(buildNativeReplayGeometry(e)!.to);
    expect(target.x).toBeCloseTo(95); expect(target.y).toBeCloseTo(52);
  });
  it("permits an honest goal-facing pose without inventing an unavailable endpoint", () => {
    const e = shot(); e.destination = { kind: "unavailable", x: null, y: null, observedHeightMeters: null, reason: "missing" };
    expect(buildNativeReplayGeometry(e)).toBeNull(); expect(nativePosePlacement(e)).not.toBeNull();
  });
  it.each(["unknown", "other"] as const)("does not invent a %s pose", part => {
    const e = shot(); e.bodyPart = part; expect(nativePosePlacement(e)).toBeNull();
  });
  it("rejects invalid or unlocated geometry before the clamping world converter", () => {
    for (const x of [NaN, Infinity, -1, 101, null]) {
      const e = shot(); e.plot.x = x;
      expect(buildNativeReplayGeometry(e)).toBeNull(); expect(nativePosePlacement(e)).toBeNull();
    }
    const e = shot(); e.plot = { state: "unlocated", x: null, y: null, reason: "missing" };
    expect(buildNativeReplayGeometry(e)).toBeNull(); expect(nativePosePlacement(e)).toBeNull();
    const g = buildNativeReplayGeometry(shot())!;
    expect(() => nativeReplayPoint(g, NaN)).toThrow(RangeError);
    expect(() => nativeReplayPolyline(g, 0)).toThrow(RangeError);
  });
});
