import { describe, expect, it } from "vitest";
import { buildFinalThirdShotMapV3Url } from "./finalThirdShotMapV3Api";

describe("final-third Goal-Mouth v3 transport", () => {
  it("opts into v3 while preserving league and Europe context rules", () => {
    const league = new URL(buildFinalThirdShotMapV3Url("https://api.example.com", 194165, { season: "2025/2026", mode: "league", scope: 8, competition: "all" }));
    expect(league.searchParams.get("conversionVersion")).toBe("goal-mouth-v3");
    expect(league.searchParams.get("depthBand")).toBe("front2");
    expect(league.searchParams.get("scope")).toBe("8");
    const europe = new URL(buildFinalThirdShotMapV3Url("https://api.example.com", 194165, { season: "2025/2026", mode: "europe", scope: 8, competition: "ucl" }));
    expect(europe.searchParams.get("conversionVersion")).toBe("goal-mouth-v3");
    expect(europe.searchParams.has("scope")).toBe(false);
    expect(europe.searchParams.get("competition")).toBe("ucl");
  });
});
