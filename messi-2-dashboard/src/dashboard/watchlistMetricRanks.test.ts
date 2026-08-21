// @vitest-environment jsdom
import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import validLeaderboard from "../../../docs/fixtures/duel_press_v1/valid_leaderboard.json";
import { adaptDuelPressPlayerCore } from "../api/duelPressAdapter";
import { duelPressLeaderboardCoreSchema } from "../api/duelPressContracts";
import { duelPressEntry } from "./watchlistStorageV3";
import { watchlistMetricRankTargets } from "./DuelPressLeaderboardDashboard";
import { clearMetricRanksCacheForTests, useMetricRanks } from "./useMetricRanks";

const player = adaptDuelPressPlayerCore(duelPressLeaderboardCoreSchema.parse(validLeaderboard).data[0]);
const entry = (season: string) => duelPressEntry(player, { season, mode: "league", scope: 8, competition: "all" });
const current = (item: ReturnType<typeof entry>) => ({ status: "current" as const, player: { ...player, id: item.playerId } });
const config = { baseUrl: "https://api.example.test", season: "2025/2026", scope: 8 as const, limit: 1000 };
const metrics = { outsideShot: { rank: 1, population: 100 }, boxThreat: { rank: 2, population: 100 }, dangerZone: { rank: 3, population: 100 }, combinedDuel: { rank: 4, population: 100 }, spaceControl: { rank: 5, population: 100 }, forwardPress: { rank: 6, population: 100 } };
afterEach(() => { vi.unstubAllGlobals(); clearMetricRanksCacheForTests(); });

describe("Watchlist metric-ranks terminal gating", () => {
  it("waits through A → A+B → A+B+C resolver progress and then returns one stable batch", () => {
    const entries = [entry("2025/2026"), entry("2024/2025"), entry("2023/2024")];
    expect(watchlistMetricRankTargets(entries, {}, {})).toEqual([]);
    expect(watchlistMetricRankTargets(entries, { [entries[0].key]: current(entries[0]) }, {})).toEqual([]);
    expect(watchlistMetricRankTargets(entries, { [entries[0].key]: current(entries[0]), [entries[1].key]: current(entries[1]) }, {})).toEqual([]);
    expect(watchlistMetricRankTargets(entries, { [entries[0].key]: current(entries[0]), [entries[1].key]: current(entries[1]), [entries[2].key]: current(entries[2]) }, {})).toEqual(entries.map((item) => ({ key: item.key, playerId: item.playerId, context: item.context })));
  });

  it("handles four progressive workers, partial terminal failures, and saved switches without requesting stale contexts", () => {
    const entries = [entry("2025/2026"), entry("2024/2025"), entry("2023/2024"), entry("2022/2023")];
    const all = Object.fromEntries(entries.map((item, index) => [item.key, index === 1 ? { status: "unavailable" as const } : current(item)]));
    expect(watchlistMetricRankTargets(entries, all, {})).toEqual([entries[0], entries[2], entries[3]].map((item) => ({ key: item.key, playerId: item.playerId, context: item.context })));
    expect(watchlistMetricRankTargets(entries, all, { [entries[2].key]: "saved" })).toEqual([entries[0], entries[3]].map((item) => ({ key: item.key, playerId: item.playerId, context: item.context })));
  });

  it("makes exactly one rank POST after progressive visible resolvers become stable", async () => {
    const entries = [entry("2025/2026"), entry("2024/2025"), entry("2023/2024")];
    const fetcher = vi.fn((_: string, init: RequestInit) => {
      const entries = JSON.parse(String(init.body)).entries;
      return new Response(JSON.stringify({ schemaVersion: "1.0.0", results: entries.map((item: { key: string; player: { playerId: number }; context: unknown }) => ({ ...item, metricTaxonomyVersion: "duel-press-v1", status: "resolved", metrics })) }));
    });
    vi.stubGlobal("fetch", fetcher);
    const view = renderHook(({ resolutions }) => useMetricRanks(config, watchlistMetricRankTargets(entries, resolutions, {}), true), { initialProps: { resolutions: {} } });
    view.rerender({ resolutions: { [entries[0].key]: current(entries[0]) } });
    view.rerender({ resolutions: { [entries[0].key]: current(entries[0]), [entries[1].key]: current(entries[1]) } });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(fetcher).not.toHaveBeenCalled();
    view.rerender({ resolutions: { [entries[0].key]: current(entries[0]), [entries[1].key]: current(entries[1]), [entries[2].key]: current(entries[2]) } });
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    expect(JSON.parse(fetcher.mock.calls[0][1].body).entries.map((item: { key: string }) => item.key)).toEqual(entries.map((item) => item.key));
  });
});
