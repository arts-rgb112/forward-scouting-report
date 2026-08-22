import { describe, expect, it } from "vitest";
import { buildDuelPressV2DetailMetricsUrl, buildDuelPressV2LeaderboardUrl } from "./duelPressV2Api";

const league = { season: "2025/2026", mode: "league" as const, scope: 8 as const, competition: "all" as const };
const europe = { season: "2025/2026", mode: "europe" as const, scope: 8 as const, competition: "ucl" as const };

describe("duel-press-v2 URL contracts", () => {
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

