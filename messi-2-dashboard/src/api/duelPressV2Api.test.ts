import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { duelPressV2PlayerSchema } from "./duelPressV2Contracts";
import { adaptDuelPressV2PlayerCore } from "./duelPressAdapter";
import { buildDuelPressV2DetailMetricsUrl, buildDuelPressV2LeaderboardUrl } from "./duelPressV2Api";

const league = { season: "2025/2026", mode: "league" as const, scope: 8 as const, competition: "all" as const };
const europe = { season: "2025/2026", mode: "europe" as const, scope: 8 as const, competition: "ucl" as const };

describe("duel-press-v2 URL contracts", () => {
  it("uses the authoritative raw M.E.S.S.I. score, not cohort percentile", () => {
    const source = JSON.parse(readFileSync("../docs/fixtures/duel_press_v2/complete_league.json", "utf8")).responses.player;
    const raw = structuredClone(source);
    raw.data.overallRating.rawValue = 82;
    raw.data.overallRating.percentileScore = 99;
    const player = adaptDuelPressV2PlayerCore(duelPressV2PlayerSchema.parse(raw).data);
    expect(player.score).toBe(82);
    expect(player.scorePercentile).toBe(99);
    raw.data.overallRating.rawValue = 0;
    const zero = adaptDuelPressV2PlayerCore(duelPressV2PlayerSchema.parse(raw).data);
    expect(zero.score).toBe(0);
  });
  it("serializes league context and fixed page size", () => {
    const url = new URL(buildDuelPressV2LeaderboardUrl("https://api.example.com", league, { page: 1, sort: "combinedDuel", order: "desc" }));
    expect(url.pathname).toBe("/api/v2/leaderboards/duel-press-v2");
    expect(url.searchParams.get("scope")).toBe("8");
    expect(url.searchParams.get("competition")).toBe("all");
    expect(url.searchParams.get("pageSize")).toBe("50");
  });
  it("omits scope for Europe detail context", () => {
    const url = new URL(buildDuelPressV2DetailMetricsUrl("https://api.example.com", 194165, europe));
    expect(url.searchParams.get("mode")).toBe("europe");
    expect(url.searchParams.get("competition")).toBe("ucl");
    expect(url.searchParams.has("scope")).toBe(false);
  });
});
