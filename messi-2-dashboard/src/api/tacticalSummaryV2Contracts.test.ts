import { describe, expect, it } from "vitest";
import { tacticalSummaryV2EnvelopeSchema } from "./tacticalSummaryV2Contracts";
import { tacticalSummaryV2Fixture, tacticalSummaryV2SubjectCoordinateLowFixture } from "../test/fixtures/tacticalSummaryV2";

describe("tactical-summary-v2 strict contract", () => {
  it("accepts the exact observed, low-sample, and unavailable server states", () => {
    for (const state of ["observed", "low_sample", "unavailable"] as const) expect(tacticalSummaryV2EnvelopeSchema.parse(tacticalSummaryV2Fixture(state)).tacticalSummaryVersion).toBe("tactical-summary-v2");
  });
  it("rejects unknown fields and scope-coerced contexts", () => {
    const fixture = tacticalSummaryV2Fixture();
    expect(tacticalSummaryV2EnvelopeSchema.safeParse({ ...fixture, extra: true }).success).toBe(false);
    expect(tacticalSummaryV2EnvelopeSchema.safeParse({ ...fixture, data: { ...fixture.data, cohortKey: { ...fixture.data.cohortKey, scope: 8 } } }).success).toBe(false);
  });
  it("rejects observed and low-sample state drift exactly like the server", () => {
    const fixture = tacticalSummaryV2Fixture();
    const observedTooSmall = { ...fixture, data: { ...fixture.data, positioning: { ...fixture.data.positioning, population: 19, provenance: { ...fixture.data.positioning.provenance, framePopulation: 19, eligiblePopulation: 19 } } } };
    const observedWithReason = { ...fixture, data: { ...fixture.data, positioning: { ...fixture.data.positioning, reason: "position_population_below_minimum" } } };
    const lowPopulationMismatch = tacticalSummaryV2Fixture("low_sample");
    const lowRange = lowPopulationMismatch.data.activityRange.frontBackActivityRange;
    lowRange.population = 20;
    lowRange.provenance.framePopulation = 20;
    lowRange.provenance.eligiblePopulation = 20;
    const lowWithoutReason = tacticalSummaryV2Fixture("low_sample");
    lowWithoutReason.data.activityRange.frontBackActivityRange.reason = null;
    expect(tacticalSummaryV2EnvelopeSchema.safeParse(observedTooSmall).success).toBe(false);
    expect(tacticalSummaryV2EnvelopeSchema.safeParse(observedWithReason).success).toBe(false);
    expect(tacticalSummaryV2EnvelopeSchema.safeParse(lowPopulationMismatch).success).toBe(false);
    expect(tacticalSummaryV2EnvelopeSchema.safeParse(lowWithoutReason).success).toBe(false);
    // This is a distinct, contract-valid low-sample cause: adequate cohort
    // population but too few valid subject coordinates. Do not reject it as
    // the position-population minimum case above.
    expect(tacticalSummaryV2EnvelopeSchema.safeParse(tacticalSummaryV2SubjectCoordinateLowFixture()).success).toBe(true);
  });
  it("requires top-level lowSample to follow the front-back readout state", () => {
    const observed = tacticalSummaryV2Fixture();
    const lowSample = tacticalSummaryV2Fixture("low_sample");
    const unavailable = tacticalSummaryV2Fixture("unavailable");
    expect(tacticalSummaryV2EnvelopeSchema.safeParse({ ...observed, data: { ...observed.data, lowSample: true } }).success).toBe(false);
    expect(tacticalSummaryV2EnvelopeSchema.safeParse({ ...lowSample, data: { ...lowSample.data, lowSample: false } }).success).toBe(false);
    expect(tacticalSummaryV2EnvelopeSchema.safeParse({ ...unavailable, data: { ...unavailable.data, cohortPopulation: 20, lowSample: true } }).success).toBe(false);
  });
});
