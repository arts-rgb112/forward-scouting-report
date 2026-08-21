// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const transport = vi.hoisted(() => ({ detail: vi.fn(), quality: vi.fn(), quadrant: vi.fn(), options: vi.fn(), summary: vi.fn() }));
vi.mock("../api/dataQualityApi", () => ({ fetchPlayerDataQuality: transport.quality, DataQualityIdentityError: class DataQualityIdentityError extends Error {} }));
vi.mock("../api/leaderboardsApi", () => ({ fetchPlayerDetail: transport.detail, fetchTacticalQuadrant: transport.quadrant, fetchLeaderboardOptions: vi.fn() }));
vi.mock("../api/playerHistoryApi", () => ({ fetchHistoryLeaderboardOptions: transport.options, fetchPlayerSummary: transport.summary }));
vi.mock("./useVolumeBenchmark", () => ({ useVolumeBenchmark: () => ({ state: { kind: "disabled" as const }, retry: vi.fn() }) }));

import { HISTORY_SUMMARY_TIMEOUT_MS, PlayerDetailRoute } from "./PlayerDetailRoute";
import { samplePlayers } from "../test/fixtures/players";

const config = { baseUrl: "https://authoritative.example.test", season: "2025/2026", scope: 7 as const, limit: 1000 };
const firstDataset = { season: "2025/2026", mode: "league" as const, scope: 7 as const, competition: "all" as const };
const historicalSeasons = ["2025/2026", "2024/2025", "2023/2024", "2022/2023", "2021/2022"];
type DeferredSummary = { context: { season: string; mode: "league" | "europe"; scope: 8; competition: "all" }; signal: AbortSignal; resolve(entry: unknown): void };
let pending: DeferredSummary[] = [];
let inFlight = 0;
let maxInFlight = 0;

function resultFor(request: DeferredSummary, score: number) { return { player: { ...samplePlayers[0], score }, context: request.context }; }

beforeEach(() => {
  pending = []; inFlight = 0; maxInFlight = 0; vi.clearAllMocks();
  transport.detail.mockResolvedValue({ player: samplePlayers[0] }); transport.quality.mockRejectedValue(new Error("quality unavailable")); transport.quadrant.mockResolvedValue(undefined);
  transport.options.mockResolvedValue({ seasons: historicalSeasons, scopes: [], competitions: {} });
  transport.summary.mockImplementation((_config: unknown, _id: number, context: DeferredSummary["context"], signal: AbortSignal) => new Promise((resolve) => {
    inFlight += 1; maxInFlight = Math.max(maxInFlight, inFlight);
    let active = true; const finish = () => { if (active) { active = false; inFlight -= 1; } };
    signal.addEventListener("abort", finish, { once: true });
    pending.push({ context, signal, resolve: (entry) => { finish(); signal.removeEventListener("abort", finish); resolve(entry); } });
  }));
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("player detail historical rail transport", () => {
  it("limits deferred requests to four and displays four distinct non-selected seasons", async () => {
    render(<PlayerDetailRoute id={samplePlayers[0].id} dataset={firstDataset} config={config} />);
    await screen.findByRole("heading", { name: samplePlayers[0].name }); await waitFor(() => expect(pending).toHaveLength(4));
    expect(maxInFlight).toBeLessThanOrEqual(4);
    pending.slice(0, 4).forEach((request, index) => request.resolve(resultFor(request, 70 + index)));
    await waitFor(() => expect(pending).toHaveLength(8)); expect(maxInFlight).toBeLessThanOrEqual(4);
    pending.slice(4).forEach((request, index) => request.resolve(resultFor(request, 80 + index)));
    await waitFor(() => expect(screen.getByRole("region", { name: "Season score rail" })).toHaveTextContent("One best server context per season; top 4 of 4 historical seasons."));
    for (const season of historicalSeasons.slice(1)) expect(screen.getByText(season)).toBeInTheDocument();
  });

  it("aborts old history on context change and unmount, ignoring deferred stale responses", async () => {
    vi.useFakeTimers(); const view = render(<PlayerDetailRoute id={samplePlayers[0].id} dataset={firstDataset} config={config} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); }); expect(pending).toHaveLength(4);
    const oldRequests = pending.slice(); const nextDataset = { ...firstDataset, season: "2024/2025" };
    view.rerender(<PlayerDetailRoute id={samplePlayers[0].id} dataset={nextDataset} config={config} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); }); expect(oldRequests.every((request) => request.signal.aborted)).toBe(true);
    const currentRequests = pending.slice(oldRequests.length).filter((request) => !request.signal.aborted); expect(currentRequests).toHaveLength(4); expect(maxInFlight).toBeLessThanOrEqual(4);
    oldRequests.forEach((request) => request.resolve(resultFor(request, 99.9)));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); }); expect(screen.queryByText("99.9")).not.toBeInTheDocument();
    const nextRequests = pending.slice(oldRequests.length); view.unmount();
    expect(nextRequests.every((request) => request.signal.aborted)).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); }); expect(vi.getTimerCount()).toBe(0); nextRequests.forEach((request) => request.resolve(resultFor(request, 99.9)));
  });

  it("times out a non-cooperative summary, commits successful siblings, and proceeds to the next batch", async () => {
    vi.useFakeTimers(); render(<PlayerDetailRoute id={samplePlayers[0].id} dataset={firstDataset} config={config} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(pending).toHaveLength(4); const neverResolving = pending[0];
    pending.slice(1, 4).forEach((request, index) => request.resolve(resultFor(request, 71 + index)));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); }); expect(pending).toHaveLength(4);
    await act(async () => { await vi.advanceTimersByTimeAsync(HISTORY_SUMMARY_TIMEOUT_MS); });
    expect(neverResolving.signal.aborted).toBe(true); expect(pending).toHaveLength(8); expect(maxInFlight).toBeLessThanOrEqual(4);
    const rail = screen.getByRole("region", { name: "Season score rail" });
    expect(rail).toHaveTextContent("71.0"); expect(rail).toHaveTextContent("Partial history: 1 context unavailable"); expect(rail.querySelector(".animate-pulse")).toBeNull();
    pending.slice(4).forEach((request, index) => request.resolve(resultFor(request, 81 + index)));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(rail.querySelector(".animate-pulse")).toBeNull(); expect(rail).toHaveTextContent("top 4 of 4 historical seasons"); expect(maxInFlight).toBeLessThanOrEqual(4); expect(vi.getTimerCount()).toBe(0);
  });
});
