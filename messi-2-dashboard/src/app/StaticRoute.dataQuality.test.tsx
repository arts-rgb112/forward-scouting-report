// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const transport = vi.hoisted(() => ({ detail: vi.fn(), quality: vi.fn(), quadrant: vi.fn() }));
vi.mock("../api/env", () => ({ parseMessiApiConfig: vi.fn(() => ({ baseUrl: "https://api.example.test", season: "2025/2026", scope: 7, limit: 1000 })) }));
vi.mock("../api/leaderboardsApi", () => ({ fetchPlayerDetail: transport.detail, fetchComparison: vi.fn(), fetchTacticalQuadrant: transport.quadrant }));
vi.mock("../api/dataQualityApi", () => ({
  fetchPlayerDataQuality: transport.quality,
  DataQualityIdentityError: class DataQualityIdentityError extends Error {},
}));

import { StaticRoute } from "./StaticRoute";
import { samplePlayers } from "../test/fixtures/players";

const axes = (kind: "volume" | "ratio") => ["outsideShot", "boxThreat", "dangerZone", "aerial", "groundDuel", "spaceControl"].map((id) => ({ id, label: id === "spaceControl" ? "Space control" : id, score: id === "spaceControl" ? 20 : 80, percentile: 50, rank: 10, population: 100, rawValue: 1, tier: "B" as const, imputed: false, kind }));
const emptyTrueCore = { available: false, gridVersion: "positional-6x5-v1" as const, definitionVersion: "true-core-50-v1" as const, targetDensityPct: 50 as const, achievedDensityPct: 0, zoneIds: [], zoneCount: 0, coreAreaPct: 0, tieBreak: "density-desc-depth-asc-lane-asc" as const, zones: [] };
const emptyContinuousCore = { available: false, definitionVersion: "continuous-hdr-50-v1" as const, targetDensityPct: 50 as const, achievedDensityPct: 0, coreAreaPct: 0, densityThreshold: 0, thresholdOfPeak: 0, gridColumns: 32 as const, gridRows: 22 as const };
const analysis = {
  score: { value: 82, rank: 10, topPercent: 90, population: 100, archetype: "Type A" as const },
  volumeRadar: { kind: "volume" as const, axes: axes("volume") }, ratioRadar: { kind: "ratio" as const, axes: axes("ratio") }, rawMetrics: {},
  spatial: { available: false, source: "messi-static-cohort" as const, heatmapPointCount: 0, heatmapPoints: [], shotmapPointCount: 0, shotmapPoints: [], shotmapSnapshotAvailable: false, continuousCore: emptyContinuousCore, inBoxRatio: null, outBoxFinalRatio: null, midThirdRatio: null, finalThirdRatio: null, ccaAreaPct: null, laneRatios: [], depthRatios: [], positionalGrid: [], trueCore: emptyTrueCore, dangerZoneDensity: null, deepBoxZoneScore: null },
};
const incomplete = { qualityVersion: "messi-quality-v1" as const, spatialAvailable: false, messiScoreComplete: false, reason: "spatial_session_missing" as const, imputedMetrics: ["spaceControl" as const], imputedComponents: ["spaceControl.volume"], observedWeightPct: 62.5, fallbackComponentScore: 20 as const };

beforeEach(() => {
  vi.clearAllMocks();
  window.history.replaceState(null, "", "/players/1?scope=7");
  transport.detail.mockResolvedValue({ player: samplePlayers[0], analysis });
  transport.quality.mockResolvedValue({ dataQuality: incomplete });
  transport.quadrant.mockResolvedValue({ playerId: 1, season: "2025/2026", mode: "league", scope: 7, competition: null, available: false, reason: "cohort_unavailable", source: "messi-static-cohort", cohortPopulation: 0, xAxis: "netProgressionPer90", yAxis: "inBoxXgotMinusXg", xMedian: null, yMedian: null, selectedPoint: null, points: [] });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("detail analysis data quality", () => {
  it("marks imputed spaceControl axis scores in both analysis tables, but adds nothing for complete quality", async () => {
    const view = render(<StaticRoute />);
    await screen.findByRole("heading", { name: samplePlayers[0].name });
    await waitFor(() => expect(screen.getAllByText("대체값")).toHaveLength(3));
    const spaceRows = screen.getAllByRole("row").filter((row) => row.textContent?.includes("Space control"));
    expect(spaceRows).toHaveLength(2);
    spaceRows.forEach((row) => expect(row).toHaveTextContent("20대체값"));
    expect(screen.getAllByTitle(/관측 데이터 비중: 62.5%/)).toHaveLength(2);

    transport.quality.mockResolvedValueOnce({ dataQuality: { ...incomplete, spatialAvailable: true, messiScoreComplete: true, reason: "complete", imputedMetrics: [], imputedComponents: [] } });
    view.unmount();
    render(<StaticRoute />);
    await screen.findByRole("heading", { name: samplePlayers[0].name });
    await waitFor(() => expect(screen.queryByText("대체값")).not.toBeInTheDocument());
  });

  it("renders server ranks, occupancy grid, and a companion tactical quadrant without coupling its failure to player detail", async () => {
    const positionalGrid = Array.from({ length: 30 }, (_, index) => ({ depth: Math.floor(index / 5) + 1, lane: index % 5 + 1, occupancyPct: index === 27 ? 12.5 : 0 }));
    const trueCore = { ...emptyTrueCore, available: true, achievedDensityPct: 52.5, zoneIds: ["depth6_lane3"], zoneCount: 1, coreAreaPct: 8.33, zones: [{ id: "depth6_lane3", depth: 6, lane: 3, densityPct: 52.5, areaPct: 8.33 }] };
    transport.detail.mockResolvedValueOnce({ player: samplePlayers[0], analysis: { ...analysis, spatial: { ...analysis.spatial, available: true, heatmapPointCount: 30, depthRatios: [1, 2, 3, 4, 5, 6], positionalGrid, trueCore } } });
    transport.quadrant.mockResolvedValueOnce({ playerId: 1, season: "2025/2026", mode: "league", scope: 7, competition: null, available: true, reason: "complete", source: "messi-static-cohort", cohortPopulation: 2, xAxis: "netProgressionPer90", yAxis: "inBoxXgotMinusXg", xMedian: 1, yMedian: 0, selectedPoint: { playerId: 1, playerName: samplePlayers[0].name, teamName: "Club", netProgressionPer90: 2, inBoxXgotMinusXg: 1, selected: true }, points: [{ playerId: 1, playerName: samplePlayers[0].name, teamName: "Club", netProgressionPer90: 2, inBoxXgotMinusXg: 1, selected: true }, { playerId: 2, playerName: "Peer", teamName: "Peer FC", netProgressionPer90: 0, inBoxXgotMinusXg: -1, selected: false }] });
    render(<StaticRoute />);
    await screen.findByRole("heading", { name: samplePlayers[0].name });
    await screen.findByRole("region", { name: "Positional grid" });
    expect(screen.getAllByRole("columnheader", { name: "Rank" })).toHaveLength(2);
    expect(screen.getAllByText("#10")).toHaveLength(12);
    const grid = screen.getByRole("region", { name: "Positional grid" });
    expect(within(grid).getByTitle("depth6_lane3: 12.5% · True Core zone")).toHaveClass("bg-cyan-400/20");
    expect(within(grid).getByRole("group", { name: "True Core summary" })).toHaveTextContent("1 cells · depth6_lane3");
    expect(within(grid).getByText("52.5% / target 50%")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Tactical quadrant" })).toHaveTextContent("Tactical quadrant");
    expect(screen.getByText("컴플리트 포워드")).toBeInTheDocument();
  });

  it("keeps the detail visible when the companion tactical quadrant request fails", async () => {
    transport.quadrant.mockRejectedValueOnce(new Error("unavailable"));
    render(<StaticRoute />);
    expect(await screen.findByRole("heading", { name: samplePlayers[0].name })).toBeInTheDocument();
    await waitFor(() => expect(transport.quadrant).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("region", { name: "Tactical quadrant" })).not.toBeInTheDocument();
  });

  it("renders unavailable, empty, and populated server shotmap states without inventing fallback shots", async () => {
    const unavailable = render(<StaticRoute />);
    await screen.findByRole("heading", { name: samplePlayers[0].name });
    expect(within(screen.getByRole("region", { name: "Shotmap and activity heatmap" })).queryByRole("img", { name: /goal, x/i })).not.toBeInTheDocument();

    unavailable.unmount();
    transport.detail.mockResolvedValueOnce({ player: samplePlayers[0], analysis: { ...analysis, spatial: { ...analysis.spatial, shotmapSnapshotAvailable: true } } });
    const empty = render(<StaticRoute />);
    await screen.findByRole("heading", { name: samplePlayers[0].name });
    expect(within(screen.getByRole("region", { name: "Shotmap and activity heatmap" })).queryByRole("img", { name: /goal, x/i })).not.toBeInTheDocument();

    empty.unmount();
    transport.detail.mockResolvedValueOnce({ player: samplePlayers[0], analysis: { ...analysis, spatial: { ...analysis.spatial, shotmapSnapshotAvailable: true, shotmapPointCount: 1, shotmapPoints: [{ x: 50, y: 40, outcome: "goal" as const, xg: 0.4, xgot: null }] } } });
    render(<StaticRoute />);
    await screen.findByRole("heading", { name: samplePlayers[0].name });
    expect(screen.getByRole("img", { name: "goal, x 50.0, y 40.0" })).toBeInTheDocument();
  });
});
