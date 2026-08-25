import { describe, expect, it } from "vitest";
import { goalMouthBaselineEnabled } from "./goalMouthBaselineFeatureGate";

describe("goal-mouth baseline feature gate", () => {
  it("is exact opt-in and otherwise fail-closed", () => {
    expect(goalMouthBaselineEnabled({ VITE_GOAL_MOUTH_BASELINE_ENABLED: "true" })).toBe(true);
    expect(goalMouthBaselineEnabled({ VITE_GOAL_MOUTH_BASELINE_ENABLED: "TRUE" })).toBe(false);
    expect(goalMouthBaselineEnabled({ VITE_GOAL_MOUTH_BASELINE_ENABLED: true })).toBe(false);
  });
});
