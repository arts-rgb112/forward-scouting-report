import { describe, expect, it, vi, afterEach } from "vitest";
import { buildBoxSubregionUrl, fetchBoxSubregionStats, BoxSubregionApiError } from "./boxSubregionApi";
import { readFileSync } from "node:fs";

const fixture = JSON.parse(readFileSync(
  new URL("../../../../messi-specs/fixtures/box-subregion-kane-2025-2026-league8.json", import.meta.url),
  "utf-8",
));

afterEach(() => { vi.unstubAllGlobals(); });

describe("box-subregion transport", () => {
  it("builds the reviewed route with existing league/Europe context rules — no new query keys", () => {
    const league = new URL(buildBoxSubregionUrl("https://api.example.com", 194165, { season: "2025/2026", mode: "league", scope: 8, competition: "all" }));
    expect(league.pathname).toBe("/api/v2/players/194165/box-subregion-stats");
    expect(league.searchParams.get("scope")).toBe("8");
    expect(league.searchParams.get("competition")).toBe("all");
    const europe = new URL(buildBoxSubregionUrl("https://api.example.com", 194165, { season: "2025/2026", mode: "europe", scope: 8, competition: "ucl" }));
    expect(europe.searchParams.has("scope")).toBe(false);
    expect(europe.searchParams.get("competition")).toBe("ucl");
  });

  it("today's real 404 (unmounted router) surfaces as not-found, never a fabricated fixture response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 404 })));
    await expect(fetchBoxSubregionStats(
      { baseUrl: "https://api.example.com", season: "2025/2026", scope: 8, limit: 1000 },
      194165, { season: "2025/2026", mode: "league", scope: 8, competition: "all" }, new AbortController().signal,
    )).rejects.toMatchObject({ kind: "not-found" });
  });

  it("accepts the reviewed fixture shape once the route is live and rejects an identity mismatch", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(fixture), { status: 200, headers: { "content-type": "application/json" } })));
    const config = { baseUrl: "https://api.example.com", season: "2025/2026", scope: 8, limit: 1000 };
    const request = { season: "2025/2026", mode: "league" as const, scope: 8 as const, competition: "all" as const };
    const data = await fetchBoxSubregionStats(config, 194165, request, new AbortController().signal);
    expect(data.regions.map((r) => r.shots)).toEqual([9, 31, 33, 11]);

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(fixture), { status: 200, headers: { "content-type": "application/json" } })));
    await expect(fetchBoxSubregionStats(config, 999999, request, new AbortController().signal))
      .rejects.toBeInstanceOf(BoxSubregionApiError);
  });

  it("rejects a malformed body as a schema error, not a silent empty state", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ not: "the contract" }), { status: 200, headers: { "content-type": "application/json" } })));
    await expect(fetchBoxSubregionStats(
      { baseUrl: "https://api.example.com", season: "2025/2026", scope: 8, limit: 1000 },
      194165, { season: "2025/2026", mode: "league", scope: 8, competition: "all" }, new AbortController().signal,
    )).rejects.toMatchObject({ kind: "schema" });
  });
});
