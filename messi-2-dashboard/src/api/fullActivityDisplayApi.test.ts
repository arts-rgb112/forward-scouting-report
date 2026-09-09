import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildFullActivityDisplayUrl,
  fetchFullActivityDisplay,
  FullActivityDisplayApiError,
} from "./fullActivityDisplayApi";

const config = { baseUrl: "https://api.example.com", season: "2025/2026", scope: 8 as const, limit: 1000 };
const leagueContext = { season: "2025/2026", mode: "league" as const, scope: 8 as const, competition: "all" as const };

function responseFixture() {
  return {
    schemaVersion: "full-activity-display-v1",
    context: { playerId: 194165, ...leagueContext, competition: null },
    fullHeat: {
      available: true, reason: null,
      definitionVersion: "full-tier3-count-weighted-histogram-32x22-v1",
      columns: 32, rows: 22, cellCounts: [1, ...new Array(703).fill(0)],
      validPointCount: 1, activitySnapshotCount: 1,
      sourceDefinitionVersion: "sportsapi-heatmap-points-count-weighted-full-v1",
    },
    fullSourceCca: {
      available: true, reason: null,
      definitionVersion: "full-source-continuous-core-v1", formulaVersion: "fixed-n60-r20-v2",
      inputDefinition: "sportsapi-data-points-count-expanded-v1",
      heatmapDefinition: "full-tier3-count-weighted-histogram-32x22-v1",
      sourceRevision: "a".repeat(64),
      coverage: { expectedKeys: ["108579:35:77333"], observedKeys: ["108579:35:77333"], missingKeys: [] },
      gridColumns: 32, gridRows: 22, validPointCount: 1,
      standardizedTarget: 15, densityThreshold: 1, thresholdOfPeak: 0.5,
      coreAreaPct: 10, ccaAreaPct: 10, containedMassPct: 20, lowSample: true,
    },
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("full activity display transport", () => {
  it("serializes every context dimension without a league/europe cache collision", () => {
    const league = new URL(buildFullActivityDisplayUrl(config.baseUrl, 194165, leagueContext));
    expect(league.pathname).toBe("/api/v2/players/194165/full-activity-display-v1");
    expect(league.searchParams.get("scope")).toBe("8");
    expect(league.searchParams.has("competition")).toBe(false);

    const europe = new URL(buildFullActivityDisplayUrl(config.baseUrl, 194165, { ...leagueContext, mode: "europe", competition: "ucl" }));
    expect(europe.searchParams.has("scope")).toBe(false);
    expect(europe.searchParams.get("competition")).toBe("ucl");
  });

  it("accepts a same-context strict packet and rejects an echoed context mismatch", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(responseFixture()), { status: 200 })));
    await expect(fetchFullActivityDisplay(config, 194165, leagueContext, new AbortController().signal)).resolves.toMatchObject({ schemaVersion: "full-activity-display-v1" });

    const mismatch = responseFixture();
    mismatch.context.playerId = 194166;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(mismatch), { status: 200 })));
    await expect(fetchFullActivityDisplay(config, 194165, leagueContext, new AbortController().signal)).rejects.toBeInstanceOf(FullActivityDisplayApiError);
  });
});
