import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { contextualCompareRequestSchema, parseContextualCompareResponse } from "./contextualCompareContracts";

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`../../../docs/fixtures/contextual_compare_v1/${name}`, import.meta.url), "utf8"));
const request = () => { const value = fixture("complete_league_europe_request.json"); value.left.player.playerId = 1; value.right.player.playerId = 2; return value; };
const response = () => fixture("complete_league_europe_response.json");
describe("contextual-compare-v1 strict sides", () => {
  it("accepts the canonical league/europe fixture", () => expect(parseContextualCompareResponse(response(), request())).toBeTruthy());
  it("rejects duplicate player/context requests before transport", () => { const value = request(); value.right = structuredClone(value.left); expect(() => contextualCompareRequestSchema.parse(value)).toThrow(); });
  it("isolates invalid_context while retaining a valid sibling", () => {
    const value = response(); value.right.status = "invalid_context"; value.right.summary = null; value.right.detail = null; value.right.dataQuality = null; value.right.tacticalQuadrant = null; value.right.duelPressPlayer = null; value.right.duelPressDetailReadout = null; value.right.componentAvailability = { detail: "unavailable", dataQuality: "unavailable", tacticalQuadrant: "unavailable" };
    expect(parseContextualCompareResponse(value, request()).right.status).toBe("invalid_context");
  });
  it("rejects malformed nested duel data, category order, indicators, and extra fields", () => {
    for (const mutate of [(value: any) => { value.left.duelPressPlayer.extra = true; }, (value: any) => { [value.left.duelPressDetailReadout.categories[0], value.left.duelPressDetailReadout.categories[1]] = [value.left.duelPressDetailReadout.categories[1], value.left.duelPressDetailReadout.categories[0]]; }, (value: any) => { value.left.duelPressDetailReadout.contextIndicators.pop(); }, (value: any) => { value.left.detail.extra = true; }]) { const value = response(); mutate(value); expect(() => parseContextualCompareResponse(value, request())).toThrow(); }
  });
});
