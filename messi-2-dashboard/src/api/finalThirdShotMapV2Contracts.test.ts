import { describe, expect, it } from "vitest";
import { finalThirdShotMapV2EnvelopeSchema } from "./finalThirdShotMapV2Contracts";
import { finalThirdShotMapFixture } from "../test/fixtures/finalThirdShotMap";

const v2Fixture = () => {
  const value = structuredClone(finalThirdShotMapFixture) as any;
  value.schemaVersion = "2.0.0";
  value.chartTaxonomyVersion = "final-third-shot-map-effective-v2";
  value.data.conversionDefinition = "effective-on-target-plus-goal-divided-by-shots-v2";
  value.data.zones = value.data.zones.map((zone: any) => ({
    ...zone,
    effectiveShotCount: zone.shotsTotal === 0 ? 0 : zone.goals + 1,
    conversionRatePct: zone.shotsTotal === 0 ? null : Math.round(((zone.goals + 1) / zone.shotsTotal) * 100 * 100) / 100,
    fieldStates: {
      ...zone.fieldStates,
      effectiveShotCount: zone.shotsTotal === 0
        ? { state: "observed", reason: null, source: "player_season_shot_events", formulaVersion: null }
        : { state: "observed", reason: null, source: "player_season_shot_events", formulaVersion: "effective-on-target-plus-goal-divided-by-shots-v2" },
    },
  }));
  return value;
};

describe("final-third effective-shot v2 contract", () => {
  it("accepts the strict discriminator and server-owned effective count", () => {
    const parsed = finalThirdShotMapV2EnvelopeSchema.parse(v2Fixture());
    expect(parsed.schemaVersion).toBe("2.0.0");
    expect(parsed.chartTaxonomyVersion).toBe("final-third-shot-map-effective-v2");
    expect(parsed.data.conversionDefinition).toBe("effective-on-target-plus-goal-divided-by-shots-v2");
    expect(parsed.data.zones[2].effectiveShotCount).toBe(2);
    expect(parsed.data.zones[2].conversionRatePct).toBe(100);
  });

  it("rejects v1 payloads and preserves zero versus unavailable", () => {
    expect(finalThirdShotMapV2EnvelopeSchema.safeParse(finalThirdShotMapFixture).success).toBe(false);
    const value = v2Fixture();
    value.data.zones[0].shotsTotal = null;
    value.data.zones[0].goals = null;
    value.data.zones[0].effectiveShotCount = null;
    value.data.zones[0].conversionRatePct = null;
    value.data.zones[0].qualityEligibleShots = null;
    value.data.zones[0].state = "unavailable";
    value.data.zones[0].reason = "source_snapshot_missing";
    value.data.zones[0].source = null;
    value.data.zones[0].fieldStates.volume = { state: "unavailable", reason: "source_snapshot_missing", source: null, formulaVersion: null };
    value.data.zones[0].fieldStates.conversionRatePct = { state: "unavailable", reason: "source_snapshot_missing", source: null, formulaVersion: null };
    value.data.zones[0].fieldStates.qualityScore = { state: "unavailable", reason: "source_snapshot_missing", source: null, formulaVersion: null };
    value.data.zones[0].fieldStates.effectiveShotCount = { state: "unavailable", reason: "source_snapshot_missing", source: null, formulaVersion: null };
    const unavailable = finalThirdShotMapV2EnvelopeSchema.safeParse(value);
    expect(unavailable.success).toBe(true);
    const zero = v2Fixture();
    zero.data.zones[0].fieldStates.effectiveShotCount = { state: "observed", reason: null, source: "player_season_shot_events", formulaVersion: null };
    expect(finalThirdShotMapV2EnvelopeSchema.safeParse(zero).success).toBe(true);
  });
});
