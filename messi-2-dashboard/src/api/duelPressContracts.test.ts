import { describe, expect, it } from "vitest";
import { duelPressContextSchema, duelPressLeaderboardCoreSchema, duelPressRowCoreSchema, duelPressTopDiscriminatorSchema } from "./duelPressContracts";
import type { DuelPressRowCoreDto } from "./duelPressContracts";

const valid: DuelPressRowCoreDto = {
  id: 7, idNamespace: "fotmob", rank: 4, score: 88,
  stats: { outsideShot: 10, boxThreat: 20, dangerZone: 30, combinedDuel: 40, spaceControl: 50, forwardPress: 60 },
  components: { combinedDuelVolume: 0, combinedDuelEfficiency: 100, recoveries: 25, finalThirdPossessionsWon: 75 },
  pressingRawMetrics: { recoveries: 0, recoveriesPer90: 0, recoveriesSource: "player_season_total", finalThirdPossessionsWon: 10, finalThirdPossessionsWonPer90: 1.25, finalThirdPossessionsWonSource: "league_per90_fallback" },
};
describe("duel-press confirmed strict core", () => {
  it("preserves server assessment values and measured zero", () => expect(duelPressRowCoreSchema.parse(valid)).toEqual(valid));
  it.each([
    ["row discriminator", { ...valid, metricTaxonomyVersion: "duel-press-v1" }],
    ["extra", { ...valid, extra: true }], ["namespace", { ...valid, idNamespace: "internal" }],
    ["missing", { ...valid, stats: { ...valid.stats, forwardPress: undefined } }],
    ["range", { ...valid, score: 101 }], ["NaN", { ...valid, components: { ...valid.components, recoveries: Number.NaN } }],
    ["Infinity", { ...valid, stats: { ...valid.stats, combinedDuel: Infinity } }],
  ])("rejects %s", (_name, value) => expect(duelPressRowCoreSchema.safeParse(value).success).toBe(false));
  it("requires both raw numbers for either non-null source and neither for unavailable", () => {
    const unavailable = structuredClone(valid); unavailable.pressingRawMetrics.recoveries = null; unavailable.pressingRawMetrics.recoveriesPer90 = null; unavailable.pressingRawMetrics.recoveriesSource = null;
    expect(duelPressRowCoreSchema.safeParse(unavailable).success).toBe(true);
    for (const source of ["player_season_total", "league_per90_fallback"] as const) { const broken = structuredClone(valid); broken.pressingRawMetrics.recoveriesSource = source; broken.pressingRawMetrics.recoveries = null; expect(duelPressRowCoreSchema.safeParse(broken).success).toBe(false); }
  });
  it("accepts only the top-level discriminator core", () => { expect(duelPressTopDiscriminatorSchema.safeParse({ metricTaxonomyVersion: "duel-press-v1" }).success).toBe(true); expect(duelPressTopDiscriminatorSchema.safeParse({ metricTaxonomyVersion: "duel-press-v2" }).success).toBe(false); });
  it("enforces response mode context invariants", () => {
    expect(duelPressContextSchema.safeParse({ season: "2025/2026", mode: "league", scope: 8, competition: null }).success).toBe(true);
    expect(duelPressContextSchema.safeParse({ season: "2025/2026", mode: "europe", scope: null, competition: "ucl" }).success).toBe(true);
    expect(duelPressContextSchema.safeParse({ season: "2025/2026", mode: "league", scope: 8, competition: "all" }).success).toBe(false);
  });
  it("enforces unique IDs, returned length, page totals, empty and overflow cores", () => {
    const envelope = { metricTaxonomyVersion: "duel-press-v1", data: [valid], meta: { page: 1, pageSize: 50, totalItems: 1, totalPages: 1, returned: 1, hasNextPage: false } };
    expect(duelPressLeaderboardCoreSchema.safeParse(envelope).success).toBe(true);
    expect(duelPressLeaderboardCoreSchema.safeParse({ ...envelope, data: [valid, valid], meta: { ...envelope.meta, returned: 2, totalItems: 2 } }).success).toBe(false);
    expect(duelPressLeaderboardCoreSchema.safeParse({ ...envelope, data: [], meta: { ...envelope.meta, returned: 0 } }).success).toBe(false);
    expect(duelPressLeaderboardCoreSchema.safeParse({ metricTaxonomyVersion: "duel-press-v1", data: [], meta: { page: 3, pageSize: 50, totalItems: 1, totalPages: 1, returned: 0, hasNextPage: false } }).success).toBe(true);
  });
});
