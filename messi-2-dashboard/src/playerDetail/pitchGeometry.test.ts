import { describe, expect, it } from "vitest";
import {
  boxSubregionDividerSegments,
  resolveTacticalZone20,
  TACTICAL_ZONE20,
  zone20Segments,
} from "./pitchGeometry";

describe("approved 20-zone presentation geometry", () => {
  it("defines all 20 named attack-direction cells without using legacy 30-cell boundaries", () => {
    expect(TACTICAL_ZONE20).toHaveLength(20);
    expect(TACTICAL_ZONE20.map((zone) => zone.id)).toEqual(Array.from({ length: 20 }, (_, index) => String(index + 1)));
    expect(resolveTacticalZone20(1, 90)?.label).toBe("1 · 수비 좌 와이드");
    expect(resolveTacticalZone20(25, 70)?.label).toBe("6 · 수비 좌 하프스페이스");
    expect(resolveTacticalZone20(75, 50)?.label).toBe("14 · 공격 중앙 채널");
    expect(resolveTacticalZone20(99, 50)?.label).toBe("20 · 공격 박스");
  });

  it("uses one half-open owner for every shared boundary, including the outer pitch edge", () => {
    expect(resolveTacticalZone20(50, 50)?.id).toBe("14");
    expect(resolveTacticalZone20(49.999, 50)?.id).toBe("7");
    expect(resolveTacticalZone20(84.29, 50)?.id).toBe("20");
    expect(resolveTacticalZone20(84.289, 50)?.id).toBe("14");
    expect(resolveTacticalZone20(100, 100)?.id).toBe("18");
  });

  it("adds only internal four-box dividers and never redraws the physical 84.29 penalty-box edge", () => {
    expect(boxSubregionDividerSegments()).toEqual([
      [84.29, 37, 100, 37], [84.29, 50, 100, 50], [84.29, 63, 100, 63],
      [0, 37, 15.71, 37], [0, 50, 15.71, 50], [0, 63, 15.71, 63],
    ]);
    expect(zone20Segments().some(([x0, , x1]) => x0 === 84.29 && x1 === 84.29)).toBe(false);
  });
});
