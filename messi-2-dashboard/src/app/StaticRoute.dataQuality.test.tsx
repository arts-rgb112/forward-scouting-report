// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const transport = vi.hoisted(() => ({ detail: vi.fn(), quality: vi.fn(), quadrant: vi.fn() }));
vi.mock("../api/env", () => ({ parseMessiApiConfig: vi.fn(() => ({ baseUrl: "https://api.example.test", season: "2025/2026", scope: 7, limit: 1000 })) }));
vi.mock("../api/leaderboardsApi", () => ({ fetchPlayerDetail: transport.detail, fetchComparison: vi.fn(), fetchTacticalQuadrant: transport.quadrant }));
vi.mock("../api/dataQualityApi", () => ({ fetchPlayerDataQuality: transport.quality, DataQualityIdentityError: class DataQualityIdentityError extends Error {} }));

import { StaticRoute, displayRadarAxisLabel } from "./StaticRoute";
import { samplePlayers } from "../test/fixtures/players";

const axes = (kind: "volume" | "ratio") => ["outsideShot", "boxThreat", "dangerZone", "aerial", "groundDuel", "spaceControl"].map((id) => ({ id, label: id === "spaceControl" ? "Space control" : id, score: id === "spaceControl" ? 20 : 80, percentile: 50, rank: 10, population: 100, rawValue: 1, tier: "B" as const, imputed: false, kind }));
const emptyTrueCore = { available: false, gridVersion: "positional-6x5-v1" as const, definitionVersion: "true-core-50-v1" as const, targetDensityPct: 50 as const, achievedDensityPct: 0, zoneIds: [], zoneCount: 0, coreAreaPct: 0, tieBreak: "density-desc-depth-asc-lane-asc" as const, zones: [] };
const emptyContinuousCore = { available: false, definitionVersion: "continuous-hdr-50-v1" as const, targetDensityPct: 50 as const, achievedDensityPct: 0, coreAreaPct: 0, densityThreshold: 0, thresholdOfPeak: 0, gridColumns: 32 as const, gridRows: 22 as const };
const analysis = { score: { value: 82, rank: 10, topPercent: 90, population: 100, archetype: "Type A" as const }, volumeRadar: { kind: "volume" as const, axes: axes("volume") }, ratioRadar: { kind: "ratio" as const, axes: axes("ratio") }, rawMetrics: {}, spatial: { available: false, source: "messi-static-cohort" as const, heatmapPointCount: 0, heatmapPoints: [], shotmapPointCount: 0, shotmapPoints: [], shotmapSnapshotAvailable: false, continuousCore: emptyContinuousCore, inBoxRatio: null, outBoxFinalRatio: null, midThirdRatio: null, finalThirdRatio: null, ccaAreaPct: null, laneRatios: [], depthRatios: [], positionalGrid: [], trueCore: emptyTrueCore, dangerZoneDensity: null, deepBoxZoneScore: null } };
const incomplete = { qualityVersion: "messi-quality-v1" as const, spatialAvailable: false, messiScoreComplete: false, reason: "spatial_session_missing" as const, imputedMetrics: ["spaceControl" as const], imputedComponents: ["spaceControl.volume"], observedWeightPct: 62.5, fallbackComponentScore: 20 as const };

beforeEach(() => { vi.clearAllMocks(); window.history.replaceState(null, "", "/players/1?scope=7"); transport.detail.mockResolvedValue({ player: samplePlayers[0], analysis }); transport.quality.mockResolvedValue({ dataQuality: incomplete }); transport.quadrant.mockResolvedValue({ playerId: 1, season: "2025/2026", mode: "league", scope: 7, competition: null, available: false, reason: "cohort_unavailable", source: "messi-static-cohort", cohortPopulation: 0, xAxis: "netProgressionPer90", yAxis: "inBoxXgotMinusXg", xMedian: null, yMedian: null, selectedPoint: null, points: [] }); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("native detail semantics", () => {
  it("preserves the composite-label compatibility boundary", () => {
    expect(displayRadarAxisLabel({ id: "dangerZone", label: "Dribbling" })).not.toBe("Dribbling");
    expect(displayRadarAxisLabel({ id: "other", label: "Dribbling" })).toBe("Dribbling");
  });
  it("shows imputed quality honestly and removes the marker when quality is complete", async () => {
    const first = render(<StaticRoute />); await screen.findByRole("heading", { name: samplePlayers[0].name });
    await waitFor(() => expect(screen.getAllByText("Conservative substitute").length).toBeGreaterThanOrEqual(1));
    expect(within(screen.getByRole("region", { name: "Percentile profile" })).getByText("Off-the-ball movement")).toBeInTheDocument();
    first.unmount(); transport.quality.mockResolvedValueOnce({ dataQuality: { ...incomplete, spatialAvailable: true, messiScoreComplete: true, reason: "complete", imputedMetrics: [], imputedComponents: [] } }); render(<StaticRoute />);
    await screen.findByRole("heading", { name: samplePlayers[0].name }); await waitFor(() => expect(screen.queryByText("Conservative substitute")).not.toBeInTheDocument());
  });
  it("always renders exactly three tactical lines and uses the server quadrant", async () => {
    transport.quadrant.mockResolvedValueOnce({ playerId: 1, season: "2025/2026", mode: "league", scope: 7, competition: null, available: true, reason: "complete", source: "messi-static-cohort", cohortPopulation: 2, xAxis: "netProgressionPer90", yAxis: "inBoxXgotMinusXg", xMedian: 1, yMedian: 0, selectedPoint: { playerId: 1, playerName: samplePlayers[0].name, teamName: "Club", netProgressionPer90: 2, inBoxXgotMinusXg: 1, selected: true }, points: [] });
    render(<StaticRoute />); await screen.findByRole("heading", { name: samplePlayers[0].name }); const summary = screen.getByRole("region", { name: "Tactical summary" });
    expect(within(summary).getAllByRole("listitem")).toHaveLength(3); expect(summary).toHaveTextContent("Complete forward");
  });
  it("renders unavailable, verified-zero, and populated actual shot states with a single non-tabbed SVG", async () => {
    const unavailable = render(<StaticRoute />); await screen.findByRole("heading", { name: samplePlayers[0].name }); let pitch = screen.getByRole("region", { name: "Spatial pitch" });
    expect(within(pitch).getByRole("img")).toHaveAccessibleName(/Activity heatmap unavailable.*Shot snapshot unavailable/); expect(pitch.querySelectorAll("[tabindex]")).toHaveLength(0); unavailable.unmount();
    transport.detail.mockResolvedValueOnce({ player: samplePlayers[0], analysis: { ...analysis, spatial: { ...analysis.spatial, shotmapSnapshotAvailable: true } } }); const zero = render(<StaticRoute />); await screen.findByRole("heading", { name: samplePlayers[0].name }); pitch = screen.getByRole("region", { name: "Spatial pitch" }); expect(within(pitch).getByRole("img")).toHaveAccessibleName(/Verified zero shots/); zero.unmount();
    transport.detail.mockResolvedValueOnce({ player: samplePlayers[0], analysis: { ...analysis, spatial: { ...analysis.spatial, available: true, heatmapPointCount: 1, heatmapPoints: [{ x: 50, y: 40 }], shotmapSnapshotAvailable: true, shotmapPointCount: 1, shotmapPoints: [{ x: 50, y: 40, outcome: "goal" as const, xg: 0.4, xgot: null }] } } }); render(<StaticRoute />); await screen.findByRole("heading", { name: samplePlayers[0].name }); pitch = screen.getByRole("region", { name: "Spatial pitch" });
    expect(within(pitch).getByRole("img")).toHaveAccessibleName(/1 activity points.*1 shots/); expect(pitch).toHaveTextContent("Goals 1"); expect(pitch.querySelectorAll("svg")).toHaveLength(1); expect(pitch.querySelectorAll("[tabindex]")).toHaveLength(0);
  });
});
