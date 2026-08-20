// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useRef, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import validLeaderboard from "../../../../docs/fixtures/duel_press_v1/valid_leaderboard.json";
import { duelPressPlayerSchema } from "../../api/duelPressContracts";
import { DUEL_PRESS_METRIC_KEYS } from "../../api/duelPressTypes";
import { samplePlayers } from "../../test/fixtures/players";
import { duelPressMetricConfig } from "../duelPressRegistry";
import { duelPressDetailHref } from "../duelPressRoute";
import { metricConfig } from "../scoutingConfig";
import { legacyMetricKeys } from "../types";
import { entryFromPlayer } from "../watchlistStorage";
import { duelPressEntry, legacyV3Entry } from "../watchlistStorageV3";
import type { WatchlistV3Entry } from "../watchlistV3Contracts";
import { TaxonomyWatchlistView } from "./TaxonomyWatchlistView";

const player = duelPressPlayerSchema.parse(validLeaderboard.data[0]);
const context = { season: "2025/2026", mode: "league" as const, scope: 8 as const, competition: "all" as const };
const noop = () => undefined;
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function View({ entries, resolutions = {}, legacyResolutions = {}, onRemove = noop }: { entries: readonly WatchlistV3Entry[]; resolutions?: React.ComponentProps<typeof TaxonomyWatchlistView>["resolutions"]; legacyResolutions?: NonNullable<React.ComponentProps<typeof TaxonomyWatchlistView>["legacyResolutions"]>; onRemove?: React.ComponentProps<typeof TaxonomyWatchlistView>["onRemove"] }) {
  const [preferences, setPreferences] = useState<Record<string, "saved" | "current">>({}); const fallbackFocusRef = useRef<HTMLParagraphElement>(null);
  return <><p ref={fallbackFocusRef} tabIndex={-1}>Watchlist results summary · {entries.length} saved contexts</p><TaxonomyWatchlistView entries={entries} resolutions={resolutions} legacyResolutions={legacyResolutions} preferences={preferences} fallbackFocusRef={fallbackFocusRef} onPreference={(key, value) => setPreferences((state) => ({ ...state, [key]: value }))} onRemove={onRemove} onRetry={noop} /></>;
}

describe("shared Watchlist V3 leaderboard presentation", () => {
  it("renders the duel taxonomy as an exact 12-column shared table with bands, tier, and snapshot tooltips", async () => {
    const entry = duelPressEntry(player, context); const { container } = render(<View entries={[entry]} resolutions={{ [entry.key]: { status: "offline" } }} />);
    const headers = screen.getAllByRole("columnheader"); expect(headers).toHaveLength(12); expect(headers.map((header) => header.textContent)).toEqual(["Player profile", "Tier", "M.E.S.S.I.", ...DUEL_PRESS_METRIC_KEYS.map((key) => duelPressMetricConfig[key].label), "Minutes", "Age", "Watch"]);
    expect(container.querySelector("tbody tr")).toHaveClass("h-20"); expect(screen.getAllByLabelText(/Overall M\.E\.S\.S\.I\. tier/)).toHaveLength(2);
    for (const key of DUEL_PRESS_METRIC_KEYS) expect(screen.getAllByLabelText(new RegExp(`^${duelPressMetricConfig[key].label} ${player.stats[key]}`))).toHaveLength(2);
    expect(screen.queryByText(metricConfig.aerial.label)).not.toBeInTheDocument(); expect(screen.queryByText(metricConfig.groundDuel.label)).not.toBeInTheDocument();
    fireEvent.focus(screen.getAllByLabelText(new RegExp(`^${duelPressMetricConfig.outsideShot.label} ${player.stats.outsideShot}`))[0]);
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Stored score at save time"); expect(screen.getAllByText("Offline · saved snapshot")).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: /Remove Harry Kane.*2025\/2026.*8 leagues/i })).toHaveLength(2); expect(screen.queryByText("✓")).not.toBeInTheDocument();
  });

  it("keeps legacy Aerial/Ground duel labels unchanged and excludes duel-only labels", () => {
    const snapshot = { profile: "complete" as const, name: samplePlayers[0].name, position: samplePlayers[0].position, clubName: samplePlayers[0].club.name, leagueName: samplePlayers[0].league.name, face: samplePlayers[0].face, score: samplePlayers[0].score, tier: samplePlayers[0].tier, archetype: samplePlayers[0].archetype, age: samplePlayers[0].age, minutes: samplePlayers[0].minutes, stats: samplePlayers[0].stats };
    const entry = legacyV3Entry(samplePlayers[0].id, snapshot, context); render(<View entries={[entry]} legacyResolutions={{ [entry.key]: { status: "offline" } }} />);
    const headers = screen.getAllByRole("columnheader"); expect(headers).toHaveLength(12); expect(headers.map((header) => header.textContent)).toEqual(["Player profile", "Tier", "M.E.S.S.I.", ...legacyMetricKeys.map((key) => metricConfig[key].label), "Minutes", "Age", "Watch"]);
    expect(screen.getByText(metricConfig.aerial.label)).toBeInTheDocument(); expect(screen.getByText(metricConfig.groundDuel.label)).toBeInTheDocument(); expect(screen.queryByText(duelPressMetricConfig.combinedDuel.label)).not.toBeInTheDocument(); expect(screen.queryByText(duelPressMetricConfig.forwardPress.label)).not.toBeInTheDocument();
  });

  it("keeps the immutable duel snapshot visible while its current resolver is pending", () => {
    const entry = duelPressEntry(player, context); render(<View entries={[entry]} resolutions={{ [entry.key]: { status: "pending" } }} />); expect(screen.getAllByText("Refreshing · saved snapshot visible")).toHaveLength(2); expect(screen.getAllByRole("link", { name: player.name })).toHaveLength(2); expect(screen.getAllByText(player.score.toFixed(1))).toHaveLength(2); expect(screen.queryByRole("combobox", { name: `${player.name} saved or current snapshot` })).not.toBeInTheDocument();
  });

  it("keeps same-player contexts independently keyed, omits duplicate DOM ids, preserves exact hrefs, and removes the exact key", () => {
    const otherContext = { ...context, season: "2024/2025" }; const first = duelPressEntry(player, context); const second = duelPressEntry(player, otherContext); const remove = vi.fn(); const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { container } = render(<View entries={[first, second]} onRemove={remove} />); expect(container.querySelectorAll('[id^="player-"]')).toHaveLength(0); expect(error.mock.calls.flat().join(" ")).not.toMatch(/unique.*key/i);
    const hrefs = new Set(screen.getAllByRole("link", { name: player.name }).map((link) => link.getAttribute("href"))); expect(hrefs).toEqual(new Set([duelPressDetailHref(player.id, context), duelPressDetailHref(player.id, otherContext)]));
    const table = screen.getByRole("table", { name: "Saved duel and press taxonomy contexts" }); fireEvent.click(within(table).getByRole("button", { name: /Remove Harry Kane.*2024\/2025/i })); expect(remove).toHaveBeenCalledWith(second.key);
  });

  it("switches every displayed field atomically between current and saved duel profiles without changing the saved-context href", () => {
    const entry = duelPressEntry(player, context); const current = { ...player, rank: 7, name: "Current Identity", face: "https://example.com/current.png", nation: { id: 9, name: "Current Nation", icon: "https://example.com/nation.png" }, league: { id: 10, name: "Current League", icon: "https://example.com/league.png" }, club: { id: 11, name: "Current Club", icon: "https://example.com/club.png" }, position: "Current Position", archetype: "Type B" as const, tier: { code: "emerald" as const, level: 2, label: "Emerald", taxonomyVersion: "crystal-v2" as const }, score: 77.7, stats: Object.fromEntries(DUEL_PRESS_METRIC_KEYS.map((key, index) => [key, 11.1 + index])) as typeof player.stats, minutes: 1111, age: 21 };
    render(<View entries={[entry]} resolutions={{ [entry.key]: { status: "current", player: current } }} />);
    expect(screen.getAllByRole("link", { name: current.name })).toHaveLength(2); expect(screen.getAllByRole("link", { name: current.name })[0]).toHaveAttribute("href", duelPressDetailHref(entry.playerId, context)); expect(screen.getAllByRole("img", { name: `${current.name} portrait` })[0]).toHaveAttribute("src", current.face); expect(screen.getByText("Current Club · Current League")).toBeInTheDocument(); expect(screen.getAllByText("Current Position")).toHaveLength(2); expect(screen.getAllByText("Type B")).toHaveLength(2); expect(screen.getAllByText("Rank 7")).toHaveLength(2); expect(screen.getAllByText("77.7")).toHaveLength(2); expect(screen.getAllByText("1,111").length).toBeGreaterThan(0); expect(screen.getAllByText("21").length).toBeGreaterThan(0); expect(screen.getAllByLabelText("Overall M.E.S.S.I. tier: Emerald, level 2")).toHaveLength(2); expect(screen.getAllByLabelText(new RegExp(`^${duelPressMetricConfig.outsideShot.label} 11.1`))).toHaveLength(2);
    fireEvent.change(screen.getAllByRole("combobox", { name: `${current.name} saved or current snapshot` })[0], { target: { value: "saved" } });
    expect(screen.queryByRole("link", { name: current.name })).not.toBeInTheDocument(); expect(screen.getAllByRole("link", { name: player.name })).toHaveLength(2); expect(screen.getAllByRole("img", { name: `${player.name} portrait` })[0]).toHaveAttribute("src", player.face); expect(screen.getByText(`${player.club.name} · ${player.league.name}`)).toBeInTheDocument(); expect(screen.getAllByText(`Rank ${player.rank}`)).toHaveLength(2); expect(screen.getAllByText(player.score.toFixed(1))).toHaveLength(2); expect(screen.getAllByLabelText(new RegExp(`^${duelPressMetricConfig.outsideShot.label} ${player.stats.outsideShot}`))).toHaveLength(2); expect(screen.getAllByRole("link", { name: player.name })[0]).toHaveAttribute("href", duelPressDetailHref(entry.playerId, context));
  });

  it("keeps legacy current/saved identity and quality atomic", () => {
    const snapshot = entryFromPlayer(samplePlayers[0], { season: context.season, mode: "league", scope: 8, competition: null }).snapshot; const entry = legacyV3Entry(samplePlayers[0].id, snapshot, context); const current = { ...samplePlayers[0], rank: 19, name: "Resolved Legacy", face: "https://example.com/resolved.png", club: { id: 31, name: "Resolved Club", icon: "https://example.com/club.png" }, league: { id: 32, name: "Resolved League", icon: "https://example.com/league.png" }, tier: { code: "gold", label: "Gold", level: 3 }, score: 66.6, stats: { ...samplePlayers[0].stats, outsideShot: 14.2 }, minutes: 1414, age: 29 };
    const quality = { kind: "incomplete" as const, dataQuality: { qualityVersion: "messi-quality-v1" as const, spatialAvailable: true, messiScoreComplete: false, reason: "source_metric_missing" as const, imputedMetrics: ["outsideShot" as const], imputedComponents: [], observedWeightPct: 80, fallbackComponentScore: 20 as const } };
    function LegacyView() { const [preferences, setPreferences] = useState<Record<string, "saved" | "current">>({}); const fallbackFocusRef = useRef<HTMLParagraphElement>(null); return <><p ref={fallbackFocusRef} tabIndex={-1}>Watchlist results summary</p><TaxonomyWatchlistView entries={[entry]} resolutions={{}} legacyResolutions={{ [entry.key]: { status: "current", player: current } }} legacyQuality={{ [entry.key]: quality }} preferences={preferences} fallbackFocusRef={fallbackFocusRef} onPreference={(key, value) => setPreferences({ [key]: value })} onRemove={noop} onRetry={noop} /></>; }
    const { container } = render(<LegacyView />); expect(screen.getAllByRole("link", { name: current.name })).toHaveLength(2); expect(screen.getAllByText("Rank 19")).toHaveLength(2); expect(screen.getAllByLabelText(new RegExp(`^${metricConfig.outsideShot.label} 14.2`))).toHaveLength(2); expect(container.querySelectorAll('[aria-describedby^="quality-tooltip-"]')).toHaveLength(2);
    fireEvent.change(screen.getAllByRole("combobox", { name: `${current.name} saved or current snapshot` })[0], { target: { value: "saved" } }); expect(screen.queryByRole("link", { name: current.name })).not.toBeInTheDocument(); expect(screen.getAllByRole("link", { name: snapshot.name })).toHaveLength(2); expect(screen.getAllByText(`Rank ${snapshot.rank}`)).toHaveLength(2); expect(container.querySelectorAll('[aria-describedby^="quality-tooltip-"]')).toHaveLength(0);
  });

  it("renders a historical partial legacy snapshot without fabricated assets, tier, rank, or metrics", () => {
    const entry = legacyV3Entry(999, { profile: "legacy-partial", name: "Historical Player", position: "", clubName: "Historical Club" }, context); const { container } = render(<View entries={[entry]} legacyResolutions={{ [entry.key]: { status: "offline" } }} />);
    expect(screen.queryByRole("img")).not.toBeInTheDocument(); expect(screen.getAllByLabelText("Historical Player portrait unavailable")).toHaveLength(2); expect(screen.getAllByLabelText("Tier unavailable")).toHaveLength(2); expect(screen.getAllByText("Rank unavailable")).toHaveLength(2);
    for (const key of legacyMetricKeys) expect(screen.getAllByLabelText(`${metricConfig[key].label} unavailable`)).toHaveLength(2);
    expect(container.querySelectorAll("article .grid-cols-3 > div")).toHaveLength(6); expect(screen.getAllByText("Saved snapshot").length).toBeGreaterThan(0); expect(screen.getAllByRole("button", { name: /Remove Historical Player/ })).toHaveLength(2);
  });

  it("uses a 3x2 mobile metric grid with current/saved and 44px Remove actions", () => {
    const entry = duelPressEntry(player, context); const { container } = render(<View entries={[entry]} resolutions={{ [entry.key]: { status: "current", player } }} />); const card = container.querySelector("article")!;
    expect(card.querySelectorAll(".grid-cols-3 > div")).toHaveLength(6); expect(within(card).getByRole("combobox", { name: `${player.name} saved or current snapshot` })).toHaveClass("min-h-11"); expect(within(card).getByRole("button", { name: /Remove Harry Kane/ })).toHaveClass("min-h-11"); expect(within(card).getByLabelText(/Overall M\.E\.S\.S\.I\. tier/)).toBeInTheDocument();
  });

  it("moves focus next then previous after success and keeps focus on failure", async () => {
    const entries = [duelPressEntry(player, context), duelPressEntry(player, { ...context, season: "2024/2025" }), duelPressEntry(player, { ...context, season: "2023/2024" })];
    function FocusView() { const [saved, setSaved] = useState(entries); return <View entries={saved} onRemove={async (key) => { setSaved((rows) => rows.filter((entry) => entry.key !== key)); return true; }} />; }
    const success = render(<FocusView />); const firstTable = screen.getByRole("table", { name: "Saved duel and press taxonomy contexts" }); const firstRemove = within(firstTable).getByRole("button", { name: /Remove Harry Kane.*2025\/2026/i }); firstRemove.focus(); fireEvent.click(firstRemove);
    await waitFor(() => expect(document.activeElement).toHaveAccessibleName(expect.stringMatching(/Remove Harry Kane.*2024\/2025/i))); success.unmount();
    const previous = render(<FocusView />); const lastTable = screen.getByRole("table", { name: "Saved duel and press taxonomy contexts" }); const lastRemove = within(lastTable).getByRole("button", { name: /Remove Harry Kane.*2023\/2024/i }); lastRemove.focus(); fireEvent.click(lastRemove); await waitFor(() => expect(document.activeElement).toHaveAccessibleName(expect.stringMatching(/Remove Harry Kane.*2024\/2025/i))); previous.unmount();
    render(<View entries={[entries[0]]} onRemove={async () => false} />); const failed = within(screen.getByRole("table", { name: "Saved duel and press taxonomy contexts" })).getByRole("button", { name: /Remove Harry Kane/ }); failed.focus(); fireEvent.click(failed); await waitFor(() => expect(document.activeElement).toBe(failed));
  });

  it("focuses the stable Watchlist results summary after removing the final entry", async () => {
    const entry = duelPressEntry(player, context); function LastEntryView() { const [saved, setSaved] = useState<WatchlistV3Entry[]>([entry]); return <View entries={saved} onRemove={async (key) => { setSaved((rows) => rows.filter((candidate) => candidate.key !== key)); return true; }} />; }
    render(<LastEntryView />); const remove = within(screen.getByRole("table", { name: "Saved duel and press taxonomy contexts" })).getByRole("button", { name: /Remove Harry Kane/ }); remove.focus(); fireEvent.click(remove); await waitFor(() => expect(document.activeElement).toHaveTextContent("Watchlist results summary · 0 saved contexts")); expect(screen.getByText("Watchlist results summary · 0 saved contexts")).toBeInTheDocument(); expect(screen.queryByRole("heading", { name: "Duel / Press taxonomy" })).not.toBeInTheDocument();
  });

  it("keeps an empty-state semantic results summary mounted", () => {
    render(<View entries={[]} />); expect(screen.getByText("Watchlist results summary · 0 saved contexts")).toHaveAttribute("tabindex", "-1"); expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });
});
