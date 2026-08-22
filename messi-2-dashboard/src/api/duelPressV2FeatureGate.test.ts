import { describe, expect, it } from "vitest";
import { duelPressV2Enabled } from "./duelPressV2FeatureGate";

describe("duel-press-v2 feature gate", () => {
  it("is fail-closed", () => {
    expect(duelPressV2Enabled({})).toBe(false);
    expect(duelPressV2Enabled({ VITE_DUEL_PRESS_V2_ENABLED: "false" })).toBe(false);
    expect(duelPressV2Enabled({ VITE_DUEL_PRESS_V2_ENABLED: "true" })).toBe(true);
  });
});

