// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { samplePlayers } from "../test/fixtures/players";
import { PercentileProfile, PlayerDetailDossierLayout, PlayerTierCard, SpatialPitch, TacticalSummary, VolumeBenchmarkRadar } from "./PlayerDetailRoute";

const player = samplePlayers[0];
const ids = ["outsideShot", "boxThreat", "dangerZone", "aerial", "groundDuel", "spaceControl"];
const axis = (id: string, score = 80) => ({ id, label: id, score, percentile: null, rank: null, population: 0, rawValue: null, tier: "B" as const, imputed: false });
const analysis = { score: { value: 81.99, rank: null, topPercent: null, population: 1, archetype: "Type A" as const }, volumeRadar: { kind: "volume" as const, axes: [...ids].reverse().map((id) => axis(id)) }, ratioRadar: { kind: "ratio" as const, axes: ids.map((id) => axis(id, 70)) }, rawMetrics: {}, spatial: { available: false, heatmapPointCount: 0, heatmapPoints: [], shotmapSnapshotAvailable: false, shotmapPointCount: 0, shotmapPoints: [], laneRatios: [], source: "messi-static-cohort", continuousCore: {}, inBoxRatio: null, outBoxFinalRatio: null, midThirdRatio: null, finalThirdRatio: null, ccaAreaPct: null, depthRatios: [], positionalGrid: [], trueCore: {}, dangerZoneDensity: null, deepBoxZoneScore: null } } as never;

describe("native player detail panels", () => {
  it("floors the card score and exposes exactly six fixed metric abbreviations", () => {
    const { container } = render(<PlayerTierCard player={player} analysis={analysis} quality={{ kind: "idle" }} />);
    expect(screen.getByText("81")).toBeInTheDocument();
    expect(["OTS", "BOX", "OBP", "AER", "GND", "OTB"].map((name) => screen.getByText(name))).toHaveLength(6);
    expect(container.querySelector('svg[aria-hidden="true"]')).toHaveClass("right-0", "sm:-right-8");
  });
  it("keeps tactical summary at exactly three lines even without spatial data", () => {
    render(<TacticalSummary player={player} analysis={analysis} quality={{ kind: "idle" }} />);
    expect(screen.getAllByRole("listitem")).toHaveLength(3);
  });
  it("uses one responsive perspective pitch with an exact positional grid and no synthetic shots", () => {
    render(<SpatialPitch analysis={analysis} />); const section = screen.getByRole("region", { name: "Spatial pitch" });
    expect(within(section).getByRole("img")).toHaveAttribute("viewBox", "0 0 1000 650"); expect(section.querySelectorAll("svg")).toHaveLength(1); expect(section.querySelectorAll("[data-zone-label]")).toHaveLength(30); expect(section.querySelectorAll("[data-shot-marker]")).toHaveLength(0);
  });
  it("renders a six-sector, server-readout board with accessible non-fabricated score bars", () => {
    render(<PercentileProfile player={player} analysis={analysis} quality={{ kind: "idle" }} />); const section = screen.getByRole("region", { name: "Percentile profile" });
    expect(section).toHaveClass("six-sector-board"); expect(within(section).getAllByRole("heading", { level: 3 })).toHaveLength(6); expect(within(section).getAllByText(/score (80|70)/)).toHaveLength(12);
    expect(within(section).getAllByRole("progressbar")).toHaveLength(6); expect(within(section).getByRole("progressbar", { name: "Outside-the-box shooting server score" })).toHaveAttribute("aria-valuenow", String(player.stats.outsideShot));
    expect(within(section).getAllByText(/Raw: volume unavailable · ratio unavailable/)).toHaveLength(6);
  });
  it("keeps the benchmark shell disabled behind its fail-closed feature flag", () => {
    render(<VolumeBenchmarkRadar player={player} dataset={{season:"2025/2026",mode:"league",scope:8,competition:"all"}} />); const section = screen.getByRole("region", { name: "Volume benchmark radar" });
    expect(section).toHaveTextContent("8-league benchmark is not enabled"); expect(section.querySelectorAll("[data-series]")).toHaveLength(0);
  });
  it("keeps the dossier, season rail, and tactical-to-spatial workspace responsive without a fixed mobile width", () => {
    const { container } = render(<PlayerDetailDossierLayout player={player} analysis={analysis} quality={{ kind: "idle" }} history={{ loading: false, entries: [], failed: 0, requestedSeasons: 0 }} dataset={{season:"2025/2026",mode:"league",scope:8,competition:"all"}} />);
    const top = container.querySelector('[data-layout="dossier-season-analysis"]'); const lower = container.querySelector('[data-layout="sectors-radar"]');
    expect(top).toHaveClass("min-w-0", "md:grid-cols-2", "lg:grid-cols-[minmax(272px,300px)_minmax(240px,280px)_minmax(0,1fr)]");
    expect(lower).toHaveClass("min-w-0", "lg:grid-cols-[5fr_7fr]");
    const workspace = within(top!).getByRole("region", { name: "Tactical and spatial analysis" }); const tactical = within(workspace).getByRole("region", { name: "Tactical summary" }); const pitch = within(workspace).getByRole("region", { name: "Spatial pitch" });
    expect(workspace).toHaveClass("md:col-span-2", "lg:col-span-1"); expect(workspace).toContainElement(tactical); expect(workspace).toContainElement(pitch);
    expect(tactical.compareDocumentPosition(pitch) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
