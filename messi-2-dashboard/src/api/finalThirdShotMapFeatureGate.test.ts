import { describe, expect, it } from "vitest";
import { finalThirdShotMapV2Enabled, finalThirdShotMapV3Enabled } from "./finalThirdShotMapFeatureGate";

describe("final-third effective-shot feature gate", () => {
  it("is exact opt-in and fail-closed", () => {
    expect(finalThirdShotMapV2Enabled({ VITE_FINAL_THIRD_SHOT_MAP_V2_ENABLED: "true" })).toBe(true);
    expect(finalThirdShotMapV2Enabled({ VITE_FINAL_THIRD_SHOT_MAP_V2_ENABLED: true })).toBe(false);
    expect(finalThirdShotMapV2Enabled({ VITE_FINAL_THIRD_SHOT_MAP_V2_ENABLED: "1" })).toBe(false);
  });
  it("keeps Goal-Mouth v3 fail-closed until explicitly enabled", () => {
    expect(finalThirdShotMapV3Enabled({ VITE_FINAL_THIRD_SHOT_MAP_V3_ENABLED: "true" })).toBe(true);
    expect(finalThirdShotMapV3Enabled({ VITE_FINAL_THIRD_SHOT_MAP_V3_ENABLED: "1" })).toBe(false);
  });
});
