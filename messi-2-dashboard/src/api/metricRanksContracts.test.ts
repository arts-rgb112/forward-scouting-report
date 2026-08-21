import { describe, expect, it } from "vitest";
import { metricRanksRequestSchema, metricRanksResponseSchema } from "./metricRanksContracts";
import liveShapedResponse from "../../../docs/fixtures/metric_ranks_v1/valid_duel_press_response.json";

const context = { season: "2025/2026", mode: "league" as const, scope: 8 as const, competition: "all" as const };
const request = { entries: [{ key: "a", player: { idNamespace: "fotmob" as const, playerId: 1 }, metricTaxonomyVersion: "duel-press-v1" as const, context }] };
const metrics = { outsideShot: { rank: 1, population: 10 }, boxThreat: { rank: 2, population: 10 }, dangerZone: { rank: null, population: 10 }, combinedDuel: { rank: 4, population: 10 }, spaceControl: { rank: 5, population: 10 }, forwardPress: { rank: 6, population: 10 } };

describe("metric-ranks strict companion contract", () => {
  it("rejects duplicate client keys", () => expect(metricRanksRequestSchema.safeParse({ ...request, entries: [...request.entries, { ...request.entries[0] }] }).success).toBe(false));
  it("accepts only an entries-only duel taxonomy request", () => {
    expect(metricRanksRequestSchema.safeParse({ ...request, schemaVersion: "1.0.0" }).success).toBe(false);
    expect(metricRanksRequestSchema.safeParse({ entries: [{ ...request.entries[0], metricTaxonomyVersion: "legacy-v1" }] }).success).toBe(false);
    expect(metricRanksRequestSchema.safeParse({ entries: [{ ...request.entries[0], key: "x".repeat(501) }] }).success).toBe(false);
  });
  it("accepts an exact resolved duel result and rejects extra fields", () => {
    const valid = { schemaVersion: "1.0.0", results: [{ ...request.entries[0], status: "resolved", metrics }] };
    expect(metricRanksResponseSchema.safeParse(valid).success).toBe(true);
    expect(metricRanksResponseSchema.safeParse({ ...valid, extra: true }).success).toBe(false);
  });
  it("requires null metrics for unavailable entries and rejects rank beyond population", () => {
    expect(metricRanksResponseSchema.safeParse({ schemaVersion: "1.0.0", results: [{ ...request.entries[0], status: "unavailable", metrics: null }] }).success).toBe(true);
    expect(metricRanksResponseSchema.safeParse({ schemaVersion: "1.0.0", results: [{ ...request.entries[0], status: "resolved", metrics: { ...metrics, outsideShot: { rank: 11, population: 10 } } }] }).success).toBe(false);
  });
  it("accepts the deployed duel-press response fixture, including unavailable per-metric rank", () => {
    expect(metricRanksResponseSchema.safeParse(liveShapedResponse).success).toBe(true);
  });
});
