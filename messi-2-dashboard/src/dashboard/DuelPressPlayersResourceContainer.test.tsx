// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import validLeaderboard from "../../../docs/fixtures/duel_press_v1/valid_leaderboard.json";
import { duelPressLeaderboardCoreSchema } from "../api/duelPressContracts";
import { adaptDuelPressPlayerCore } from "../api/duelPressAdapter";
const transport = vi.hoisted(() => ({ duel: vi.fn(), legacy: vi.fn(), options: vi.fn() }));
vi.mock("../api/duelPressApi", async (original) => ({ ...await original<typeof import("../api/duelPressApi")>(), fetchDuelPressLeaderboard: transport.duel }));
vi.mock("../api/leaderboardsApi", () => ({ fetchLeaderboard: transport.legacy, fetchLeaderboardOptions: transport.options }));
import { PlayersResourceContainer } from "./PlayersResourceContainer";
const dto = duelPressLeaderboardCoreSchema.parse(validLeaderboard);
const payload = { players: dto.data.map(adaptDuelPressPlayerCore), meta: dto.meta, serverPage: { page: dto.meta.page, pageSize: 50 as const, totalPages: dto.meta.totalPages, hasNextPage: dto.meta.hasNextPage } };
const optionsWithScope8 = { seasons: ["2025/2026"], scopes: [{ value: 8 as const, label: "8 leagues", leagueIds: [1] }], competitions: { all: { code: "all" as const, label: "All", available: true, reason: null }, ucl: { code: "ucl" as const, label: "UCL", available: true, reason: null }, uel: { code: "uel" as const, label: "UEL", available: true, reason: null }, uecl: { code: "uecl" as const, label: "UECL", available: true, reason: null } } };
describe("companion main dashboard integration", () => {
  afterEach(() => { cleanup(); vi.unstubAllEnvs(); });
  beforeEach(() => { vi.stubEnv("VITE_DUEL_PRESS_LEADERBOARD_ENABLED", "true"); vi.stubEnv("VITE_MESSI_API_BASE_URL", "https://api.test"); vi.stubEnv("VITE_MESSI_SEASON", "2025/2026"); vi.stubEnv("VITE_MESSI_SCOPE", "8"); vi.stubEnv("VITE_MESSI_LIMIT", "1000"); history.replaceState(null, "", "/?season=2025%2F2026&mode=league&scope=8&page=1&sort=score&direction=desc"); transport.duel.mockReset().mockResolvedValue(payload); transport.options.mockReset().mockResolvedValue(optionsWithScope8); transport.legacy.mockReset(); });
  it("selects only companion transport and renders exact six sectors", async () => { render(<PlayersResourceContainer/>); await screen.findByText("Harry Kane"); expect(transport.duel).toHaveBeenCalled(); expect(transport.legacy).not.toHaveBeenCalled(); expect(screen.getAllByLabelText(/통합 경합/).length).toBeGreaterThan(0); expect(screen.getAllByLabelText(/전방 압박 효율/).length).toBeGreaterThan(0); });
  it("keeps server pagination and sends companion search order", async () => { render(<PlayersResourceContainer/>); await screen.findByText("Harry Kane"); expect(screen.getAllByText("Page 1 of 22")).toHaveLength(1); const call = transport.duel.mock.calls[0]; expect(call[2]).toMatchObject({ page: 1, pageSize: 50, sort: "score", direction: "desc" }); await waitFor(() => expect(location.search).toContain("pageSize=50")); });
  it("waits for authoritative scope-8 capability before loading players", async () => {
    let resolveOptions!: (value: typeof optionsWithScope8) => void;
    transport.options.mockReturnValue(new Promise((resolve) => { resolveOptions = resolve; }));
    render(<PlayersResourceContainer/>);
    expect(transport.duel).not.toHaveBeenCalled();
    resolveOptions(optionsWithScope8);
    await screen.findByText("Harry Kane");
    expect(transport.duel).toHaveBeenCalledOnce();
  });
  it("shows an explicit unsupported state without substituting scope 7", async () => {
    transport.options.mockResolvedValue({ ...optionsWithScope8, scopes: [{ value: 7, label: "7 leagues", leagueIds: [1] }] });
    render(<PlayersResourceContainer/>);
    expect(await screen.findByRole("alert")).toHaveTextContent("does not advertise the authoritative 8-league scope");
    expect(transport.duel).not.toHaveBeenCalled();
    expect(location.search).toContain("scope=8");
  });
});
