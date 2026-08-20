// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { samplePlayers } from "../../test/fixtures/players";
import { entryFromPlayer } from "../watchlistStorage";
import { legacyV3Entry } from "../watchlistStorageV3";
import { TaxonomyWatchlistView } from "./TaxonomyWatchlistView";

const context = { season: "2025/2026", mode: "league" as const, scope: 8 as const, competition: "all" as const }; const snapshot = entryFromPlayer(samplePlayers[0], { season: context.season, mode: "league", scope: 8, competition: null }).snapshot; const entry = legacyV3Entry(samplePlayers[0].id, snapshot, context); const current = { ...samplePlayers[0], score: 99, stats: { ...samplePlayers[0].stats, outsideShot: 12.34 } };
describe("mixed taxonomy Watchlist V3 presentation", () => {
  it("lets mobile and desktop legacy rows share current/saved preference", () => {
    function View() { const [preferences, setPreferences] = useState<Record<string, "saved" | "current">>({}); return <TaxonomyWatchlistView entries={[entry]} resolutions={{}} legacyResolutions={{ [entry.key]: { status: "current", player: current } }} preferences={preferences} onPreference={(key, value) => setPreferences((state) => ({ ...state, [key]: value }))} onRemove={vi.fn()} onRetry={vi.fn()} />; }
    render(<View />); expect(screen.getAllByText("99.0").length).toBeGreaterThan(0); expect(screen.getAllByText("12.3").length).toBeGreaterThan(0);
    const selectors = screen.getAllByRole("combobox", { name: `${current.name} saved or current snapshot` }); fireEvent.change(selectors.at(-1)!, { target: { value: "saved" } }); expect(screen.getAllByText(snapshot.score!.toFixed(1)).length).toBeGreaterThan(0); expect(screen.queryAllByText("12.3")).toHaveLength(0);
  });
});
