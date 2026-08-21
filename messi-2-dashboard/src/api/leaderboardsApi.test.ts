import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchComparison, fetchLeaderboard, fetchPlayerDetail, fetchTacticalQuadrant } from "./leaderboardsApi";

const config = { baseUrl: "https://api.example.test", season: "2025/2026", scope: 7 as const, limit: 1000 };
const player = { id: 1, rank: 1, name: "Player", position: "CF", archetype: "Type A", age: null, minutes: 100, tier: { code: "diamond", level: 1, label: "Diamond" }, score: 90, face: null, nation: null, league: { id: 1, name: "League", icon: null }, club: { id: 2, name: "Club", icon: null }, stats: { outsideShot: 1, boxThreat: 2, dangerZone: 3, aerial: 4, groundDuel: 5, spaceControl: 6 } };
const payload = { data: [player], meta: { schemaVersion: "2.1.0", season: "2025/2026", mode: "league", scope: 7, competition: null, population: 910, returned: 1, page: 1, pageSize: 50, totalPages: 19, hasNextPage: true, generatedAt: "2026-08-10T00:00:00Z", source: "messi-static-cohort", applied: { position: null } } };
const axisIds = ["outsideShot", "boxThreat", "dangerZone", "aerial", "groundDuel", "spaceControl"];
const axes = (kind: "volume" | "ratio") => ({ kind, axes: axisIds.map((id) => ({ id, label: id, score: 50, percentile: 50, rank: 5, population: 10, rawValue: 1, tier: "B", imputed: false })) });
const rawMetrics = { goals: null, xg: null, xgot: null, minutesPlayed: null, dribblesSucceeded: null, dribblesSuccessRate: null, dispossessed: null, foulsWon: null, penaltiesAwarded: null, duelsWon: null, duelsWonPercentage: null, aerialDuelsWon: null, aerialDuelsWonPercentage: null, inBoxGoals: null, inBoxXg: null, inBoxXgot: null, inBoxShots: null, outBoxGoals: null, outBoxXg: null, outBoxXgot: null, outBoxShots: null };
const analysis = { score: { value: 50, rank: 5, topPercent: 50, population: 10, archetype: "Type A" }, volumeRadar: axes("volume"), ratioRadar: axes("ratio"), rawMetrics, spatial: { available: false, source: "messi-static-cohort", heatmapPointCount: 0, heatmapPoints: [], shotmapPointCount: 0, shotmapPoints: [], shotmapSnapshotAvailable: false, inBoxRatio: null, outBoxFinalRatio: null, midThirdRatio: null, finalThirdRatio: null, ccaAreaPct: null, laneRatios: [], depthRatios: [], positionalGrid: [], trueCore: { available: false, gridVersion: "positional-6x5-v1", definitionVersion: "true-core-50-v1", targetDensityPct: 50, achievedDensityPct: 0, zoneIds: [], zoneCount: 0, coreAreaPct: 0, tieBreak: "density-desc-depth-asc-lane-asc", zones: [] }, continuousCore: { available: false, definitionVersion: "continuous-hdr-50-v1", targetDensityPct: 50, achievedDensityPct: 0, coreAreaPct: 0, densityThreshold: 0, thresholdOfPeak: 0, gridColumns: 32, gridRows: 22 }, dangerZoneDensity: null, deepBoxZoneScore: null } };
const comparisonPayload = { data: [{ ...player, analysis }, { ...player, id: 2, name: "Peer", analysis }], meta: { season: "2025/2026", mode: "league", scope: 7, competition: null, population: 10, generatedAt: "2026-08-10T00:00:00Z", source: "messi-static-cohort" } };

afterEach(() => vi.restoreAllMocks());

describe("leaderboard API pagination", () => {
  it("rejects a primary detail response whose player identity differs from the URL", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ data: { ...player, id: 2, idNamespace: "fotmob", analysis } }), { headers: { "Content-Type": "application/json" } }));
    await expect(fetchPlayerDetail(config, 1, { season: "2025/2026", mode: "league", scope: 7, competition: "all" }, new AbortController().signal)).rejects.toMatchObject({ kind: "schema" });
  });
  it("accepts a league competition=all request when the server meta correctly returns competition=null", async () => {
    const request = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify(payload), { headers: { "Content-Type": "application/json" } }));
    const result = await fetchLeaderboard(config, { season: "2025/2026", mode: "league", scope: 7, competition: "all" }, { page: 1, pageSize: 250, q: "", role: "all", position: "ALL", ageBand: "all", minutesBand: "all", sort: "score", direction: "desc" }, new AbortController().signal);
    expect(new URL(String(request.mock.calls[0][0])).searchParams.get("pageSize")).toBe("50");
    expect(result.players).toHaveLength(1);
    expect(result.serverPage?.pageSize).toBe(50);
  });

  it("rejects a non-null competition in league response metadata", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ ...payload, meta: { ...payload.meta, competition: "ucl" } }), { headers: { "Content-Type": "application/json" } }));
    await expect(fetchLeaderboard(config, { season: "2025/2026", mode: "league", scope: 7, competition: "all" }, { page: 1, pageSize: 50, q: "", role: "all", position: "ALL", ageBand: "all", minutesBand: "all", sort: "score", direction: "desc" }, new AbortController().signal)).rejects.toMatchObject({ kind: "schema" });
  });

  it("keeps Europe competition identity validation strict", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ ...payload, meta: { ...payload.meta, mode: "europe", scope: null, competition: "all" } }), { headers: { "Content-Type": "application/json" } }));
    await expect(fetchLeaderboard(config, { season: "2025/2026", mode: "europe", scope: 7, competition: "ucl" }, { page: 1, pageSize: 50, q: "", role: "all", position: "ALL", ageBand: "all", minutesBand: "all", sort: "score", direction: "desc" }, new AbortController().signal)).rejects.toMatchObject({ kind: "schema" });
  });

  it("validates and requests the separate tactical quadrant companion endpoint", async () => {
    const request = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ data: { playerId: 1, season: "2025/2026", mode: "league", scope: 7, competition: null, available: true, reason: "complete", source: "messi-static-cohort", cohortPopulation: 2, xAxis: "netProgressionPer90", yAxis: "inBoxXgotMinusXg", xMedian: 1, yMedian: 0, selectedPoint: { playerId: 1, playerName: "Player", teamName: "Club", netProgressionPer90: 2, inBoxXgotMinusXg: 1, selected: true }, points: [{ playerId: 1, playerName: "Player", teamName: "Club", netProgressionPer90: 2, inBoxXgotMinusXg: 1, selected: true }, { playerId: 2, playerName: "Peer", teamName: "Peer FC", netProgressionPer90: 0, inBoxXgotMinusXg: -1, selected: false }] } }), { headers: { "Content-Type": "application/json" } }));
    const result = await fetchTacticalQuadrant(config, 1, { season: "2025/2026", mode: "league", scope: 7, competition: "all" }, new AbortController().signal);
    expect(new URL(String(request.mock.calls[0][0])).pathname).toBe("/api/v2/players/1/tactical-quadrant");
    expect(new URL(String(request.mock.calls[0][0])).searchParams.get("competition")).toBe("all");
    expect(result.selectedPoint?.selected).toBe(true);
  });

  it("accepts comparison metadata that exactly matches the requested league context", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify(comparisonPayload), { headers: { "Content-Type": "application/json" } }));
    const result = await fetchComparison(config, [1, 2], { season: "2025/2026", mode: "league", scope: 7, competition: "all" }, new AbortController().signal);
    expect(result.meta).toMatchObject({ season: "2025/2026", mode: "league", scope: 7, competition: null });
    expect(result.players).toHaveLength(2);
  });

  it("rejects comparison metadata with a mismatched league scope", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ ...comparisonPayload, meta: { ...comparisonPayload.meta, scope: 5 } }), { headers: { "Content-Type": "application/json" } }));
    await expect(fetchComparison(config, [1, 2], { season: "2025/2026", mode: "league", scope: 7, competition: "all" }, new AbortController().signal)).rejects.toMatchObject({ kind: "schema" });
  });

  it("keeps Europe comparison competition identity strict", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ ...comparisonPayload, meta: { ...comparisonPayload.meta, mode: "europe", scope: null, competition: "uel" } }), { headers: { "Content-Type": "application/json" } }));
    await expect(fetchComparison(config, [1, 2], { season: "2025/2026", mode: "europe", scope: 7, competition: "ucl" }, new AbortController().signal)).rejects.toMatchObject({ kind: "schema" });
  });
});
