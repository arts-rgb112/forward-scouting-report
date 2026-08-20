// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const transport = vi.hoisted(() => ({ detail: vi.fn(), duelDetail: vi.fn(), comparison: vi.fn(), quadrant: vi.fn(), quality: vi.fn(), options: vi.fn() }));
vi.mock("../api/env", () => ({ parseMessiApiConfig: vi.fn(() => ({ baseUrl: "https://api.example.test", season: "2025/2026", scope: 7, limit: 1000 })) }));
vi.mock("../api/leaderboardsApi", () => ({ fetchPlayerDetail: transport.detail, fetchComparison: transport.comparison, fetchTacticalQuadrant: transport.quadrant, fetchLeaderboardOptions: transport.options }));
vi.mock("../api/dataQualityApi", () => ({ fetchPlayerDataQuality: transport.quality, DataQualityIdentityError: class DataQualityIdentityError extends Error {} }));
vi.mock("../api/duelPressApi", async (original) => ({ ...await original<typeof import("../api/duelPressApi")>(), fetchDuelPressDetail: transport.duelDetail }));

import { StaticRoute } from "./StaticRoute";
import { samplePlayers } from "../test/fixtures/players";

const optionsWithScope8 = { seasons: ["2025/2026"], scopes: [{ value: 8 as const, label: "8 leagues", leagueIds: [1] }], competitions: { all: { code: "all" as const, label: "All", available: true, reason: null }, ucl: { code: "ucl" as const, label: "UCL", available: true, reason: null }, uel: { code: "uel" as const, label: "UEL", available: true, reason: null }, uecl: { code: "uecl" as const, label: "UECL", available: true, reason: null } } };
const optionsWithoutScope8 = { ...optionsWithScope8, scopes: [{ value: 7 as const, label: "7 leagues", leagueIds: [1] }] };

beforeEach(() => {
  vi.clearAllMocks();
  transport.detail.mockResolvedValue({ player: samplePlayers[0] });
  transport.comparison.mockResolvedValue({ players: [], meta: {} });
  transport.quadrant.mockResolvedValue({}); transport.quality.mockRejectedValue(new Error("quality unavailable"));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); cleanup(); });

describe("scope-8 direct-route capability gate", () => {
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

  it("shows the explicit unavailable state and makes no comparison call when scope-8 options fail", async () => {
    transport.options.mockRejectedValue(new Error("options unavailable"));
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

  it("allows a direct comparison route after scope 8 is confirmed", async () => {
    transport.options.mockResolvedValue(optionsWithScope8);
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
  });

  it("keeps companion direct URLs disabled when the flag is unset in tests", async () => {
    window.history.replaceState(null, "", "/players/1?scope=7&taxonomy=duel-press-v1");
    render(<StaticRoute />);
    await waitFor(() => expect(transport.detail).toHaveBeenCalledTimes(1));
    expect(transport.duelDetail).not.toHaveBeenCalled();
  });
});
