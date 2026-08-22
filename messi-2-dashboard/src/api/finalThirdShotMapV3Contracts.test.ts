import { describe, expect, it } from "vitest";
import { finalThirdShotMapV3EnvelopeSchema } from "./finalThirdShotMapV3Contracts";
import { finalThirdShotMapFixture } from "../test/fixtures/finalThirdShotMap";

const v3Fixture = () => {
  const value = structuredClone(finalThirdShotMapFixture) as any;
  value.schemaVersion = "3.0.0";
  value.chartTaxonomyVersion = "final-third-shot-map-goal-mouth-v3";
  value.data.conversionDefinition = "effective-on-target-plus-goal-divided-by-shots-v2";
  value.data.shootingQuality = { totalShotCount: 2, eligibleShotCount: 1, xgTotal: .2, xgotTotal: .5, xgotMinusXg: .3, state: "partial", reason: "one_shot_missing_xg_or_xgot", source: "player_season_shot_events", formulaVersion: "sum-xgot-minus-sum-xg-v1" };
  value.data.zones = value.data.zones.map((zone: any) => ({ ...zone, effectiveShotCount: zone.shotsTotal === 0 ? 0 : zone.goals + 1, conversionRatePct: zone.shotsTotal === 0 ? null : Math.round(((zone.goals + 1) / zone.shotsTotal) * 100 * 100) / 100, fieldStates: { ...zone.fieldStates, effectiveShotCount: { state: "observed", reason: null, source: "player_season_shot_events", formulaVersion: null } } }));
  return value;
};

describe("final-third Goal-Mouth v3 contract", () => {
  it("accepts the strict v3 discriminator and server shooting-quality summary", () => {
    const parsed = finalThirdShotMapV3EnvelopeSchema.parse(v3Fixture());
    expect(parsed.schemaVersion).toBe("3.0.0");
    expect(parsed.chartTaxonomyVersion).toBe("final-third-shot-map-goal-mouth-v3");
    expect(parsed.data.shootingQuality.xgotMinusXg).toBe(.3);
  });

  it("rejects v1/v2 roots and preserves unavailable semantics", () => {
    expect(finalThirdShotMapV3EnvelopeSchema.safeParse(finalThirdShotMapFixture).success).toBe(false);
    const value = v3Fixture();
    value.data.shootingQuality = { totalShotCount: null, eligibleShotCount: null, xgTotal: null, xgotTotal: null, xgotMinusXg: null, state: "unavailable", reason: "competition_scoped_shot_event_snapshot_unavailable", source: null, formulaVersion: "sum-xgot-minus-sum-xg-v1" };
    expect(finalThirdShotMapV3EnvelopeSchema.safeParse(value).success).toBe(true);
    value.data.shootingQuality.xgotMinusXg = 0;
    expect(finalThirdShotMapV3EnvelopeSchema.safeParse(value).success).toBe(false);
  });
});
