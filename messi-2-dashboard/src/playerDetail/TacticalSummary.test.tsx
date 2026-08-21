// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import complete from "../../../docs/fixtures/tactical_summary_v1/complete.json";

const hook = vi.hoisted(() => vi.fn());
vi.mock("./useTacticalSummary", async (importOriginal) => ({ ...(await importOriginal<typeof import("./useTacticalSummary")>()), useTacticalSummary: hook }));
import { TacticalSummary } from "./PlayerDetailRoute";
import { samplePlayers } from "../test/fixtures/players";

const player = samplePlayers[0]; const data = { ...complete.data, lines: complete.data.lines.map((line, index) => ({ ...line, text: `server line ${index + 1}` })) };
afterEach(() => { cleanup(); vi.unstubAllEnvs(); vi.clearAllMocks(); });
describe("authoritative tactical summary", () => {
  it("uses exactly the server three lines when the independent flag is enabled", () => {
    vi.stubEnv("VITE_TACTICAL_SUMMARY_ENABLED", "true"); hook.mockReturnValue({ state: { kind: "ready", data }, retry: vi.fn() }); render(<TacticalSummary player={player} quality={{ kind: "idle" }} config={{ baseUrl: "https://api.example.test", season: "2025/2026", scope: 8, limit: 1000 }} dataset={{ season: "2025/2026", mode: "league", scope: 8, competition: "all" }}/>);
    expect(screen.getAllByRole("listitem")).toHaveLength(3); expect(screen.getByText("server line 1")).toBeInTheDocument(); expect(screen.queryByText(/Strongest profile/)).not.toBeInTheDocument();
  });
  it("never falls back to browser-derived copy while enabled and reports loading, error, and unavailable", () => {
    vi.stubEnv("VITE_TACTICAL_SUMMARY_ENABLED", "true"); const retry = vi.fn(); hook.mockReturnValue({ state: { kind: "loading" }, retry }); const view = render(<TacticalSummary player={player} quality={{ kind: "idle" }}/>); expect(screen.getByText(/Loading authoritative/)).toBeInTheDocument(); hook.mockReturnValue({ state: { kind: "error" }, retry }); view.rerender(<TacticalSummary player={player} quality={{ kind: "idle" }}/>); screen.getByRole("button", { name: "Retry" }).click(); expect(retry).toHaveBeenCalledOnce(); hook.mockReturnValue({ state: { kind: "unavailable", data: { ...complete.data, available: false, reason: "summary_source_unavailable", lines: [] } }, retry }); view.rerender(<TacticalSummary player={player} quality={{ kind: "idle" }}/>); expect(screen.getByText(/Authoritative tactical summary is unavailable/)).toBeInTheDocument(); expect(screen.queryAllByRole("listitem")).toHaveLength(0);
  });
});
