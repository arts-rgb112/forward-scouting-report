// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const transport = vi.hoisted(() => ({ detail: vi.fn(), duelDetail: vi.fn(), detailReadouts: vi.fn(), comparison: vi.fn(), quadrant: vi.fn(), quality: vi.fn(), options: vi.fn(), fullHeatmap: vi.fn() }));
vi.mock("../api/env", () => ({ parseMessiApiConfig: vi.fn(() => ({ baseUrl: "https://api.example.test", season: "2025/2026", scope: 7, limit: 1000 })) }));
vi.mock("../api/leaderboardsApi", () => ({ fetchPlayerDetail: transport.detail, fetchComparison: transport.comparison, fetchTacticalQuadrant: transport.quadrant, fetchLeaderboardOptions: transport.options }));
vi.mock("../api/dataQualityApi", () => ({ fetchPlayerDataQuality: transport.quality, DataQualityIdentityError: class DataQualityIdentityError extends Error {} }));
vi.mock("../api/fullActivityHeatmapApi", () => ({ fetchFullActivityHeatmap: transport.fullHeatmap, fullActivityHeatmapResourceKey: "full-activity-heatmap-v1" }));
vi.mock("../api/duelPressApi", async (original) => ({ ...await original<typeof import("../api/duelPressApi")>(), fetchDuelPressDetail: transport.duelDetail }));
vi.mock("../api/duelPressDetailReadoutApi", async (original) => ({ ...await original<typeof import("../api/duelPressDetailReadoutApi")>(), fetchDuelPressDetailReadouts: transport.detailReadouts }));

import { StaticRoute } from "./StaticRoute";
import { samplePlayers } from "../test/fixtures/players";
import { detailReadoutFixture } from "../test/fixtures/duelPressDetailReadouts";

const optionsWithScope8 = { seasons: ["2025/2026"], scopes: [{ value: 8 as const, label: "8 leagues", leagueIds: [1] }], competitions: { all: { code: "all" as const, label: "All", available: true, reason: null }, ucl: { code: "ucl" as const, label: "UCL", available: true, reason: null }, uel: { code: "uel" as const, label: "UEL", available: true, reason: null }, uecl: { code: "uecl" as const, label: "UECL", available: true, reason: null } } };
const optionsWithoutScope8 = { ...optionsWithScope8, scopes: [{ value: 7 as const, label: "7 leagues", leagueIds: [1] }] };

beforeEach(() => {
  vi.clearAllMocks();
  transport.detail.mockResolvedValue({ player: samplePlayers[0] });
  transport.detailReadouts.mockResolvedValue(detailReadoutFixture);
  transport.fullHeatmap.mockResolvedValue({ data: { available: false, validPointCount: 0, cellCounts: [], source: "messi-static-cohort" } });
  transport.comparison.mockResolvedValue({ players: [], meta: {} });
  transport.quadrant.mockResolvedValue({}); transport.quality.mockRejectedValue(new Error("quality unavailable"));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); cleanup(); });

describe("scope-8 direct-route capability gate", () => {
  it("loads the dedicated 3D route directly with the shared URL context intact", async () => {
    window.history.replaceState(null, "", "/player/1/3d?season=2024%2F2025&mode=league&scope=7&utm_source=slack");
    render(<StaticRoute />);
    expect(await screen.findByRole("heading", { name: "Erling Haaland · 3D 회랑" })).toBeInTheDocument();
    expect(document.querySelector('[data-layout="player-3d-route"]')).not.toBeNull();
    expect(transport.detail).toHaveBeenCalledWith(expect.anything(), 1, expect.objectContaining({ season: "2024/2025", mode: "league", scope: 7, competition: "all" }), expect.any(AbortSignal));
    expect(screen.getByRole("link", { name: "← 선수 상세" })).toHaveAttribute("href", "/players/1?season=2024%2F2025&mode=league&scope=7&utm_source=slack");
    expect(window.location.search).toContain("season=2024%2F2025");
    expect(window.location.search).toContain("scope=7");
  });

  it("allows a direct player route only after authoritative options include scope 8", async () => {
    transport.options.mockResolvedValue(optionsWithScope8);
    window.history.replaceState(null, "", "/players/1?season=2025%2F2026&scope=8");
    render(<StaticRoute />);
    await waitFor(() => expect(transport.detail).toHaveBeenCalledTimes(1));
    expect(transport.detail.mock.calls[0][2]).toMatchObject({ season: "2025/2026", mode: "league", scope: 8, competition: "all" });
    expect(transport.quadrant).toHaveBeenCalledTimes(1);
    expect(transport.quality).toHaveBeenCalledTimes(1);
    expect(window.location.search).toContain("scope=8");
  });

  it("shows the explicit unavailable state and makes no player-specific calls when scope 8 is omitted", async () => {
    transport.options.mockResolvedValue(optionsWithoutScope8);
    window.history.replaceState(null, "", "/players/1?scope=8");
    render(<StaticRoute />);
    expect(await screen.findByRole("alert")).toHaveTextContent("8개 리그 데이터");
    expect(transport.detail).not.toHaveBeenCalled();
    expect(transport.quadrant).not.toHaveBeenCalled();
    expect(transport.quality).not.toHaveBeenCalled();
    expect(window.location.search).toContain("scope=8");
  });

  it("fails closed for legacy compare queries without invoking the legacy GET transport", async () => {
    transport.options.mockRejectedValue(new Error("options unavailable"));
    window.history.replaceState(null, "", "/compare?players=1,2&scope=8");
    render(<StaticRoute />);
    expect(screen.getByLabelText("Left player FotMob player ID")).toHaveValue("");
    expect(screen.getByText(/does not include each player’s full context/)).toBeInTheDocument();
    expect(transport.comparison).not.toHaveBeenCalled();
    return;
    window.history.replaceState(null, "", "/compare?players=1,2&scope=8");
    render(<StaticRoute />);
    expect(await screen.findByRole("alert")).toHaveTextContent("8개 리그 데이터");
    expect(transport.comparison).not.toHaveBeenCalled();
    expect(transport.detail).not.toHaveBeenCalled();
    expect(window.location.search).toContain("scope=8");
  });

  it("treats a timed-out scope-8 options probe as unavailable before any detail request", async () => {
    vi.useFakeTimers();
    transport.options.mockImplementation(() => new Promise(() => undefined));
    window.history.replaceState(null, "", "/players/1?scope=8");
    render(<StaticRoute />);
    await act(async () => { await vi.advanceTimersByTimeAsync(8_000); });
    expect(screen.getByRole("alert")).toHaveTextContent("8개 리그 데이터");
    expect(transport.detail).not.toHaveBeenCalled();
    expect(transport.quadrant).not.toHaveBeenCalled();
    expect(transport.quality).not.toHaveBeenCalled();
  });

  it("renders canonical contextual compare queries without invoking the legacy GET transport", async () => {
    transport.options.mockResolvedValue(optionsWithScope8);
    window.history.replaceState(null, "", "/compare?leftPlayerId=1&leftTaxonomy=legacy-v1&leftSeason=2025%2F2026&leftMode=league&leftScope=8&leftCompetition=all&rightPlayerId=2&rightTaxonomy=legacy-v1&rightSeason=2025%2F2026&rightMode=league&rightScope=8&rightCompetition=all");
    render(<StaticRoute />);
    expect(screen.getByLabelText("Left player FotMob player ID")).toHaveValue("1");
    expect(screen.getByLabelText("Right player FotMob player ID")).toHaveValue("2");
    expect(transport.comparison).not.toHaveBeenCalled();
    return;
    window.history.replaceState(null, "", "/compare?players=1,2&scope=8");
    render(<StaticRoute />);
    await waitFor(() => expect(transport.comparison).toHaveBeenCalledTimes(1));
    expect(transport.comparison.mock.calls[0][2]).toMatchObject({ mode: "league", scope: 8, competition: "all" });
    expect(window.location.search).toContain("scope=8");
  });

  it("does not require an options probe for an explicit supported legacy scope", async () => {
    window.history.replaceState(null, "", "/players/1?scope=7");
    render(<StaticRoute />);
    await waitFor(() => expect(transport.detail).toHaveBeenCalledTimes(1));
    expect(transport.options).not.toHaveBeenCalled();
  });

  it("cannot bypass an explicit false rollout flag with a companion taxonomy URL", async () => {
    vi.stubEnv("VITE_DUEL_PRESS_LEADERBOARD_ENABLED", "false");
    window.history.replaceState(null, "", "/players/1?scope=7&taxonomy=duel-press-v1");
    render(<StaticRoute />);
    await waitFor(() => expect(transport.detail).toHaveBeenCalledTimes(1));
    expect(transport.duelDetail).not.toHaveBeenCalled();
    expect(screen.getByRole("region", { name: "Volume benchmark radar" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Duel and pressing companion" })).not.toBeInTheDocument();
  });

  it("keeps companion direct URLs disabled when the flag is unset in tests", async () => {
    window.history.replaceState(null, "", "/players/1?scope=7&taxonomy=duel-press-v1");
    render(<StaticRoute />);
    await waitFor(() => expect(transport.detail).toHaveBeenCalledTimes(1));
    expect(transport.duelDetail).not.toHaveBeenCalled();
  });

  it("atomically replaces the native legacy board with the enabled detail-readout board for the exact context", async () => {
    vi.stubEnv("VITE_DUEL_PRESS_LEADERBOARD_ENABLED", "true");
    window.history.replaceState(null, "", "/players/1?season=2024%2F2025&mode=league&scope=5&competition=all&taxonomy=duel-press-v1");
    render(<StaticRoute />);
    expect(await screen.findByRole("heading", { name: samplePlayers[0].name })).toBeInTheDocument();
    expect(await screen.findByRole("region", { name: "Duel press detailed stats board" })).toHaveTextContent("상세 스탯 보드");
    expect(screen.queryByRole("region", { name: "Duel and pressing companion" })).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Duel press detailed stats board" }).closest('[data-layout="detail-board-slot"]')).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Volume benchmark radar" })).toBeInTheDocument();
    expect(transport.detailReadouts).toHaveBeenCalledWith(expect.anything(), 1, { season: "2024/2025", mode: "league", scope: 5, competition: "all" }, expect.any(AbortSignal));
  });

  it("keeps dossier and tactical/spatial content visible when the detail board fails", async () => {
    vi.stubEnv("VITE_DUEL_PRESS_LEADERBOARD_ENABLED", "true");
    transport.detailReadouts.mockRejectedValueOnce(new Error("detail board unavailable"));
    window.history.replaceState(null, "", "/players/1?scope=7&taxonomy=duel-press-v1");
    render(<StaticRoute />);
    expect(await screen.findByRole("heading", { name: samplePlayers[0].name })).toBeInTheDocument();
    expect(await screen.findByRole("alert")).toHaveTextContent("detail board unavailable");
    expect(screen.getByRole("region", { name: "Tactical and spatial analysis" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Duel press detailed stats board" }).closest('[data-layout="detail-board-slot"]')).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Volume benchmark radar" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Aerial duels")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Ground duels")).not.toBeInTheDocument();
  });

  it("does not expose legacy AER/GND dossier chips while the renewed board is loading", async () => {
    vi.stubEnv("VITE_DUEL_PRESS_LEADERBOARD_ENABLED", "true");
    transport.detailReadouts.mockImplementationOnce(() => new Promise(() => undefined));
    window.history.replaceState(null, "", "/players/1?scope=7&taxonomy=duel-press-v1");
    render(<StaticRoute />);
    expect(await screen.findByRole("heading", { name: samplePlayers[0].name })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Duel press detailed stats board" })).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("region", { name: "Duel press detailed stats board" }).closest('[data-layout="detail-board-slot"]')).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Volume benchmark radar" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Aerial duels")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Ground duels")).not.toBeInTheDocument();
  });

  it("drops a late detail-readout board response after the selected context changes", async () => {
    vi.stubEnv("VITE_DUEL_PRESS_LEADERBOARD_ENABLED", "true");
    const stale = structuredClone(detailReadoutFixture); stale.categories[0].comparison = { ...stale.categories[0].comparison, percentile: 99.99 };
    const current = structuredClone(detailReadoutFixture); current.categories[0].comparison = { ...current.categories[0].comparison, percentile: 12.34 }; current.context.season = "2024/2025";
    let resolveStale!: (value: typeof detailReadoutFixture) => void;
    transport.detailReadouts.mockImplementationOnce(() => new Promise<typeof detailReadoutFixture>((resolve) => { resolveStale = resolve; })).mockResolvedValueOnce(current);
    window.history.replaceState(null, "", "/players/1?season=2025%2F2026&scope=7&taxonomy=duel-press-v1");
    const view = render(<StaticRoute />);
    await waitFor(() => expect(transport.detailReadouts).toHaveBeenCalledTimes(1));
    window.history.replaceState(null, "", "/players/1?season=2024%2F2025&scope=5&taxonomy=duel-press-v1");
    view.rerender(<StaticRoute />);
    await waitFor(() => expect(transport.detailReadouts).toHaveBeenCalledTimes(2));
    expect((await screen.findByRole("progressbar", { name: "박스 밖 슈팅 비교 백분위" })).getAttribute("aria-valuenow")).toBe("12");
    await act(async () => { resolveStale(stale); await Promise.resolve(); });
    expect(screen.getByRole("progressbar", { name: "박스 밖 슈팅 비교 백분위" })).toHaveAttribute("aria-valuenow", "12");
  });
});
