import { describe, expect, it } from "vitest";
import { shouldSelectZoneOnPointerUp, tacticalGridZoneId } from "./WebGLSpatialPitch";

describe("persistent WebGL zone selection helpers", () => {
  it("uses one-based server-facing tactical grid ids", () => {
    expect(tacticalGridZoneId(0, 0)).toBe("depth1_lane1");
    expect(tacticalGridZoneId(5, 4)).toBe("depth6_lane5");
  });

  it("allows only an uncancelled primary click to persist a zone", () => {
    expect(shouldSelectZoneOnPointerUp({ button: 0, moved: false, pinching: false, cancelled: false })).toBe(true);
    expect(shouldSelectZoneOnPointerUp({ button: 0, moved: true, pinching: false, cancelled: false })).toBe(false);
    expect(shouldSelectZoneOnPointerUp({ button: 2, moved: false, pinching: false, cancelled: false })).toBe(false);
    expect(shouldSelectZoneOnPointerUp({ button: 0, moved: false, pinching: true, cancelled: false })).toBe(false);
    expect(shouldSelectZoneOnPointerUp({ button: 0, moved: false, pinching: false, cancelled: true })).toBe(false);
  });
});
