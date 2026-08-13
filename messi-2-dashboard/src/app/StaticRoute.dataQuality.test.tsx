// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const transport = vi.hoisted(() => ({ detail: vi.fn(), quality: vi.fn() }));
vi.mock("../api/env", () => ({ parseMessiApiConfig: vi.fn(() => ({ baseUrl: "https://api.example.test", season: "2025/2026", scope: 7, limit: 1000 })) }));
vi.mock("../api/leaderboardsApi", () => ({ fetchPlayerDetail: transport.detail, fetchComparison: vi.fn() }));
vi.mock("../api/dataQualityApi", () => ({
  fetchPlayerDataQuality: transport.quality,
  DataQualityIdentityError: class DataQualityIdentityError extends Error {},
}));

import { StaticRoute } from "./StaticRoute";
import { samplePlayers } from "../test/fixtures/players";

const axes = (kind: "volume" | "ratio") => ["outsideShot", "boxThreat", "dangerZone", "aerial", "groundDuel", "spaceControl"].map((id) => ({ id, label: id === "spaceControl" ? "Space control" : id, score: id === "spaceControl" ? 20 : 80, percentile: 50, rank: 10, population: 100, rawValue: 1, tier: "B" as const, imputed: false, kind }));
const analysis = {
  score: { value: 82, rank: 10, topPercent: 90, population: 100, archetype: "Type A" as const },
  volumeRadar: { kind: "volume" as const, axes: axes("volume") }, ratioRadar: { kind: "ratio" as const, axes: axes("ratio") }, rawMetrics: {},
  spatial: { available: false, heatmapPointCount: 0, inBoxRatio: null, outBoxFinalRatio: null, midThirdRatio: null, finalThirdRatio: null, ccaAreaPct: null, laneRatios: [], dangerZoneDensity: null, deepBoxZoneScore: null },
};
const incomplete = { qualityVersion: "messi-quality-v1" as const, spatialAvailable: false, messiScoreComplete: false, reason: "spatial_session_missing" as const, imputedMetrics: ["spaceControl" as const], imputedComponents: ["spaceControl.volume"], observedWeightPct: 62.5, fallbackComponentScore: 20 as const };

beforeEach(() => {
  window.history.replaceState(null, "", "/players/1");
  transport.detail.mockResolvedValue({ player: samplePlayers[0], analysis });
  transport.quality.mockResolvedValue({ dataQuality: incomplete });
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
});
