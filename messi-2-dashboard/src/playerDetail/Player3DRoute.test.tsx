// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fullActivityDisplayEnvelopeSchema } from "../api/fullActivityDisplayContracts";

const mocks = vi.hoisted(() => ({
  fetchPlayerDetail: vi.fn(),
  fullActivityDisplay: undefined as unknown,
}));

vi.mock("../api/leaderboardsApi", () => ({ fetchPlayerDetail: mocks.fetchPlayerDetail }));
vi.mock("./useFullActivityDisplay", () => ({ useFullActivityDisplay: vi.fn(() => ({ kind: "ready", key: "test-display", data: mocks.fullActivityDisplay })) }));
vi.mock("./SpatialPitch", () => ({
  SpatialPitch: (props: { forcedMode?: string; embedded?: boolean; layers: Record<string, boolean>; contextIdentity?: string; fullActivityHeatmap?: unknown }) => <div
    data-testid="spatial-pitch"
    data-forced-mode={props.forcedMode}
    data-embedded={String(Boolean(props.embedded))}
    data-layers={JSON.stringify(props.layers)}
    data-context-identity={props.contextIdentity}
    data-full-heatmap={String(props.fullActivityHeatmap === (mocks.fullActivityDisplay as { fullHeat?: unknown } | undefined)?.fullHeat)}
  />,
}));

import { samplePlayers } from "../test/fixtures/players";
import { Player3DRoute } from "./Player3DRoute";

const config = { baseUrl: "https://api.example.test", season: "2025/2026", scope: 7 as const, limit: 1000 };
const dataset = { season: "2024/2025", mode: "league" as const, scope: 7 as const, competition: "all" as const };

function strictFullActivityDisplayFixture() {
  return fullActivityDisplayEnvelopeSchema.parse({
    schemaVersion: "full-activity-display-v1",
    context: { playerId: 1, season: "2024/2025", mode: "league", scope: 7, competition: null },
    fullHeat: {
      available: true, reason: null, definitionVersion: "full-tier3-count-weighted-histogram-32x22-v1", columns: 32, rows: 22,
      cellCounts: [2, ...new Array(703).fill(0)], validPointCount: 2, activitySnapshotCount: 1,
      sourceDefinitionVersion: "sportsapi-heatmap-points-count-weighted-full-v1",
    },
    fullSourceCca: {
      available: true, reason: null, definitionVersion: "full-source-continuous-core-v1", formulaVersion: "fixed-n60-r20-v2",
      inputDefinition: "sportsapi-data-points-count-expanded-v1", heatmapDefinition: "full-tier3-count-weighted-histogram-32x22-v1",
      sourceRevision: "87b0d583a5d62b92abf2169476353032e5ef1a174faf04c07dc4a6d6eff2fbf0",
      coverage: { expectedKeys: ["1:1:1"], observedKeys: ["1:1:1"], missingKeys: [] }, gridColumns: 32, gridRows: 22,
      validPointCount: 2, standardizedTarget: 14.3, densityThreshold: 3.5, thresholdOfPeak: .48, coreAreaPct: 15.4, ccaAreaPct: 15.4, containedMassPct: 37.1, lowSample: false,
    },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.fullActivityDisplay = strictFullActivityDisplayFixture();
  mocks.fetchPlayerDetail.mockResolvedValue({ player: samplePlayers[0], analysis: { spatial: { shotmapPoints: [] } } });
  window.history.replaceState(null, "", "/player/1/3d?season=2024%2F2025&mode=league&scope=7&utm_source=slack");
});

describe("dedicated player 3D route", () => {
  it("starts with heat only and retains opt-in access to every 3D layer", async () => {
    render(<Player3DRoute id={1} dataset={dataset} config={config}/>);
    await waitFor(() => expect(mocks.fetchPlayerDetail).toHaveBeenCalledWith(config, 1, dataset, expect.any(AbortSignal)));
    const pitch = await screen.findByTestId("spatial-pitch");
    expect(pitch).toHaveAttribute("data-forced-mode", "perspective");
    expect(pitch).toHaveAttribute("data-embedded", "false");
    expect(JSON.parse(pitch.getAttribute("data-layers")!)).toEqual({ heatmap: true, cca: false, trajectories: false, markers: false });
    fireEvent.click(screen.getByRole('button', { name: '통합' }));
    fireEvent.click(screen.getByRole('checkbox', { name: '전체 궤적' }));
    fireEvent.click(screen.getByRole('checkbox', { name: '분석 구획·CCA' }));
    expect(JSON.parse(pitch.getAttribute("data-layers")!)).toEqual({ heatmap: true, cca: true, trajectories: true, markers: true });
    fireEvent.click(screen.getByRole('button', { name: '슈팅 장면' }));
    expect(JSON.parse(pitch.getAttribute("data-layers")!).heatmap).toBe(false);
    expect(pitch).toHaveAttribute("data-context-identity", "1|2024/2025|league|7|all");
    expect(pitch).toHaveAttribute("data-full-heatmap", "true");
    expect(screen.getByRole("link", { name: "← 선수 상세" })).toHaveAttribute("href", "/players/1?season=2024%2F2025&mode=league&scope=7&utm_source=slack");
  });
});
