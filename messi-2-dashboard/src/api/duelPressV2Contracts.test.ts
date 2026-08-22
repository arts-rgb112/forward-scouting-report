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
  it("rejects taxonomy, score and extra-field drift", () => {
    const detail = fixture("complete_league").detail;
    expect(duelPressV2DetailMetricsSchema.safeParse({ ...detail, metricTaxonomyVersion: "duel-press-v1" }).success).toBe(false);
    expect(duelPressV2DetailMetricsSchema.safeParse({ ...detail, unexpected: true }).success).toBe(false);
    expect(duelPressV2DetailMetricsSchema.safeParse({ ...detail, categories: detail.categories.map((item: unknown, index: number) => index === 0 ? { ...(item as object), percentileScore: 100 } : item) }).success).toBe(false);
  });
});
