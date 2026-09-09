// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { duelPressDetailReadoutEnvelopeSchema } from "../api/duelPressDetailReadoutContracts";
import { detailReadoutFixture } from "../test/fixtures/duelPressDetailReadouts";
import { samplePlayers } from "../test/fixtures/players";
import { PercentileProfile, PlayerDetailDossierLayout, PlayerTierCard, TacticalSummary, v2ContextMatches, VolumeBenchmarkRadar } from "./PlayerDetailRoute";
import { duelPressV2DetailMetricsSchema } from "../api/duelPressV2Contracts";
import { readFileSync } from "node:fs";
import { SpatialPitch } from "./SpatialPitch";

const player = samplePlayers[0];
const ids = ["outsideShot", "boxThreat", "dangerZone", "aerial", "groundDuel", "spaceControl"];
const axis = (id: string, score = 80) => ({ id, label: id, score, percentile: null, rank: null, population: 0, rawValue: null, tier: "B" as const, imputed: false });
const analysis = { score: { value: 81.99, rank: null, topPercent: null, population: 1, archetype: "Type A" as const }, volumeRadar: { kind: "volume" as const, axes: [...ids].reverse().map((id) => axis(id)) }, ratioRadar: { kind: "ratio" as const, axes: ids.map((id) => axis(id, 70)) }, rawMetrics: {}, spatial: { available: false, heatmapPointCount: 0, heatmapPoints: [], shotmapSnapshotAvailable: false, shotmapPointCount: 0, shotmapPoints: [], laneRatios: [], source: "messi-static-cohort", continuousCore: {}, inBoxRatio: null, outBoxFinalRatio: null, midThirdRatio: null, finalThirdRatio: null, ccaAreaPct: null, depthRatios: [], positionalGrid: [], trueCore: {}, dangerZoneDensity: null, deepBoxZoneScore: null } } as never;

describe("native player detail panels", () => {
  it("rejects a v2 detail envelope when its exact player context differs from the selected page", () => {
    const value = duelPressV2DetailMetricsSchema.parse(JSON.parse(readFileSync("../docs/fixtures/duel_press_v2/complete_league.json", "utf8")).responses.detail);
    const context = { season: value.context.season, mode: "league" as const, scope: value.context.scope as 3 | 5 | 7 | 8, competition: "all" as const };
    expect(v2ContextMatches(value, value.context.playerId, context)).toBe(true);
    expect(v2ContextMatches(value, value.context.playerId, { ...context, season: "2024/2025" })).toBe(false);
    expect(v2ContextMatches(value, value.context.playerId + 1, context)).toBe(false);
  });
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
  it("uses human-readable server category labels for the legacy score-strip ARIA names", () => {
    const readouts = duelPressDetailReadoutEnvelopeSchema.parse(detailReadoutFixture);
    const view = render(<PlayerTierCard player={player} analysis={analysis} quality={{ kind: "idle" }} detailReadouts={readouts} />);
    expect(view.container.querySelector('[aria-label="outsideShot"]')).toBeNull();
    expect(view.container.querySelector('[aria-label="공간 점유"]')).not.toBeNull();
  });
  it("keeps tactical summary at exactly three lines even without spatial data", () => {
    render(<TacticalSummary player={player} analysis={analysis} quality={{ kind: "idle" }} />);
    expect(screen.getAllByRole("listitem")).toHaveLength(3);
  });
  it("uses one responsive Three perspective pitch with an exact positional grid and no synthetic shots", async () => {
    render(<SpatialPitch analysis={analysis} />); const section = screen.getByRole("region", { name: "3D 회랑" });
    const pitch = await within(section).findByRole("img", { name: /3D 회랑 WebGL/ });
    expect(pitch).toHaveAttribute("data-webgl-renderer", "three"); expect(pitch).toHaveAttribute("data-gltf-loader", "GLTFLoader"); expect(section.querySelectorAll("canvas")).toHaveLength(1);
    // No fake 2D pitch fallback inside the actual WebGL canvas host — this
    // does NOT forbid the (legitimate, external-sibling) anatomical-figure
    // SVG in the info dock, so it must be scoped to the host itself, not
    // the whole "3D 회랑" section.
    expect(pitch.querySelectorAll("svg")).toHaveLength(0);
    expect(section.querySelectorAll("[data-grid-segment]")).toHaveLength(11); expect(section.querySelector('[data-zone-count="20"]')).toBeInTheDocument(); expect(section.querySelectorAll("[data-zone-label]")).toHaveLength(0); expect(section.querySelectorAll("[data-goal]")).toHaveLength(2); expect(section.querySelectorAll("[data-shot-marker]")).toHaveLength(0);
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
  it("puts one interactive arena scene before the tactical note and lazy-mounts the legacy pitch workspace", () => {
    window.history.replaceState(null, "", "/players/1?season=2025%2F2026&mode=league&scope=8&utm_source=slack");
    const { container } = render(<PlayerDetailDossierLayout player={player} analysis={analysis} quality={{ kind: "idle" }} history={{ loading: false, entries: [], failed: 0, requestedSeasons: 0 }} dataset={{season:"2025/2026",mode:"league",scope:8,competition:"all"}} />);
    const outer = container.querySelector('[data-layout="detail-dossier-layout"]'); const arena = container.querySelector('[data-layout="player-arena-stage"]'); const stack = container.querySelector('[data-layout="player-detail-section-stack"]'); const tacticalSlot = container.querySelector('[data-layout="tactical-summary-slot"]'); const summarySlot = container.querySelector('[data-layout="category-summary-slot"]'); const detailSlot = container.querySelector('[data-layout="category-detail-slot"]'); const radarSlot = container.querySelector('[data-layout="radar-slot"]'); const qualitySlot = container.querySelector('[data-layout="data-quality-slot"]');
    expect(outer).toHaveClass("min-w-0"); expect(arena).toBeInTheDocument(); expect(arena?.querySelectorAll("canvas")).toHaveLength(1); expect(arena?.querySelector('[data-pitch-presentation="arena"]')).toBeInTheDocument(); expect(within(arena as HTMLElement).getAllByRole("img", { name: "M.E.S.S.I. 카테고리 레이더 데이터 없음" })).toHaveLength(2);
    const workspace = within(outer!).getByRole("group", { name: "전술·공간 분석" }); const tactical = within(tacticalSlot!).getByRole("region", { name: "Tactical summary" });
    expect(outer).toContainElement(arena); expect(arena!.compareDocumentPosition(tacticalSlot!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy(); expect(tacticalSlot!.compareDocumentPosition(workspace) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy(); expect(workspace).not.toContainElement(tactical); expect(workspace.querySelector('[data-layout="pitch-workspace-slot"]')).toBeNull(); expect(tacticalSlot).toHaveClass("mt-3", "min-w-0"); expect(tacticalSlot?.tagName).toBe("DETAILS"); expect((tacticalSlot as HTMLDetailsElement).open).toBe(false); expect(within(tacticalSlot!).getByText("전술 분석 노트")).toBeInTheDocument(); fireEvent.click(within(workspace).getByText("보조 피치 분석")); const pitch = within(workspace).getByRole("region", { name: "피치 분석" }); const pitchSlot = workspace.querySelector('[data-layout="pitch-workspace-slot"]'); expect(within(pitch).getAllByRole("tab").length).toBeGreaterThanOrEqual(2); expect(within(pitch).getByRole("tab", { name: "2D 회랑" })).toHaveAttribute("aria-selected", "true");
    const threeDLink = within(workspace).getByRole("link", { name: "3D로 보기" });
    expect(threeDLink).toHaveAttribute("href", `/player/${player.id}/3d?season=2025%2F2026&mode=league&scope=8&utm_source=slack`); expect(threeDLink).toHaveAttribute("target", "_blank");
    expect(within(pitch).queryByRole("tab", { name: "3D 회랑" })).not.toBeInTheDocument();
    expect(within(pitch).queryByRole("tab", { name: "히트맵" })).not.toBeInTheDocument();
    expect(within(pitch).getAllByRole("tab")).toHaveLength(2);
    expect(pitchSlot).toContainElement(pitch); expect(tacticalSlot).toContainElement(tactical);
    expect(workspace.compareDocumentPosition(stack!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const orderedSlots = Array.from(stack!.children).map((node) => node.getAttribute("data-layout"));
    expect(orderedSlots).toEqual(["category-summary-slot", "category-detail-slot", "radar-slot", "data-quality-slot"]);
    [tacticalSlot, summarySlot, detailSlot, radarSlot, qualitySlot].forEach((slot) => expect(slot).toHaveClass("min-w-0", "w-full"));
    const profileGrid = within(summarySlot!).getByRole("region", { name: "Percentile profile" }).querySelector('[data-layout="legacy-percentile-grid"]')!;
    expect(profileGrid).toHaveClass("sm:grid-cols-2", "lg:grid-cols-3"); expect(profileGrid).toHaveAttribute("data-desktop-columns", "3"); expect(profileGrid.children).toHaveLength(6);
  });
  it("separates shooting and movement layers between the pitch tabs", async () => {
    const layeredAnalysis = { ...analysis, spatial: { ...analysis.spatial, available: true, heatmapPointCount: 3, heatmapPoints: [{ x: 80, y: 40 }, { x: 81, y: 42 }, { x: 82, y: 44 }], shotmapSnapshotAvailable: true, shotmapPointCount: 1, shotmapPoints: [{ x: 80, y: 40, outcome: "goal", xg: .4, xgot: .6, trajectory: { schemaVersion: "shotmap-trajectory-v1", endpointKind: "goal_mouth", endX: 100, endY: 52, endZMeters: 1.2, source: "fotmob" } }], continuousCore: { available: true, thresholdOfPeak: .5 } } } as never;
    const { container } = render(<PlayerDetailDossierLayout player={player} analysis={layeredAnalysis} quality={{ kind: "idle" }} history={{ loading: false, entries: [], failed: 0, requestedSeasons: 0 }} dataset={{season:"2025/2026",mode:"league",scope:8,competition:"all"}} />);
    fireEvent.click(within(container).getByText("보조 피치 분석"));
    const pitch = container.querySelector('[data-layout="pitch-workspace"]')!;
    const corridor = pitch.querySelector('[data-layout="six-lane-corridor-pitch"]')!;
    expect(corridor).toBeInTheDocument();
    expect(corridor.querySelectorAll("[data-lane]")).toHaveLength(6);
    expect(corridor.querySelector('[data-layer="positional-grid"]')).not.toBeNull();
    expect(corridor.querySelector('[data-layer="legacy-density"]')).toBeNull();
    expect(corridor.querySelector('[data-layer="cca-contour"]')).toBeNull();
    expect(corridor.querySelector('[data-layer="shot-trajectories-2d"]')).not.toBeNull();
    expect(corridor.querySelectorAll('[data-corridor-shot-marker]')).toHaveLength(1);
    expect(corridor.querySelector('[data-layer="pk-axis"]')).toBeNull();
    expect(within(corridor).getByRole("status")).toHaveTextContent("브라우저에서 값을 만들지 않았습니다");
    const toolbar = within(pitch).getByRole("group", { name: "피치 레이어" });
    ["궤적", "슈팅 마커"].forEach((name) => expect(within(toolbar).getByRole("button", { name })).toHaveAttribute("aria-pressed", "true"));
    expect(within(toolbar).queryByRole("button", { name: "히트맵" })).not.toBeInTheDocument();
    expect(within(toolbar).queryByRole("button", { name: "CCA" })).not.toBeInTheDocument();
    expect(within(pitch).queryByRole("tab", { name: "3D 회랑" })).not.toBeInTheDocument();
    fireEvent.click(within(pitch).getByRole("tab", { name: "골대맵" }));
    expect(within(pitch).queryByRole("group", { name: "피치 레이어" })).not.toBeInTheDocument();
    expect(pitch.querySelector('[data-layout="six-lane-corridor-pitch"]')).toBeNull();
    expect(pitch.querySelector('[data-webgl-renderer]')).toBeNull();
  });
});
