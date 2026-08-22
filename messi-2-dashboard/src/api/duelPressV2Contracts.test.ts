import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { duelPressV2DetailMetricsSchema, duelPressV2LeaderboardSchema, duelPressV2PlayerSchema } from "./duelPressV2Contracts";

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
  it("rejects taxonomy, score and extra-field drift", () => {
    const detail = fixture("complete_league").detail;
    expect(duelPressV2DetailMetricsSchema.safeParse({ ...detail, metricTaxonomyVersion: "duel-press-v1" }).success).toBe(false);
    expect(duelPressV2DetailMetricsSchema.safeParse({ ...detail, unexpected: true }).success).toBe(false);
    expect(duelPressV2DetailMetricsSchema.safeParse({ ...detail, categories: detail.categories.map((item: unknown, index: number) => index === 0 ? { ...(item as object), percentileScore: 100 } : item) }).success).toBe(false);
  });
});
