// @vitest-environment jsdom
import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { samplePlayers } from "../test/fixtures/players";
import { entryFromPlayer } from "./watchlistStorage";
import { legacyV3Entry } from "./watchlistStorageV3";

const { fetchQuality } = vi.hoisted(() => ({ fetchQuality: vi.fn().mockResolvedValue([]) }));
vi.mock("../api/dataQualityApi", () => ({ fetchWatchlistDataQuality: fetchQuality }));
import { useLegacyWatchlistQuality } from "./useLegacyWatchlistQuality";

const config = { baseUrl: "https://api.test", season: "2025/2026", scope: 8 as const, limit: 1000 }; const context = { season: "2025/2026", mode: "league" as const, scope: 8 as const, competition: "all" as const }; const snapshot = entryFromPlayer(samplePlayers[0], { season: context.season, mode: "league", scope: 8, competition: null }).snapshot; const entry = legacyV3Entry(samplePlayers[0].id, snapshot, context);
describe("V3 legacy data quality bridge", () => {
  it("posts only current-resolved visible legacy entries", async () => {
    const { rerender } = renderHook(({ current }) => useLegacyWatchlistQuality(config, [entry], { [entry.key]: current ? { status: "current", player: samplePlayers[0] } : { status: "pending" } }, true), { initialProps: { current: false } }); expect(fetchQuality).not.toHaveBeenCalled(); rerender({ current: true }); await waitFor(() => expect(fetchQuality).toHaveBeenCalledTimes(1)); expect(fetchQuality.mock.calls[0][1]).toHaveLength(1); expect(fetchQuality.mock.calls[0][1][0].key).toBe(entry.key);
  });
});
