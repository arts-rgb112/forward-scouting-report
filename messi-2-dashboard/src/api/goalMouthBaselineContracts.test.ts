import { describe, expect, it } from "vitest";
import { goalMouthBaselineEnvelopeSchema } from "./goalMouthBaselineContracts";
import { goalMouthBaselineFixture, goalMouthBaselineLowSampleFixture } from "../test/fixtures/goalMouthBaseline";

describe("goal-mouth baseline v1 contract", () => {
  it("requires the exact fifty server cells and preserves their reported values", () => {
    const parsed = goalMouthBaselineEnvelopeSchema.parse(goalMouthBaselineFixture);
    expect(parsed.data.cells).toHaveLength(50);
    expect(parsed.data.cells[40]).toMatchObject({ cellId: "row5_column1", shots: 212, goals: 131 });
  });
  it("retains low-sample values with the server confidence interval", () => {
    const parsed = goalMouthBaselineEnvelopeSchema.parse(goalMouthBaselineLowSampleFixture);
    expect(parsed.data.cells[0]).toMatchObject({ state: "low_sample", lowSample: true, shots: 12, goals: 4, reason: "insufficient_baseline_sample" });
  });
  it("rejects flipped geometry and extra contract fields", () => {
    const invalid = structuredClone(goalMouthBaselineFixture); invalid.data.cells[40].zMin = 0;
    expect(goalMouthBaselineEnvelopeSchema.safeParse(invalid).success).toBe(false);
    expect(goalMouthBaselineEnvelopeSchema.safeParse({ ...goalMouthBaselineFixture, extra: true }).success).toBe(false);
  });
});
