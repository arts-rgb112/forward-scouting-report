import { afterEach, describe, expect, it, vi } from "vitest";
import { buildFinalThirdShotMapUrl, fetchFinalThirdShotMap } from "./finalThirdShotMapApi";
import { finalThirdShotMapFixture } from "../test/fixtures/finalThirdShotMap";
const config = { baseUrl: "https://api.test", season: "2025/2026", scope: 8 as const, limit: 1000 };
afterEach(() => vi.unstubAllGlobals());
describe("final-third transport", () => {
  it("serializes exact league and Europe contexts", () => { const league = new URL(buildFinalThirdShotMapUrl(config.baseUrl, 1, { season: "2025/2026", mode: "league", scope: 8, competition: "all" })); expect(league.searchParams.get("scope")).toBe("8"); expect(league.searchParams.get("competition")).toBe("all"); expect(league.searchParams.get("depthBand")).toBe("front2"); const europe = new URL(buildFinalThirdShotMapUrl(config.baseUrl, 1, { season: "2025/2026", mode: "europe", scope: 8, competition: "ucl" })); expect(europe.searchParams.has("scope")).toBe(false); expect(europe.searchParams.get("competition")).toBe("ucl"); });
  it("rejects an echoed context mismatch", async () => { vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ ...finalThirdShotMapFixture, context: { ...finalThirdShotMapFixture.context, season: "2024/2025" } }), { status: 200 }))); await expect(fetchFinalThirdShotMap(config, 194165, { season: "2025/2026", mode: "league", scope: 8, competition: "all" }, new AbortController().signal)).rejects.toMatchObject({ kind: "schema" }); });
});
