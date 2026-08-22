// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { duelPressDetailReadoutEnvelopeSchema } from "../api/duelPressDetailReadoutContracts";
import { detailReadoutFixture } from "../test/fixtures/duelPressDetailReadouts";
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
  it("suppresses the legacy dossier category-score strip throughout an authoritative detail-readout request", () => {
    const readouts = duelPressDetailReadoutEnvelopeSchema.parse(detailReadoutFixture);
    const view = render(<PlayerTierCard player={player} analysis={analysis} quality={{ kind: "idle" }} detailReadouts={readouts} renewedDetailRequested/>);
    expect(view.container.querySelector('[aria-label="outsideShot"]')).toBeNull();
    expect(screen.queryByText(String(readouts.categories[1].score))).not.toBeInTheDocument();
    view.rerender(<PlayerTierCard player={player} analysis={analysis} quality={{ kind: "idle" }} renewedDetailRequested/>);
    expect(view.container.querySelector('[aria-label="박스 밖 슈팅"]')).toBeNull();
    expect(screen.queryByText("—")).not.toBeInTheDocument();
  });
  it("keeps tactical summary at exactly three lines even without spatial data", () => {
    render(<TacticalSummary player={player} analysis={analysis} quality={{ kind: "idle" }} />);
    expect(screen.getAllByRole("listitem")).toHaveLength(3);
  });
  it("uses one responsive perspective pitch with an exact positional grid and no synthetic shots", () => {
    render(<SpatialPitch analysis={analysis} />); const section = screen.getByRole("region", { name: "Spatial pitch" });
    expect(within(section).getByRole("img")).toHaveAttribute("viewBox", "0 0 1000 650"); expect(section.querySelectorAll("svg")).toHaveLength(1); expect(section.querySelectorAll("[data-grid-segment]")).toHaveLength(15); expect(section.querySelectorAll("[data-zone-label]")).toHaveLength(0); expect(section.querySelectorAll("[data-goal]")).toHaveLength(2); expect(section.querySelectorAll("[data-shot-marker]")).toHaveLength(0);
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
  it("keeps dossier and season naturally sized above a rail detail slot, then tactical/spatial and benchmarks", () => {
    const { container } = render(<PlayerDetailDossierLayout player={player} analysis={analysis} quality={{ kind: "idle" }} history={{ loading: false, entries: [], failed: 0, requestedSeasons: 0 }} dataset={{season:"2025/2026",mode:"league",scope:8,competition:"all"}} />);
    const outer = container.querySelector('[data-layout="detail-dossier-layout"]'); const rail = container.querySelector('[data-layout="detail-left-rail"]'); const dossierSeason = container.querySelector('[data-layout="dossier-season"]'); const slot = container.querySelector('[data-layout="detail-board-slot"]'); const benchmarks = container.querySelector('[data-layout="radar-benchmarks"]');
    expect(outer).toHaveClass("min-w-0", "xl:grid-cols-[minmax(528px,596px)_minmax(0,1fr)]", "xl:items-start");
    expect(rail).toHaveClass("min-w-0"); expect(dossierSeason).toHaveClass("min-w-0", "items-start", "md:grid-cols-[minmax(0,300px)_minmax(240px,280px)]"); expect(slot).toHaveClass("mt-4", "min-w-0"); expect(benchmarks).toHaveClass("mt-4", "min-w-0");
    const workspace = within(outer!).getByRole("region", { name: "Tactical and spatial analysis" }); const tactical = within(workspace).getByRole("region", { name: "Tactical summary" }); const pitch = within(workspace).getByRole("region", { name: "Spatial pitch" });
    expect(workspace).toHaveClass("min-w-0"); expect(workspace).toContainElement(tactical); expect(workspace).toContainElement(pitch);
    expect(tactical.compareDocumentPosition(pitch) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(dossierSeason!.compareDocumentPosition(slot!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy(); expect(slot!.compareDocumentPosition(workspace) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy(); expect(workspace.compareDocumentPosition(benchmarks!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(slot!).getByRole("region", { name: "Percentile profile" }).querySelector('[data-layout="legacy-percentile-grid"]')).toHaveClass("grid-cols-1", "sm:grid-cols-2");
  });
});
