// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const resource = vi.hoisted(() => ({ hook: vi.fn() }));
vi.mock("../api/env", () => ({ parseMessiApiConfig: vi.fn(() => ({ baseUrl: "https://api.example.test", season: "2025/2026", scope: 8, limit: 1000 })) }));
vi.mock("../api/useContextualCompare", () => ({ useContextualCompare: resource.hook }));
import { StaticRoute } from "./StaticRoute";

const summary = { id: 1, rank: 1, name: "Fixture", position: "Forward", archetype: "Type A", age: 25, minutes: 900, tier: { code: "gold", level: 1, label: "Gold" }, score: 50, face: null, nation: null, league: { id: 1, name: "League", icon: null }, club: { id: 2, name: "Club", icon: null }, stats: { outsideShot: 0, boxThreat: 0, dangerZone: 0, aerial: 0, groundDuel: 0, spaceControl: 0 } };
describe("contextual native compare", () => {
  beforeEach(() => { resource.hook.mockImplementation(() => ({ state: "success", value: { left: { status: "resolved", summary, context: { season: "2024/2025", mode: "league" }, componentAvailability: { detail: "available", dataQuality: "available", tacticalQuadrant: "unavailable" }, detail: { server: true }, dataQuality: { observedWeightPct: 100 }, tacticalQuadrant: null, duelPressDetailReadout: null }, right: { status: "unavailable" } }, retry: vi.fn() })); window.history.replaceState(null, "", "/compare"); });
  it("builds keyboard-accessible independent League and Europe contexts and never substitutes unavailable panels", async () => {
    render(<StaticRoute />);
    fireEvent.change(screen.getByLabelText("Left player FotMob player ID"), { target: { value: "101" } });
    fireEvent.change(screen.getByLabelText("Right player FotMob player ID"), { target: { value: "202" } });
    fireEvent.change(screen.getByLabelText("Left player season"), { target: { value: "2024/2025" } });
    fireEvent.change(screen.getByLabelText("Right player mode"), { target: { value: "europe" } });
    fireEvent.change(screen.getByLabelText("Right player Europe competition"), { target: { value: "ucl" } });
    await waitFor(() => expect(screen.getByRole("link", { name: "Copy exact comparison URL" })).toHaveAttribute("href", expect.stringContaining("leftSeason=2024%2F2025")));
    expect(screen.getByRole("link", { name: "Copy exact comparison URL" })).toHaveAttribute("href", expect.stringContaining("rightMode=europe"));
    expect(screen.getByText("Exact context unavailable")).toBeInTheDocument();
    expect(screen.getByText(/Nothing is derived from a domestic context/)).toBeInTheDocument();
  });
});
