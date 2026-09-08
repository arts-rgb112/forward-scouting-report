import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { boxSubregionEnvelopeSchema } from "./boxSubregionContracts";

// Reviewed, not-yet-activated fixture — see BOX_SUBREGION_TRANSPORT_PROPOSAL_20260908.md.
// Read from the shared spec location so this test and the backend fixture can
// never quietly diverge into two different "golden" datasets.
const fixture = JSON.parse(readFileSync(
  new URL("../../../../messi-specs/fixtures/box-subregion-kane-2025-2026-league8.json", import.meta.url),
  "utf-8",
));

describe("box-subregion-stats-v1 contract", () => {
  it("accepts the actual reviewed Kane fixture and preserves its golden values verbatim", () => {
    const parsed = boxSubregionEnvelopeSchema.parse(fixture);
    expect(parsed.regions.map((r) => r.id)).toEqual(["L4", "L3L", "L3R", "L2"]);
    expect(parsed.regions.map((r) => r.shots)).toEqual([9, 31, 33, 11]);
    expect(parsed.regions.map((r) => r.goals)).toEqual([2, 7, 11, 0]);
    expect(parsed.regions.map((r) => r.activity)).toEqual([38, 79, 68, 37]);
    expect(parsed.regions.map((r) => r.quality.delta)).toEqual([1.639, 1.7659, 0.7675, -0.3677]);
    expect(parsed.regions[1].quality.state).toBe("partial"); // centre-left 30/31 partial per the golden vector
    expect(parsed.accounting.inRegions.quality.eligible).toBe(83);
    expect(parsed.accounting.source.shots).toBe(119);
  });

  it("rejects unknown fields — this is a strict envelope, not an extensible one", () => {
    const result = boxSubregionEnvelopeSchema.safeParse({ ...fixture, extra: "not allowed" });
    expect(result.success).toBe(false);
  });

  it("rejects a percentage computed by multiplying an already-rounded fraction instead of round(n/d*100,4)", () => {
    const corrupted = structuredClone(fixture);
    corrupted.regions[0].shootingSharePct = 0.083333; // fraction, not percent — the exact mistake the spec warns against
    const result = boxSubregionEnvelopeSchema.safeParse(corrupted);
    expect(result.success).toBe(false);
  });

  it("rejects a malformed observed-zero region that nulls out quality instead of reporting actual zeros", () => {
    // shots=0/goals=0/xg=0 with quality nulled to unavailable — this is not a
    // legitimate "unavailable" sample (shots would be null there) nor a
    // legitimate observed-empty one (quality must be zero, not null).
    const corrupted = structuredClone(fixture);
    corrupted.regions[0].shots = 0;
    corrupted.regions[0].goals = 0;
    corrupted.regions[0].xg = 0;
    corrupted.regions[0].xgEligible = 0;
    corrupted.regions[0].quality = { xg: null, xgot: null, delta: null, eligible: 0, state: "unavailable" };
    corrupted.regions[0].shootingSharePct = 0;
    corrupted.regions[0].activitySharePct = fixture.regions[0].activitySharePct;
    const result = boxSubregionEnvelopeSchema.safeParse(corrupted);
    expect(result.success).toBe(false);
  });

  it("rejects observed-zero being confused with unavailable — missing is never zero", () => {
    const corrupted = structuredClone(fixture);
    corrupted.regions[0].shots = 0;
    corrupted.regions[0].goals = 0;
    corrupted.regions[0].xg = null; // an observed-zero region has xg 0, not null; null belongs only to "unavailable"
    const result = boxSubregionEnvelopeSchema.safeParse(corrupted);
    expect(result.success).toBe(false);
  });

  it("accepts a fully unavailable envelope with every field null, never fabricated zeros", () => {
    const unavailableQuality = { xg: null, xgot: null, delta: null, eligible: null, state: "unavailable" as const };
    const unavailableShots = { shots: null, goals: null, xg: null, xgEligible: null, quality: unavailableQuality };
    const unavailableCoverage = { state: "unavailable" as const, expectedKeys: [], observedKeys: [], missingKeys: [] };
    const envelope = {
      ...fixture,
      completeness: "unavailable",
      coverage: { shots: unavailableCoverage, activity: unavailableCoverage },
      denominators: { selectedNonPenaltyShots: null, fullActivityCount: null },
      regions: fixture.regions.map((r: Record<string, unknown>) => ({ ...r, ...unavailableShots, activity: null, shootingSharePct: null, activitySharePct: null })),
      accounting: { source: unavailableShots, inRegions: unavailableShots, penalties: unavailableShots, outside: unavailableShots, reconciles: null },
      activityAccounting: { source: null, inRegions: null, outside: null, reconciles: null },
    };
    expect(boxSubregionEnvelopeSchema.safeParse(envelope).success).toBe(true);
  });

  it("rejects an all-empty key selection claiming observed or partial — that legitimate empty state is unavailable-only", () => {
    const emptyKeys = { expectedKeys: [], observedKeys: [], missingKeys: [] };
    expect(boxSubregionEnvelopeSchema.safeParse({ ...fixture, coverage: { shots: { ...emptyKeys, state: "observed" }, activity: fixture.coverage.activity } }).success).toBe(false);
    expect(boxSubregionEnvelopeSchema.safeParse({ ...fixture, coverage: { shots: { ...emptyKeys, state: "partial" }, activity: fixture.coverage.activity } }).success).toBe(false);
  });

  it("rejects an unavailable coverage state carrying nonempty observed/missing keys — that legitimate empty state is unavailable-only", () => {
    const corrupted = structuredClone(fixture);
    corrupted.coverage.shots.state = "unavailable";
    corrupted.coverage.shots.observedKeys = []; corrupted.coverage.shots.missingKeys = ["1:2:3"]; corrupted.coverage.shots.expectedKeys = ["1:2:3"];
    const result = boxSubregionEnvelopeSchema.safeParse(corrupted);
    expect(result.success).toBe(false); // this shape is actually "partial" (observed empty, missing nonempty is impossible here — mismatched state)
  });

  it("rejects a partial shot source reporting complete quality on any summary", () => {
    const corrupted = structuredClone(fixture);
    corrupted.coverage.shots.state = "partial";
    corrupted.coverage.shots.missingKeys = ["9:9:9"];
    corrupted.coverage.shots.expectedKeys = [...corrupted.coverage.shots.expectedKeys, "9:9:9"];
    // regions[2] (L3R) is "complete" in the fixture; under a partial source this must not stand
    const result = boxSubregionEnvelopeSchema.safeParse(corrupted);
    expect(result.success).toBe(false);
  });
});
