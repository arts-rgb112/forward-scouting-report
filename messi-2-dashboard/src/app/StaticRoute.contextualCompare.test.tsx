// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const resource = vi.hoisted(() => ({ hook: vi.fn() }));
vi.mock("../api/env", () => ({ parseMessiApiConfig: vi.fn(() => ({ baseUrl: "https://api.example.test", season: "2025/2026", scope: 8, limit: 1000 })) }));
vi.mock("../api/useContextualCompare", () => ({ useContextualCompare: resource.hook }));
import { StaticRoute } from "./StaticRoute";

const summary = { id: 1, rank: 1, name: "Fixture", position: "Forward", archetype: "Type A", age: 25, minutes: 900, tier: { code: "gold", level: 1, label: "Gold" }, score: 50, face: null, nation: null, league: { id: 1, name: "League", icon: null }, club: { id: 2, name: "Club", icon: null }, stats: { outsideShot: 0, boxThreat: 0, dangerZone: 0, aerial: 0, groundDuel: 0, spaceControl: 0 } };
const comparison = { state: "available", median: 0, rank: 1, percentile: 100, population: 1 };
const readout = (id: string, label = id) => ({ id, label, value: 0, unit: "per90", direction: "higher_is_better", source: "player_season_total", state: "observed", comparison });
const duelReadout = { context: { playerId: 1, idNamespace: "fotmob", season: "2024/2025", mode: "league", scope: 8, competition: null }, player: { id: 1, name: "Fixture", position: "Forward", club: summary.club, league: summary.league }, categories: ["outsideShot", "boxThreat", "dangerZone", "combinedDuel", "spaceControl", "forwardPress"].map((id) => ({ id, label: id, score: 50, scoreState: "observed", comparison, readouts: [readout(id)] })), contextIndicators: [{ ...readout("netProgressionPer90", "Net progression"), direction: "neutral", source: "server_derived", state: "server_derived", formulaId: "net-progression-v1" }, { ...readout("shootingLuckOrGoalkeeperImpact", "Shooting luck / goalkeeper impact"), direction: "neutral", source: "server_derived", state: "server_derived", formulaId: "goals-minus-xgot-v1" }] };
describe("contextual native compare", () => {
  it("explicitly rejects an incomplete canonical entry without inventing a player", () => {
    window.history.replaceState(null, "", "/compare?leftPlayerId=1");
    render(<StaticRoute />);
    expect(screen.getByText(/Defaults are shown; choose both exact contexts/)).toBeInTheDocument();
    expect(screen.getByLabelText("Left player FotMob player ID")).toHaveValue("");
    expect(resource.hook.mock.calls.at(-1)?.[1]).toBeNull();
  });
  it.each([
    "mode=league&scope=8&competition=ucl&taxonomy=duel-press-v1",
    "mode=europe&scope=8&competition=ucl&taxonomy=duel-press-v1",
    "mode=league&scope=8&season=2023%2F2024&taxonomy=duel-press-v1",
    "mode=league&scope=8&scope=7&taxonomy=duel-press-v1",
    "mode=league&scope=08&taxonomy=duel-press-v1",
    "mode=league&scope=8",
    "mode=league&scope=8&taxonomy=duel-press-v2",
  ])("does not silently use a malformed or unsupported entry: %s", (query) => {
    window.history.replaceState(null, "", `/compare?season=2024%2F2025&${query}`);
    render(<StaticRoute />);
    expect(screen.getByText(/Defaults are shown; choose both exact contexts/)).toBeInTheDocument();
    expect(screen.getByLabelText("Left player FotMob player ID")).toHaveValue("");
    expect(resource.hook.mock.calls.at(-1)?.[1]).toBeNull();
  });
  it("prefills profile-entry context without making up either player", () => {
    window.history.replaceState(null, "", "/compare?season=2024%2F2025&mode=league&scope=8&taxonomy=duel-press-v1");
    render(<StaticRoute />);
    for (const side of ["Left", "Right"]) {
      expect(screen.getByLabelText(`${side} player league scope`)).toHaveValue("8");
      expect(screen.getByLabelText(`${side} player season`)).toHaveValue("2024/2025");
      expect(screen.getByLabelText(`${side} player FotMob player ID`)).toHaveValue("");
    }
    expect(resource.hook.mock.calls.at(-1)?.[1]).toBeNull();
  });
  it("preserves a Europe entry without borrowing a domestic scope", () => {
    window.history.replaceState(null, "", "/compare?season=2023%2F2024&mode=europe&competition=ucl&taxonomy=duel-press-v1");
    render(<StaticRoute />);
    expect(screen.getByLabelText("Left player mode")).toHaveValue("europe");
    expect(screen.getByLabelText("Left player Europe competition")).toHaveValue("ucl");
    expect(screen.queryByLabelText("Left player league scope")).not.toBeInTheDocument();
    expect(resource.hook.mock.calls.at(-1)?.[1]).toBeNull();
  });
  afterEach(cleanup);
  beforeEach(() => { resource.hook.mockImplementation(() => { const value = { left: { status: "resolved", taxonomy: "duel-press-v1", summary, context: { season: "2024/2025", mode: "league" }, componentAvailability: { detail: "available", dataQuality: "available", tacticalQuadrant: "unavailable" }, detail: { analysis: { score: { value: 50, population: 20 }, rawMetrics: {} } }, dataQuality: { observedWeightPct: 100, imputedMetrics: [] }, tacticalQuadrant: null, duelPressPlayer: { stats: { outsideShot: 50, boxThreat: 50, dangerZone: 50, combinedDuel: 50, spaceControl: 50, forwardPress: 50 } }, duelPressDetailReadout: duelReadout }, right: { status: "unavailable" } }; return { state: "success", value, panels: { left: { state: "resolved", side: value.left }, right: { state: "unavailable", side: value.right } }, retry: vi.fn() }; }); window.history.replaceState(null, "", "/compare"); });
  it("builds keyboard-accessible independent League and Europe contexts and never substitutes unavailable panels", async () => {
    render(<StaticRoute />);
    fireEvent.change(screen.getByLabelText("Left player FotMob player ID"), { target: { value: "101" } });
    fireEvent.change(screen.getByLabelText("Right player FotMob player ID"), { target: { value: "202" } });
    fireEvent.change(screen.getByLabelText("Left player season"), { target: { value: "2024/2025" } });
    fireEvent.change(screen.getByLabelText("Right player mode"), { target: { value: "europe" } });
    fireEvent.change(screen.getByLabelText("Right player Europe competition"), { target: { value: "ucl" } });
    await waitFor(() => expect(screen.getByRole("link", { name: "Open exact comparison URL" })).toHaveAttribute("href", expect.stringContaining("leftSeason=2024%2F2025")));
    expect(screen.getByRole("link", { name: "Open exact comparison URL" })).toHaveAttribute("href", expect.stringContaining("rightMode=europe"));
    expect(screen.getByText("Exact context unavailable")).toBeInTheDocument();
    expect(screen.getByText(/Nothing is derived from a domestic context/)).toBeInTheDocument();
    expect(screen.getByText(/Combined duel \(ground \+ aerial\)/)).toBeInTheDocument();
    expect(screen.getByText("Net progression")).toBeInTheDocument();
    expect(screen.getByText("Shooting luck / goalkeeper impact")).toBeInTheDocument();
  });
  it.each(["Network failure", "Schema failure"])("shows %s and retry controls in both exact-side panels", (error) => {
    const retry = vi.fn(); resource.hook.mockReturnValue({ state: "error", error, panels: { left: { state: "error", error }, right: { state: "error", error } }, retry });
    render(<StaticRoute />);
    expect(screen.getAllByText(error)).toHaveLength(2);
    const leftRetry = screen.getByRole("button", { name: "Retry left player comparison" }); const rightRetry = screen.getByRole("button", { name: "Retry right player comparison" });
    fireEvent.click(leftRetry); fireEvent.click(rightRetry); expect(retry).toHaveBeenCalledTimes(2);
  });
});
