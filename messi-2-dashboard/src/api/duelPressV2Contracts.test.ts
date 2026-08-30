import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { duelPressV2DetailMetricsSchema, duelPressV2LeaderboardSchema, duelPressV2PlayerSchema, DUEL_PRESS_V2_XGOT_MINUS_XG_METRICS } from "./duelPressV2Contracts";

function fixture(name: string) { const value = JSON.parse(readFileSync(`../docs/fixtures/duel_press_v2/${name}.json`, "utf8")); return value.responses; }

describe("duel-press-v2 strict contracts", () => {
  it("accepts the canonical league detail, player and leaderboard fixtures", () => {
    const data = fixture("complete_league");
    expect(duelPressV2DetailMetricsSchema.safeParse(data.detail).success).toBe(true);
    expect(duelPressV2PlayerSchema.safeParse(data.player).success).toBe(true);
    expect(duelPressV2LeaderboardSchema.safeParse(data.leaderboard).success).toBe(true);
  });
  it("preserves partial and observed-zero pair states without coercion", () => {
    const partial = fixture("partial_pair");
    const zero = fixture("observed_zero");
    expect(duelPressV2DetailMetricsSchema.parse(partial.detail).categories[0].scoreState).toBe("imputed");
    const zeroMetric = duelPressV2DetailMetricsSchema.parse(zero.detail).categories[0].groups[0].metrics[0];
    expect(zeroMetric.total?.value).toBe(0);
  });
  it("accepts the server-owned xGOT minus xG pair metrics", () => {
    const detail = structuredClone(fixture("complete_league").detail);
    const outside = structuredClone(detail.categories[0].groups[0].metrics[2]);
    outside.id = DUEL_PRESS_V2_XGOT_MINUS_XG_METRICS[0];
    outside.label = "Outside-box xGOT minus xG";
    outside.total.value = 1.3866;
    outside.total.percentileScore = 98;
    outside.per90.value = 0.0524;
    outside.per90.percentileScore = 98;
    detail.categories[0].groups[0].metrics.splice(3, 0, outside);
    const parsed = duelPressV2DetailMetricsSchema.parse(detail);
    expect(parsed.categories[0].groups[0].metrics[3]).toMatchObject({ id: "outsideBoxXgotMinusXg", pairState: "complete" });

    const inBox = structuredClone(detail.categories[1].groups[0].metrics[2]);
    inBox.id = DUEL_PRESS_V2_XGOT_MINUS_XG_METRICS[1];
    inBox.label = "In-box xGOT minus xG";
    detail.categories[1].groups[0].metrics.splice(3, 0, inBox);
    expect(duelPressV2DetailMetricsSchema.parse(detail).categories[1].groups[0].metrics[3].id).toBe("inBoxXgotMinusXg");
  });
  it("accepts the additive score-unified v3 decimal headers while preserving legacy v2", () => {
    const legacy = structuredClone(fixture("complete_league").detail);
    const unified = structuredClone(legacy);
    unified.ratingVersion = "messi-score-unified-v3";
    unified.ratingSnapshotId = "messi-score-unified-v3:0123456789abcdef";
    unified.categories[0].percentileScore = 93.22;
    unified.categories[0].comparison.percentileScore = 93.22;
    unified.categories = unified.categories.map((category: { percentileScore: number; formulaId: string; formulaVersion: string }) => ({
      ...category,
      formulaId: "pressing-sector-score-v3",
      formulaVersion: "messi-score-unified-v3",
      scoreBreakdown: {
        compositeScore: category.percentileScore,
        volumeScore: category.percentileScore,
        ratioScore: category.percentileScore,
        volumeSample: { attempts: 20, minutes: 1800 },
        ratioSample: { attempts: 20, minutes: 1800 },
        sampleState: "observed",
      },
    }));
    expect(duelPressV2DetailMetricsSchema.safeParse(legacy).success).toBe(true);
    expect(duelPressV2DetailMetricsSchema.safeParse(unified).success).toBe(true);
    const pythonRoundingBoundaries = structuredClone(unified);
    pythonRoundingBoundaries.categories[0].scoreBreakdown = {
      ...pythonRoundingBoundaries.categories[0].scoreBreakdown,
      compositeScore: 93.22,
      volumeScore: 87.8,
      ratioScore: 98.65,
    };
    pythonRoundingBoundaries.categories[0].percentileScore = 93.22;
    pythonRoundingBoundaries.categories[1].scoreBreakdown = {
      ...pythonRoundingBoundaries.categories[1].scoreBreakdown,
      compositeScore: 93.13,
      volumeScore: 99.5,
      ratioScore: 86.77,
    };
    pythonRoundingBoundaries.categories[1].percentileScore = 93.13;
    expect(duelPressV2DetailMetricsSchema.safeParse(pythonRoundingBoundaries).success).toBe(true);
    const missingBreakdown = structuredClone(unified);
    delete missingBreakdown.categories[0].scoreBreakdown;
    expect(duelPressV2DetailMetricsSchema.safeParse(missingBreakdown).success).toBe(false);
    const mixedCategoryVersion = structuredClone(unified);
    mixedCategoryVersion.categories[0] = {
      ...mixedCategoryVersion.categories[0],
      formulaId: "stat-pairs-category-v2",
      formulaVersion: "stat-pairs-v2",
      scoreBreakdown: null,
    };
    expect(duelPressV2DetailMetricsSchema.safeParse(mixedCategoryVersion).success).toBe(false);
    const drift = structuredClone(unified);
    drift.categories[0].scoreBreakdown.compositeScore = 12;
    expect(duelPressV2DetailMetricsSchema.safeParse(drift).success).toBe(false);
  });
  it("rejects taxonomy, incompatible score-version and extra-field drift", () => {
    const detail = fixture("complete_league").detail;
    expect(duelPressV2DetailMetricsSchema.safeParse({ ...detail, metricTaxonomyVersion: "duel-press-v1" }).success).toBe(false);
    expect(duelPressV2DetailMetricsSchema.safeParse({ ...detail, unexpected: true }).success).toBe(false);
    expect(duelPressV2DetailMetricsSchema.safeParse({ ...detail, ratingVersion: "messi-score-unified-v3" }).success).toBe(false);
    expect(duelPressV2DetailMetricsSchema.safeParse({ ...detail, categories: detail.categories.map((item: unknown, index: number) => index === 0 ? { ...(item as object), percentileScore: 100.01 } : item) }).success).toBe(false);
  });
});
