// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { samplePlayers } from "../test/fixtures/players";
import { PercentileProfile, PlayerTierCard, SpatialPitch, TacticalSummary, VolumeBenchmarkRadar } from "./PlayerDetailRoute";

const player = samplePlayers[0];
const ids = ["outsideShot", "boxThreat", "dangerZone", "aerial", "groundDuel", "spaceControl"];
const axis = (id: string, score = 80) => ({ id, label: id, score, percentile: null, rank: null, population: 0, rawValue: null, tier: "B" as const, imputed: false });
const analysis = { score: { value: 81.99, rank: null, topPercent: null, population: 1, archetype: "Type A" as const }, volumeRadar: { kind: "volume" as const, axes: [...ids].reverse().map((id) => axis(id)) }, ratioRadar: { kind: "ratio" as const, axes: ids.map((id) => axis(id, 70)) }, rawMetrics: {}, spatial: { available: false, heatmapPointCount: 0, heatmapPoints: [], shotmapSnapshotAvailable: false, shotmapPointCount: 0, shotmapPoints: [], laneRatios: [], source: "messi-static-cohort", continuousCore: {}, inBoxRatio: null, outBoxFinalRatio: null, midThirdRatio: null, finalThirdRatio: null, ccaAreaPct: null, depthRatios: [], positionalGrid: [], trueCore: {}, dangerZoneDensity: null, deepBoxZoneScore: null } } as never;

describe("native player detail panels", () => {
  it("floors the card score and exposes exactly six fixed metric abbreviations", () => {
    render(<PlayerTierCard player={player} analysis={analysis} quality={{ kind: "idle" }} />);
    expect(screen.getByText("81")).toBeInTheDocument();
    expect(["OTS", "BOX", "OBP", "AER", "GND", "OTB"].map((name) => screen.getByText(name))).toHaveLength(6);
  });
  it("keeps tactical summary at exactly three lines even without spatial data", () => {
    render(<TacticalSummary player={player} analysis={analysis} quality={{ kind: "idle" }} />);
    expect(screen.getAllByRole("listitem")).toHaveLength(3);
  });
  it("uses one horizontal pitch SVG without synthetic or focusable shot markers", () => {
    render(<SpatialPitch analysis={analysis} />); const section = screen.getByRole("region", { name: "Spatial pitch" });
    expect(within(section).getByRole("img")).toHaveAttribute("viewBox", "0 0 141 100"); expect(section.querySelectorAll("svg")).toHaveLength(1); expect(section.querySelectorAll("[tabindex]")).toHaveLength(0);
  });
  it("renders exactly six overall cards and twelve axis readouts by stable ids", () => {
    render(<PercentileProfile player={player} analysis={analysis} quality={{ kind: "idle" }} />); const section = screen.getByRole("region", { name: "Percentile profile" });
    expect(within(section).getAllByRole("heading", { level: 3 })).toHaveLength(6); expect(within(section).getAllByText(/score (80|70)/)).toHaveLength(12);
  });
  it("keeps the benchmark shell disabled behind its fail-closed feature flag", () => {
    render(<VolumeBenchmarkRadar player={player} dataset={{season:"2025/2026",mode:"league",scope:8,competition:"all"}} />); const section = screen.getByRole("region", { name: "Volume benchmark radar" });
    expect(section).toHaveTextContent("8-league benchmark is not enabled"); expect(section.querySelectorAll("[data-series]")).toHaveLength(0);
  });
});
