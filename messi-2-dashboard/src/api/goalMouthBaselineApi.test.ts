import { describe, expect, it, vi } from "vitest";
import { buildGoalMouthBaselineUrl, fetchGoalMouthBaseline } from "./goalMouthBaselineApi";
import { goalMouthBaselineFixture } from "../test/fixtures/goalMouthBaseline";

const config = { baseUrl: "https://api.example.com", season: "2025/2026", scope: 8 as const, limit: 50 };
describe("goal-mouth baseline API", () => {
  it("uses the query-free global endpoint and omits credentials", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(goalMouthBaselineFixture))); vi.stubGlobal("fetch", fetcher);
    await expect(fetchGoalMouthBaseline(config, new AbortController().signal)).resolves.toEqual(goalMouthBaselineFixture);
    expect(new URL(buildGoalMouthBaselineUrl(config.baseUrl)).pathname).toBe("/api/v2/goal-mouth-baseline");
    expect(new URL(String(fetcher.mock.calls[0][0])).search).toBe("");
    expect(fetcher.mock.calls[0][1]).toMatchObject({ method: "GET", credentials: "omit" });
  });
  it("fails closed on schema drift", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ ...goalMouthBaselineFixture, baselineTaxonomyVersion: "wrong" }))));
    await expect(fetchGoalMouthBaseline(config, new AbortController().signal)).rejects.toMatchObject({ kind: "schema" });
  });
});
