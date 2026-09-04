// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetchPlayerDetail: vi.fn(),
  fullHeatmap: { available: true, validPointCount: 2, cellCounts: [1, 1], source: "messi-static-cohort" },
}));

vi.mock("../api/leaderboardsApi", () => ({ fetchPlayerDetail: mocks.fetchPlayerDetail }));
vi.mock("./useFullActivityHeatmap", () => ({ useFullActivityHeatmap: vi.fn(() => ({ kind: "ready", data: mocks.fullHeatmap })) }));
vi.mock("./SpatialPitch", () => ({
  SpatialPitch: (props: { forcedMode?: string; embedded?: boolean; layers: Record<string, boolean>; contextIdentity?: string; fullActivityHeatmap?: unknown }) => <div
    data-testid="spatial-pitch"
    data-forced-mode={props.forcedMode}
    data-embedded={String(Boolean(props.embedded))}
    data-layers={JSON.stringify(props.layers)}
    data-context-identity={props.contextIdentity}
    data-full-heatmap={String(props.fullActivityHeatmap === mocks.fullHeatmap)}
  />,
}));

import { samplePlayers } from "../test/fixtures/players";
import { Player3DRoute } from "./Player3DRoute";

const config = { baseUrl: "https://api.example.test", season: "2025/2026", scope: 7 as const, limit: 1000 };
const dataset = { season: "2024/2025", mode: "league" as const, scope: 7 as const, competition: "all" as const };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.fetchPlayerDetail.mockResolvedValue({ player: samplePlayers[0], analysis: { spatial: { shotmapPoints: [] } } });
  window.history.replaceState(null, "", "/player/1/3d?season=2024%2F2025&mode=league&scope=7&utm_source=slack");
});

describe("dedicated player 3D route", () => {
  it("keeps every 3D layer active in non-embedded perspective mode", async () => {
    render(<Player3DRoute id={1} dataset={dataset} config={config}/>);
    await waitFor(() => expect(mocks.fetchPlayerDetail).toHaveBeenCalledWith(config, 1, dataset, expect.any(AbortSignal)));
    const pitch = await screen.findByTestId("spatial-pitch");
    expect(pitch).toHaveAttribute("data-forced-mode", "perspective");
    expect(pitch).toHaveAttribute("data-embedded", "false");
    expect(JSON.parse(pitch.getAttribute("data-layers")!)).toEqual({ heatmap: true, cca: true, trajectories: true, markers: true });
    expect(pitch).toHaveAttribute("data-context-identity", "1|2024/2025|league|7|all");
    expect(pitch).toHaveAttribute("data-full-heatmap", "true");
    expect(screen.getByRole("link", { name: "← 선수 상세" })).toHaveAttribute("href", "/players/1?season=2024%2F2025&mode=league&scope=7&utm_source=slack");
  });
});
