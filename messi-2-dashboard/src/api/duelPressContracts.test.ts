import { describe, expect, it } from "vitest";
import validLeaderboard from "../../../docs/fixtures/duel_press_v1/valid_leaderboard.json";
import validDetail from "../../../docs/fixtures/duel_press_v1/valid_player_detail.json";
import invalidDiscriminator from "../../../docs/fixtures/duel_press_v1/invalid_discriminator.json";
import nullRaw from "../../../docs/fixtures/duel_press_v1/null_raw_metrics.json";
import observedZero from "../../../docs/fixtures/duel_press_v1/observed_zero.json";
import { duelPressDetailCoreSchema, duelPressLeaderboardCoreSchema, duelPressPlayerSchema, pressingRawMetricsSchema } from "./duelPressContracts";
const valid = duelPressPlayerSchema.parse(validLeaderboard.data[0]);
describe("duel-press 1.1.0 fixture contract", () => {
  it("parses authoritative leaderboard and detail fixtures", () => { expect(duelPressLeaderboardCoreSchema.safeParse(validLeaderboard).success).toBe(true); expect(duelPressDetailCoreSchema.safeParse(validDetail).success).toBe(true); });
  it("rejects invalid, row-duplicate and nested discriminators", () => { expect(duelPressDetailCoreSchema.safeParse(invalidDiscriminator).success).toBe(false); expect(duelPressPlayerSchema.safeParse({ ...valid, metricTaxonomyVersion: "duel-press-v1" }).success).toBe(false); expect(duelPressLeaderboardCoreSchema.safeParse({ ...validLeaderboard, meta: { ...validLeaderboard.meta, metricTaxonomyVersion: "duel-press-v1" } }).success).toBe(false); });
  it.each([["extra", { ...valid, extra: true }], ["missing", { ...valid, stats: { ...valid.stats, forwardPress: undefined } }], ["range", { ...valid, score: 101 }], ["NaN", { ...valid, components: { ...valid.components, recoveries: NaN } }], ["Infinity", { ...valid, stats: { ...valid.stats, combinedDuel: Infinity } }]])("rejects %s", (_name, value) => expect(duelPressPlayerSchema.safeParse(value).success).toBe(false));
  it("accepts fixture null and measured-zero raw states distinctly", () => { expect(pressingRawMetricsSchema.parse(nullRaw).recoveries).toBeNull(); expect(pressingRawMetricsSchema.parse(observedZero).recoveries).toBe(0); });
  it("enforces raw source truth", () => { expect(pressingRawMetricsSchema.safeParse({ ...observedZero, recoveries: null }).success).toBe(false); expect(pressingRawMetricsSchema.safeParse({ ...nullRaw, recoveriesPer90: 0 }).success).toBe(false); });
  it("validates detail response identity", () => expect(duelPressDetailCoreSchema.safeParse({ ...validDetail, context: { ...validDetail.context, playerId: 1 } }).success).toBe(false));
  it("accepts empty and overflow metadata but rejects returned mismatch", () => { const meta = { ...validLeaderboard.meta, population: 1, totalItems: 0, totalPages: 0, returned: 0, hasNextPage: false, page: 1 }; expect(duelPressLeaderboardCoreSchema.safeParse({ ...validLeaderboard, data: [], meta }).success).toBe(true); expect(duelPressLeaderboardCoreSchema.safeParse({ ...validLeaderboard, data: [], meta: { ...meta, totalItems: 1, totalPages: 1 } }).success).toBe(false); expect(duelPressLeaderboardCoreSchema.safeParse({ ...validLeaderboard, data: [], meta: { ...meta, totalItems: 1, totalPages: 1, page: 2 } }).success).toBe(true); });
  it("rejects rows beyond the last page's current capacity", () => { const rows = [valid, { ...valid, id: valid.id + 1 }]; const meta = { ...validLeaderboard.meta, page: 2, totalItems: 51, totalPages: 2, returned: 2, hasNextPage: false }; expect(duelPressLeaderboardCoreSchema.safeParse({ ...validLeaderboard, data: rows, meta }).success).toBe(false); });
});
