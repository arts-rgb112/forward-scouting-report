import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchLeaderboard } from "./leaderboardsApi";

const config = { baseUrl: "https://api.example.test", season: "2025/2026", scope: 7 as const, limit: 1000 };
const player = { id: 1, rank: 1, name: "Player", position: "CF", archetype: "Type A", age: null, minutes: 100, tier: { code: "diamond", level: 1, label: "Diamond" }, score: 90, face: null, nation: null, league: { id: 1, name: "League", icon: null }, club: { id: 2, name: "Club", icon: null }, stats: { outsideShot: 1, boxThreat: 2, dangerZone: 3, aerial: 4, groundDuel: 5, spaceControl: 6 } };
const payload = { data: [player], meta: { schemaVersion: "2.1.0", season: "2025/2026", mode: "league", scope: 7, competition: "all", population: 910, returned: 1, page: 1, pageSize: 50, totalPages: 19, hasNextPage: true, generatedAt: "2026-08-10T00:00:00Z", source: "messi-static-cohort", applied: { position: null } } };

afterEach(() => vi.restoreAllMocks());

describe("leaderboard API pagination", () => {
  it("always sends pageSize=50 even when a stale caller supplies 250", async () => {
    const request = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify(payload), { headers: { "Content-Type": "application/json" } }));
    const result = await fetchLeaderboard(config, { season: "2025/2026", mode: "league", scope: 7, competition: "all" }, { page: 1, pageSize: 250, q: "", role: "all", position: "ALL", sort: "score", direction: "desc" }, new AbortController().signal);
    expect(new URL(String(request.mock.calls[0][0])).searchParams.get("pageSize")).toBe("50");
    expect(result.players).toHaveLength(1);
    expect(result.serverPage?.pageSize).toBe(50);
  });
});
