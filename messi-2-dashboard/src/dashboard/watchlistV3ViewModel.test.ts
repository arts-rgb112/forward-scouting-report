import { describe, expect, it } from "vitest";
import { samplePlayers } from "../test/fixtures/players";
import { entryFromPlayer } from "./watchlistStorage";
import { legacyV3Entry } from "./watchlistStorageV3";
import { defaultWatchlistV3Filters, filterAndSortWatchlistV3, watchlistV3Page } from "./watchlistV3ViewModel";

const context = { season: "2025/2026", mode: "league" as const, scope: 8 as const, competition: "all" as const }; const base = entryFromPlayer(samplePlayers[0], { season: context.season, mode: "league", scope: 8, competition: null }).snapshot;
const entries = Array.from({ length: 60 }, (_, index) => legacyV3Entry(index + 1, { ...base, name: `Player ${String(index).padStart(2, "0")}`, position: index % 3 ? "ST" : "CF", archetype: index < 50 ? "Type A" : "Type B", age: index === 3 ? null : 20 + index % 15, minutes: 200 + index * 50, score: index === 4 ? undefined : index }, context, new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString()));
describe("shared Watchlist V3 view model", () => {
  it("filters the full collection before taking one exact page of 50", () => { const view = watchlistV3Page(entries, { ...defaultWatchlistV3Filters, role: "Type B" }, 1); expect(view.total).toBe(10); expect(view.visible).toHaveLength(10); expect(view.visible.every((entry) => entry.snapshot.archetype === "Type B")).toBe(true); });
  it("applies query, position, age, and minutes filters together", () => { const rows = filterAndSortWatchlistV3(entries, { ...defaultWatchlistV3Filters, query: "Player 5", role: "Type B", position: "ST", ageBand: "26-30", minutesBand: "2000-2999" }); expect(rows.length).toBeGreaterThan(0); expect(rows.every((entry) => entry.snapshot.name.startsWith("Player 5") && entry.snapshot.position === "ST")).toBe(true); });
  it("matches saved display values without requiring diacritics", () => { const diaz = legacyV3Entry(99, { ...base, name: "Luis Díaz", clubName: "Real Betis", leagueName: "La Liga" }, context, "2026-01-02T00:00:00.000Z"); expect(filterAndSortWatchlistV3([diaz], { ...defaultWatchlistV3Filters, query: "Luis Diaz" })).toEqual([diaz]); });
  it("sorts null last in both directions with deterministic key ties and clamps pages", () => { const asc = filterAndSortWatchlistV3(entries, { ...defaultWatchlistV3Filters, sort: "score", direction: "asc" }); const desc = filterAndSortWatchlistV3(entries, { ...defaultWatchlistV3Filters, sort: "score", direction: "desc" }); expect(asc.at(-1)?.snapshot.score).toBeUndefined(); expect(desc.at(-1)?.snapshot.score).toBeUndefined(); const page = watchlistV3Page(entries, defaultWatchlistV3Filters, 99); expect(page.page).toBe(2); expect(page.visible).toHaveLength(10); });
});
