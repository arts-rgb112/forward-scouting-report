// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PlayersPayload } from "./types";
import { sampleMeta, samplePlayers } from "../test/fixtures/players";

const transport = vi.hoisted(() => ({ fetchPlayers: vi.fn(), fetchLeaderboard: vi.fn(), fetchLeaderboardOptions: vi.fn() }));
const apiEnvironment = vi.hoisted(() => {
  class TestConfigError extends Error {
    constructor(public category: string, message = "test configuration error") { super(message); }
  }
  return { parseMessiApiConfig: vi.fn(), MessiConfigError: TestConfigError };
});
vi.mock("../api/env", () => apiEnvironment);
vi.mock("../api/playersApi", () => ({ fetchPlayers: transport.fetchPlayers }));
vi.mock("../api/leaderboardsApi", () => ({ fetchLeaderboard: transport.fetchLeaderboard, fetchLeaderboardOptions: transport.fetchLeaderboardOptions }));

import { PlayersResourceContainer, positionWasApplied } from "./PlayersResourceContainer";

type Deferred = { promise: Promise<PlayersPayload>; resolve(value: PlayersPayload): void };
function deferred(): Deferred {
  let resolve!: (value: PlayersPayload) => void;
  const promise = new Promise<PlayersPayload>((next) => { resolve = next; });
  return { promise, resolve };
}

const validConfig = { baseUrl: "http://localhost:8000", season: "2025/2026", scope: 7, limit: 1000 };

beforeEach(() => { apiEnvironment.parseMessiApiConfig.mockReturnValue(validConfig); transport.fetchLeaderboardOptions.mockRejectedValue(new Error("v2 unavailable")); window.history.replaceState(null, "", "/"); });
afterEach(() => { vi.useRealTimers(); cleanup(); transport.fetchPlayers.mockReset(); transport.fetchLeaderboard.mockReset(); transport.fetchLeaderboardOptions.mockReset(); apiEnvironment.parseMessiApiConfig.mockReset(); });

describe("PlayersResourceContainer request lifecycle", () => {
  it("requires an exact applied.position echo before trusting a detailed filter", () => {
    expect(positionWasApplied({ ...sampleMeta, applied: { position: "Center Back" } }, "Center Back")).toBe(true);
    expect(positionWasApplied({ ...sampleMeta, applied: { position: "Striker" } }, "Center Back")).toBe(false);
    expect(positionWasApplied(sampleMeta, "Center Back")).toBe(false);
  });

  it("uses only the v2 leaderboard request and aborts it on unmount", async () => {
    const calls: Array<{ signal: AbortSignal; request: Deferred }> = [];
    transport.fetchLeaderboard.mockImplementation((_config, _dataset, _search, signal: AbortSignal) => {
      const request = deferred(); calls.push({ signal, request }); return request.promise;
    });
    const { unmount } = render(<StrictMode><PlayersResourceContainer /></StrictMode>);
    await waitFor(() => expect(calls.length).toBeGreaterThanOrEqual(1));
    const active = calls[calls.length - 1];
    await act(async () => { active.request.resolve({ players: [{ ...samplePlayers[0], name: "Current player" }], meta: { ...sampleMeta, population: 1, returned: 1 } }); });
    expect(screen.getAllByText("Current player")).toHaveLength(2);
    expect(transport.fetchPlayers).not.toHaveBeenCalled();
    unmount();
    expect(active.signal.aborted).toBe(true);
  });
});

describe("PlayersResourceContainer URL-backed pages", () => {
  it("keeps the requested page while its retained previous page is refreshing", async () => {
    const calls: Array<{ signal: AbortSignal; request: Deferred }> = [];
    transport.fetchLeaderboard.mockImplementation((_config, _dataset, _search, signal: AbortSignal) => {
      const request = deferred(); calls.push({ signal, request }); return request.promise;
    });
    render(<PlayersResourceContainer />);
    await waitFor(() => expect(calls).toHaveLength(1));
    await act(async () => {
      calls[0].request.resolve({ players: [{ ...samplePlayers[0], name: "Page 1 player" }], meta: { ...sampleMeta, population: 250, totalItems: 250, returned: 1 }, serverPage: { page: 1, pageSize: 50, totalPages: 5, hasNextPage: true } });
    });
    fireEvent.click(screen.getByRole("button", { name: "Page 5" }));
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(window.location.search).toContain("page=5");
    expect(calls[1].signal.aborted).toBe(false);
    expect(screen.getAllByText("Page 1 player")).not.toHaveLength(0);
    await act(async () => {
      calls[1].request.resolve({ players: [{ ...samplePlayers[0], name: "Page 5 player" }], meta: { ...sampleMeta, population: 250, totalItems: 250, returned: 1 }, serverPage: { page: 5, pageSize: 50, totalPages: 5, hasNextPage: false } });
    });
    expect(await screen.findAllByText("Page 5 player")).not.toHaveLength(0);
    expect(screen.getByText("201–201 of 250 players")).toBeInTheDocument();
    expect(window.location.search).toContain("page=5");
  });

  it("preserves a direct page=2 URL through an initial failure and retry", async () => {
    const players = Array.from({ length: 51 }, (_, index) => ({ ...samplePlayers[index % samplePlayers.length], id: index + 1, rank: index + 1, name: `Player ${index + 1}` }));
    const payload = { players: [players[50]], meta: { ...sampleMeta, population: 51, returned: 1, schemaVersion: "2.1.0" as const, mode: "europe" as const, scope: null, competition: "ucl" as const }, serverPage: { page: 2, pageSize: 50, totalPages: 2, hasNextPage: false } };
    transport.fetchLeaderboardOptions.mockResolvedValue({ seasons: ["2025/2026"], scopes: [], competitions: { all: { code: "all", label: "All", available: true, reason: null }, ucl: { code: "ucl", label: "UCL", available: true, reason: null }, uel: { code: "uel", label: "UEL", available: true, reason: null }, uecl: { code: "uecl", label: "UECL", available: true, reason: null } } });
    transport.fetchLeaderboard.mockRejectedValueOnce(new Error("temporary failure")).mockResolvedValue(payload);
    window.history.replaceState(null, "", "/?season=2025%2F2026&mode=europe&competition=ucl&page=2");
    render(<PlayersResourceContainer />);
    await screen.findByRole("alert");
    expect(window.location.search).toContain("page=2");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findAllByText("Player 51");
    expect(window.location.search).toContain("page=2");
  });

  it("loads the v2 leaderboard when the options probe fails, without a v1 fallback", async () => {
    transport.fetchLeaderboardOptions.mockRejectedValue(new Error("options unavailable"));
    transport.fetchLeaderboard.mockResolvedValue({ players: samplePlayers, meta: sampleMeta });
    render(<PlayersResourceContainer />);
    await waitFor(() => expect(transport.fetchLeaderboard).toHaveBeenCalledTimes(1));
    expect(transport.fetchPlayers).not.toHaveBeenCalled();
  });

  it("keeps an Europe page URL and uses v2 when the options probe fails", async () => {
    transport.fetchLeaderboardOptions.mockRejectedValue(new Error("options unavailable"));
    transport.fetchLeaderboard.mockResolvedValue({ players: [{ ...samplePlayers[0], name: "European v2 payload" }], meta: { ...sampleMeta, population: 51, returned: 1, schemaVersion: "2.1.0", mode: "europe", scope: null, competition: "ucl" }, serverPage: { page: 2, pageSize: 50, totalPages: 2, hasNextPage: false } });
    window.history.replaceState(null, "", "/?season=2025%2F2026&mode=europe&competition=ucl&page=2");
    render(<PlayersResourceContainer />);
    await screen.findAllByText("European v2 payload");
    expect(window.location.search).toContain("page=2");
    expect(transport.fetchPlayers).not.toHaveBeenCalled();
    expect(transport.fetchLeaderboard).toHaveBeenCalled();
  });

  it("re-probes Europe options on retry before loading v2 data and preserves page=2", async () => {
    const players = Array.from({ length: 51 }, (_, index) => ({ ...samplePlayers[index % samplePlayers.length], id: index + 1, rank: index + 1, name: `Europe Player ${index + 1}` }));
    const payload = { players: [players[50]], meta: { ...sampleMeta, population: 51, returned: 1, schemaVersion: "2.1.0" as const, mode: "europe" as const, scope: null, competition: "ucl" as const }, serverPage: { page: 2, pageSize: 50, totalPages: 2, hasNextPage: false } };
    const options = { seasons: ["2025/2026"], scopes: [], competitions: { all: { code: "all", label: "All", available: true, reason: null }, ucl: { code: "ucl", label: "UCL", available: true, reason: null }, uel: { code: "uel", label: "UEL", available: true, reason: null }, uecl: { code: "uecl", label: "UECL", available: true, reason: null } } };
    transport.fetchLeaderboardOptions.mockRejectedValueOnce(new Error("initial options failure")).mockResolvedValueOnce(options);
    transport.fetchLeaderboard.mockRejectedValueOnce(new Error("temporary failure")).mockResolvedValue(payload);
    window.history.replaceState(null, "", "/?season=2025%2F2026&mode=europe&competition=ucl&page=2");
    render(<PlayersResourceContainer />);
    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findAllByText("Europe Player 51");
    expect(transport.fetchLeaderboardOptions).toHaveBeenCalledTimes(2);
    expect(transport.fetchLeaderboard.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(window.location.search).toContain("page=2");
  });

  it("does not let a StrictMode-aborted options request create a v1 fallback", async () => {
    const rejects: Array<(reason?: unknown) => void> = [];
    transport.fetchLeaderboardOptions.mockImplementation(() => new Promise((_resolve, reject) => { rejects.push(reject); }));
    transport.fetchLeaderboard.mockResolvedValue({ players: samplePlayers, meta: sampleMeta });
    render(<StrictMode><PlayersResourceContainer /></StrictMode>);
    await waitFor(() => expect(rejects.length).toBeGreaterThanOrEqual(2));
    await act(async () => { rejects[0](new Error("stale options request")); await Promise.resolve(); });
    expect(transport.fetchPlayers).not.toHaveBeenCalled();
    await act(async () => { rejects[rejects.length - 1](new Error("active options request")); await Promise.resolve(); });
    await waitFor(() => expect(transport.fetchLeaderboard).toHaveBeenCalledTimes(1));
    expect(transport.fetchPlayers).not.toHaveBeenCalled();
  });
});

describe("PlayersResourceContainer configuration safety", () => {
  it.each([
    ["MISSING_API_BASE_URL", "필수 API 주소가 설정되지 않았습니다."],
    ["INVALID_API_ORIGIN", "API 주소 형식이 허용되지 않습니다."],
    ["INSECURE_API_ORIGIN", "이 환경에서는 보안 HTTPS API 주소가 필요합니다."],
    ["INVALID_DATASET_SETTINGS", "데이터셋 설정 값이 허용 범위를 벗어났습니다."],
  ])("renders %s as a terminal no-request state", async (category, reason) => {
    apiEnvironment.parseMessiApiConfig.mockImplementation(() => { throw new apiEnvironment.MessiConfigError(category); });
    render(<PlayersResourceContainer />);
    expect(await screen.findByRole("heading", { name: "Config Error (환경 변수 누락)" })).toHaveFocus();
    expect(screen.getByText(reason)).toBeInTheDocument();
    expect(screen.queryByText("No players in this dataset")).not.toBeInTheDocument();
    expect(transport.fetchPlayers).not.toHaveBeenCalled();
  });

  it("never renders a malformed credential-bearing value or sends it to the transport", async () => {
    const rejectedValue = "https://operator:do-not-expose@api.invalid/?private=1";
    apiEnvironment.parseMessiApiConfig.mockImplementation(() => { throw new apiEnvironment.MessiConfigError("INVALID_API_ORIGIN", rejectedValue); });
    render(<PlayersResourceContainer />);
    await screen.findByRole("heading", { name: "Config Error (환경 변수 누락)" });
    expect(document.body.textContent).not.toContain(rejectedValue);
    expect(document.body.textContent).not.toContain("do-not-expose");
    expect(transport.fetchPlayers).not.toHaveBeenCalled();
  });
});
