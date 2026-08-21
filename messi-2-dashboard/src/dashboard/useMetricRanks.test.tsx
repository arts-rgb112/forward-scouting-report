// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { clearMetricRanksCacheForTests, useMetricRanks, type MetricRankTarget } from "./useMetricRanks";

const config = { baseUrl: "https://api.example.test", season: "2025/2026", scope: 8 as const, limit: 1000 };
const context = { season: "2025/2026", mode: "league" as const, scope: 8 as const, competition: "all" as const };
const metrics = { outsideShot: { rank: 1, population: 100 }, boxThreat: { rank: 2, population: 100 }, dangerZone: { rank: 3, population: 100 }, combinedDuel: { rank: 4, population: 100 }, spaceControl: { rank: 5, population: 100 }, forwardPress: { rank: 6, population: 100 } };
const target = (key: string, playerId: number, override = {}) => ({ key, playerId, context: { ...context, ...override } }) satisfies MetricRankTarget;
const responseFor = (entries: readonly { key: string; player: { playerId: number }; context: MetricRankTarget["context"] }[]) => ({ schemaVersion: "1.0.0", results: entries.map((entry) => ({ key: entry.key, player: { idNamespace: "fotmob", playerId: entry.player.playerId }, metricTaxonomyVersion: "duel-press-v1", context: entry.context, status: "resolved", metrics })) });

afterEach(() => { vi.unstubAllGlobals(); clearMetricRanksCacheForTests(); });

describe("useMetricRanks", () => {
  it("dedupes visible targets and sends a strict entries-only batch", async () => {
    const fetcher = vi.fn((_: string, init: RequestInit) => new Response(JSON.stringify(responseFor(JSON.parse(String(init.body)).entries))));
    vi.stubGlobal("fetch", fetcher);
    const current = target("leaderboard:1", 1);
    const { result } = renderHook(() => useMetricRanks(config, [current, current], true));
    await waitFor(() => expect(result.current[current.key]?.outsideShot).toMatchObject({ state: "resolved", rank: 1, population: 100 }));
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({ entries: [{ key: current.key, player: { idNamespace: "fotmob", playerId: 1 }, metricTaxonomyVersion: "duel-press-v1", context }] });
  });

  it("caches exact origin/context targets but isolates a changed context", async () => {
    const fetcher = vi.fn((_: string, init: RequestInit) => new Response(JSON.stringify(responseFor(JSON.parse(String(init.body)).entries))));
    vi.stubGlobal("fetch", fetcher);
    const first = target("leaderboard:1", 1);
    const firstView = renderHook(() => useMetricRanks(config, [first], true));
    await waitFor(() => expect(firstView.result.current[first.key]?.outsideShot?.state).toBe("resolved"));
    firstView.unmount();
    renderHook(() => useMetricRanks(config, [first], true));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetcher).toHaveBeenCalledTimes(1);
    const changed = target("leaderboard:1", 1, { season: "2024/2025" });
    const secondView = renderHook(() => useMetricRanks(config, [changed], true));
    await waitFor(() => expect(secondView.result.current[changed.key]?.outsideShot?.state).toBe("resolved"));
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("keeps cached overlap while requesting only the new page/search target", async () => {
    const fetcher = vi.fn((_: string, init: RequestInit) => new Response(JSON.stringify(responseFor(JSON.parse(String(init.body)).entries))));
    vi.stubGlobal("fetch", fetcher);
    const first = target("leaderboard:1", 1); const overlap = target("leaderboard:2", 2); const next = target("leaderboard:3", 3);
    const view = renderHook(({ targets }) => useMetricRanks(config, targets, true), { initialProps: { targets: [first, overlap] } });
    await waitFor(() => expect(view.result.current[overlap.key]?.outsideShot?.state).toBe("resolved"));
    view.rerender({ targets: [overlap, next] });
    await waitFor(() => expect(view.result.current[next.key]?.outsideShot?.state).toBe("resolved"));
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetcher.mock.calls[1][1].body).entries.map((entry: { key: string }) => entry.key)).toEqual([next.key]);
  });

  it("aborts stale targets and commits only the latest target generation", async () => {
    const requests: { init: RequestInit; resolve(value: Response): void }[] = [];
    vi.stubGlobal("fetch", vi.fn((_: string, init: RequestInit) => new Promise<Response>((resolve) => requests.push({ init, resolve }))));
    const first = target("leaderboard:1", 1); const second = target("leaderboard:2", 2);
    const view = renderHook(({ targets }) => useMetricRanks(config, targets, true), { initialProps: { targets: [first] } });
    await waitFor(() => expect(requests).toHaveLength(1));
    view.rerender({ targets: [second] });
    await waitFor(() => expect(requests).toHaveLength(2));
    expect((requests[0].init.signal as AbortSignal).aborted).toBe(true);
    requests[1].resolve(new Response(JSON.stringify(responseFor(JSON.parse(String(requests[1].init.body)).entries))));
    await waitFor(() => expect(view.result.current[second.key]?.outsideShot?.state).toBe("resolved"));
    expect(view.result.current[first.key]).toBeUndefined();
  });

  it("collapses StrictMode setup/cleanup into one effective POST and aborts on unmount", async () => {
    const fetcher = vi.fn((_: string, init: RequestInit) => new Promise<Response>(() => undefined));
    vi.stubGlobal("fetch", fetcher);
    const view = renderHook(() => useMetricRanks(config, [target("leaderboard:1", 1)], true), { wrapper: StrictMode });
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    const signal = fetcher.mock.calls[0][1].signal as AbortSignal;
    view.unmount();
    expect(signal.aborted).toBe(true);
  });
});
