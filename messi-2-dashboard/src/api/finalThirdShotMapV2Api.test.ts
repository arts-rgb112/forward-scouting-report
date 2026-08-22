import { describe, expect, it } from "vitest";
import { buildFinalThirdShotMapV2Url } from "./finalThirdShotMapV2Api";

describe("final-third effective-shot v2 transport", () => {
  it("opts into the versioned conversion contract without changing context serialization", () => {
    const league = new URL(buildFinalThirdShotMapV2Url("https://api.example.com", 194165, { season: "2025/2026", mode: "league", scope: 8, competition: "all" }));
    expect(league.searchParams.get("conversionVersion")).toBe("effective-shot-v2");
    expect(league.searchParams.get("depthBand")).toBe("front2");
    expect(league.searchParams.get("scope")).toBe("8");
    const europe = new URL(buildFinalThirdShotMapV2Url("https://api.example.com", 194165, { season: "2025/2026", mode: "europe", scope: 8, competition: "ucl" }));
    expect(europe.searchParams.get("conversionVersion")).toBe("effective-shot-v2");
    expect(europe.searchParams.has("scope")).toBe(false);
    expect(europe.searchParams.get("competition")).toBe("ucl");
  });
});
