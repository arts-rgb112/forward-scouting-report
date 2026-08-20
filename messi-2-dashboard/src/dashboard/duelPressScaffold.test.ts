import { describe, expect, it } from "vitest";
import { buildDuelPressDetailUrl, buildDuelPressLeaderboardUrl, duelPressFetchInit, duelPressResourceKey, duelPressStatusError } from "../api/duelPressApi";
import { leaderboardTaxonomyMode } from "../api/duelPressFeatureGate";
import { duelPressTaxonomyRegistry } from "./duelPressRegistry";
import { duelPressSearchFromUrl } from "./duelPressRoute";
import { classifyDuelPressPage } from "./duelPressResourceState";
import { verifyCommittedDuelPressFixtures } from "../test/duelPressFixtureVerifier";
const league = { season: "2025/2026", mode: "league" as const, scope: 8 as const, competition: "all" as const };
const europe = { season: "2025/2026", mode: "europe" as const, scope: null, competition: "ucl" as const };
describe("duel-press isolated scaffold", () => {
  it("keeps exact registry order/copy without cross keys", () => {
    expect(duelPressTaxonomyRegistry["duel-press-v1"].metricKeys).toEqual(["outsideShot", "boxThreat", "dangerZone", "combinedDuel", "spaceControl", "forwardPress"]);
    expect(duelPressTaxonomyRegistry["duel-press-v1"].config.combinedDuel).toEqual({ label: "통합 경합", short: "경합", detail: "지상·공중 경합의 시도량과 승패 마진을 각각 정규화해 균등 결합한 종합 경합 영향력입니다." });
    expect(duelPressTaxonomyRegistry["duel-press-v1"].config.forwardPress.detail).toBe("파이널 서드에서의 소유권 획득과 경기 전체의 볼 회수 빈도를 동일 코호트 백분위로 변환한 뒤 50:50으로 결합한 압박·세컨드볼 회수 지표입니다.");
    expect("aerial" in duelPressTaxonomyRegistry["duel-press-v1"].config).toBe(false);
  });
  it("defaults production to companion and retains an explicit rollback", () => { expect(leaderboardTaxonomyMode({}, "production")).toBe("duel-press-v1"); expect(leaderboardTaxonomyMode({ VITE_DUEL_PRESS_LEADERBOARD_ENABLED: "false" }, "production")).toBe("legacy-v1"); expect(leaderboardTaxonomyMode({}, "test")).toBe("legacy-v1"); });
  it("verifies all seven committed fixtures by schema rather than caller booleans", () => expect(verifyCommittedDuelPressFixtures()).toEqual({ fileCount: 7, valid: true }));
  it("serializes exact mode queries and omits credentials", () => {
    expect(buildDuelPressLeaderboardUrl("https://api.test", { context: league, page: 2, sort: "combinedDuel", order: "asc" })).toBe("https://api.test/api/v2/leaderboards/duel-press?season=2025%2F2026&mode=league&scope=8&competition=all&page=2&pageSize=50&sort=combinedDuel&order=asc");
    const detail = new URL(buildDuelPressDetailUrl("https://api.test", 7, europe)); expect(detail.searchParams.has("scope")).toBe(false); expect(detail.searchParams.get("competition")).toBe("ucl");
    expect(duelPressFetchInit().credentials).toBe("omit"); expect(buildDuelPressLeaderboardUrl("https://api.test", { context: league, page: 1, sort: "score", order: "desc" })).not.toContain("direction");
  });
  it("keys taxonomy, endpoint, context and query", () => expect(duelPressResourceKey("leaderboard", league, "page=1")).not.toBe(duelPressResourceKey("player:7", league, "page=1")));
  it("classifies confirmed HTTP failures without fallback", () => { expect(duelPressStatusError(404).kind).toBe("not-found"); expect(duelPressStatusError(422).kind).toBe("invalid-request"); expect(duelPressStatusError(500).kind).toBe("network"); });
  it("normalizes only cross-taxonomy sorts", () => { expect(duelPressSearchFromUrl("?sort=aerial&direction=asc&page=8")).toMatchObject({ page: 1, pageSize: 50, sort: "score", direction: "desc" }); expect(duelPressSearchFromUrl("?sort=forwardPress&direction=asc&page=3")).toMatchObject({ page: 3, sort: "forwardPress", direction: "asc" }); });
  it("guards unsafe page and player IDs", () => { expect(() => buildDuelPressLeaderboardUrl("https://api.test", { context: league, page: Number.MAX_SAFE_INTEGER + 1, sort: "score", order: "desc" })).toThrow(); expect(() => buildDuelPressDetailUrl("https://api.test", 0, league)).toThrow(); });
  it("distinguishes empty dataset from overflow without page normalization", () => { expect(classifyDuelPressPage({ page: 1, pageSize: 50, totalItems: 0, totalPages: 0, returned: 0, hasNextPage: false })).toBe("empty-dataset"); expect(classifyDuelPressPage({ page: 9, pageSize: 50, totalItems: 51, totalPages: 2, returned: 0, hasNextPage: false })).toBe("overflow"); });
});
