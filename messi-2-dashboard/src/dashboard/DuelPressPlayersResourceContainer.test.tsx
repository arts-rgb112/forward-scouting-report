// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import validLeaderboard from "../../../docs/fixtures/duel_press_v1/valid_leaderboard.json";
import { adaptDuelPressPlayerCore } from "../api/duelPressAdapter";
import { duelPressLeaderboardCoreSchema } from "../api/duelPressContracts";
import { duelPressMetricConfig } from "./duelPressRegistry";
import { getScoreBand, metricConfig } from "./scoutingConfig";

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

  it("selects only companion transport and restores the dense twelve-column presentation", async () => {
    const { container } = render(<PlayersResourceContainer/>); await screen.findAllByText("Harry Kane");
    expect(transport.duel).toHaveBeenCalled(); expect(transport.legacy).not.toHaveBeenCalled();
    expect(screen.getAllByRole("columnheader")).toHaveLength(12);
    for (const config of Object.values(duelPressMetricConfig)) expect(screen.getByRole("button", { name: new RegExp(`Sort by ${config.label}`) })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: new RegExp(`Sort by ${metricConfig.aerial.label}`) })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: new RegExp(`Sort by ${metricConfig.groundDuel.label}`) })).not.toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Player profile" })).toHaveClass("sticky", "left-0");
    expect(screen.getByRole("columnheader", { name: "Minutes" })).toBeInTheDocument(); expect(screen.getByRole("columnheader", { name: "Age" })).toBeInTheDocument(); expect(screen.getByRole("columnheader", { name: "Watch" })).toBeInTheDocument();
    expect(container.querySelector("tbody tr")).toHaveClass("h-[72px]");
    expect(container.querySelector("section.md\\:hidden")).toBeInTheDocument(); expect(container.querySelector("section.md\\:block")).toBeInTheDocument();
  });

  it("keeps identity assets, taxonomy links, disabled watch slots, legend, footer and pagination", async () => {
    const { container } = render(<PlayersResourceContainer/>); await screen.findAllByText("Harry Kane");
    const links = screen.getAllByRole("link", { name: "Harry Kane" }); expect(links).toHaveLength(2);
    for (const link of links) expect(link).toHaveAttribute("href", import.meta.env.VITE_LEGACY_DETAIL_HANDOFF_ENABLED === "true" ? expect.stringContaining("streamlit.app") : "/players/194165?season=2025%2F2026&mode=league&scope=8&taxonomy=duel-press-v1");
    expect(screen.queryByRole("navigation", { name: "Duel-press player details" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /detail/i })).not.toBeInTheDocument();
    expect(screen.getAllByRole("img", { name: "Harry Kane portrait" })).toHaveLength(2);
    expect(container.querySelectorAll("img")).toHaveLength(6);
    expect(screen.getByRole("cell", { name: "2,382" })).toBeInTheDocument(); expect(screen.getByRole("cell", { name: "33" })).toBeInTheDocument();
    for (const button of screen.getAllByRole("button", { name: /Harry Kane watchlist/ })) { expect(button).toBeDisabled(); expect(button).toHaveTextContent("준비 중"); }
    expect(screen.getByLabelText("Ability score legend")).toBeInTheDocument(); expect(screen.getByText(/schema 1\.1\.0/)).toBeInTheDocument(); expect(screen.getAllByText("Page 1 of 22")).toHaveLength(1);
  });

  it("uses the shared score palette and the companion metric tooltip copy", async () => {
    render(<PlayersResourceContainer/>); await screen.findAllByText("Harry Kane");
    const score = payload.players[0].stats.combinedDuel; const config = duelPressMetricConfig.combinedDuel;
    const trigger = screen.getAllByLabelText(new RegExp(`${config.label} ${score}`))[0];
    expect(trigger).toHaveClass(...getScoreBand(score).className.split(" "));
    fireEvent.focus(trigger);
    expect(await screen.findByRole("tooltip")).toHaveTextContent(config.detail);
  });

  it("keeps server pagination and sends companion search order", async () => { render(<PlayersResourceContainer/>); await screen.findAllByText("Harry Kane"); expect(screen.getAllByText("Page 1 of 22")).toHaveLength(1); const call = transport.duel.mock.calls[0]; expect(call[2]).toMatchObject({ page: 1, pageSize: 50, sort: "score", direction: "desc" }); await waitFor(() => expect(location.search).toContain("pageSize=50")); });
  it("normalizes dashboard state without dropping caller-owned attribution or debugger keys", async () => {
    history.replaceState(null, "", "/?season=2025%2F2026&mode=league&scope=8&page=1&utm_source=twitter&gclid=TEST123&gtm_debug=x&foo=bar");
    render(<PlayersResourceContainer/>); await screen.findAllByText("Harry Kane");
    await waitFor(() => {
      expect(location.search).toContain("utm_source=twitter");
      expect(location.search).toContain("gclid=TEST123");
      expect(location.search).toContain("gtm_debug=x");
      expect(location.search).toContain("foo=bar");
    });
  });
  it("waits for authoritative scope-8 capability before loading players", async () => {
    let resolveOptions!: (value: typeof optionsWithScope8) => void;
    transport.options.mockReturnValue(new Promise((resolve) => { resolveOptions = resolve; }));
    render(<PlayersResourceContainer/>); expect(transport.duel).not.toHaveBeenCalled(); resolveOptions(optionsWithScope8);
    await screen.findAllByText("Harry Kane"); expect(transport.duel).toHaveBeenCalledOnce();
  });
  it("shows an explicit unsupported state without substituting scope 7", async () => {
    transport.options.mockResolvedValue({ ...optionsWithScope8, scopes: [{ value: 7, label: "7 leagues", leagueIds: [1] }] });
    render(<PlayersResourceContainer/>); expect(await screen.findByRole("alert")).toHaveTextContent("does not advertise the authoritative 8-league scope"); expect(transport.duel).not.toHaveBeenCalled(); expect(location.search).toContain("scope=8");
  });
});
