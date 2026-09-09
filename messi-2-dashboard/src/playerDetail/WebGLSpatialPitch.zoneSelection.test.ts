import { describe, expect, it } from "vitest";
import { shouldSelectZoneOnPointerUp } from "./WebGLSpatialPitch";
import { resolveTacticalZone20 } from "./pitchGeometry";

describe("persistent WebGL zone selection helpers", () => {
  it("uses the shared 20-zone IDs rather than legacy 30-cell IDs", () => {
    expect(resolveTacticalZone20(25, 70)?.id).toBe("6");
    expect(resolveTacticalZone20(75, 30)?.id).toBe("15");
  });

  it("allows only an uncancelled primary click to persist a zone", () => {
    expect(shouldSelectZoneOnPointerUp({ button: 0, moved: false, pinching: false, cancelled: false })).toBe(true);
    expect(shouldSelectZoneOnPointerUp({ button: 0, moved: true, pinching: false, cancelled: false })).toBe(false);
    expect(shouldSelectZoneOnPointerUp({ button: 2, moved: false, pinching: false, cancelled: false })).toBe(false);
    expect(shouldSelectZoneOnPointerUp({ button: 0, moved: false, pinching: true, cancelled: false })).toBe(false);
    expect(shouldSelectZoneOnPointerUp({ button: 0, moved: false, pinching: false, cancelled: true })).toBe(false);
  });
});
