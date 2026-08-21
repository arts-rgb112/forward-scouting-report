import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchMetricRanks } from "./metricRanksApi";

const config = { baseUrl: "https://api.test", season: "2025/2026", scope: 8 as const, limit: 1000 };
const context = { season: "2025/2026", mode: "league" as const, scope: 8 as const, competition: "all" as const };
const entry = { key: "a", player: { idNamespace: "fotmob" as const, playerId: 1 }, metricTaxonomyVersion: "duel-press-v1" as const, context };
const metrics = { outsideShot: { rank: 1, population: 10 }, boxThreat: { rank: 2, population: 10 }, dangerZone: { rank: 3, population: 10 }, combinedDuel: { rank: 4, population: 10 }, spaceControl: { rank: 5, population: 10 }, forwardPress: { rank: 6, population: 10 } };
const request = { entries: [entry] };
const result = { ...entry, status: "resolved" as const, metrics };
afterEach(() => vi.unstubAllGlobals());

describe("metric-ranks optional transport", () => {
  it("posts the entries-only strict body without credentials", async () => { const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ schemaVersion: "1.0.0", results: [result] }))); vi.stubGlobal("fetch", fetcher); await expect(fetchMetricRanks(config, request)).resolves.toMatchObject({ results: [result] }); expect(new URL(fetcher.mock.calls[0][0]).pathname).toBe("/api/v2/metric-ranks"); expect(fetcher.mock.calls[0][1]).toMatchObject({ method: "POST", credentials: "omit" }); expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual(request); });
  it("rejects duplicate, missing, unknown, and mismatched response keys", async () => {
    const variants = [[result, result], [], [{ ...result, key: "unknown" }], [{ ...result, player: { ...result.player, playerId: 2 } }], [{ ...result, context: { ...context, scope: 7 as const } }], [{ ...result, metricTaxonomyVersion: "legacy-v1" as const, metrics: null, status: "unavailable" as const }]];
    for (const results of variants) { vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ schemaVersion: "1.0.0", results })))); await expect(fetchMetricRanks(config, request)).rejects.toMatchObject({ kind: "schema" }); }
  });
  it("rejects a response that echoes valid entries in a different order", async () => {
    const second = { ...entry, key: "b", player: { ...entry.player, playerId: 2 } };
    const two = { entries: [entry, second] };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ schemaVersion: "1.0.0", results: [{ ...second, status: "resolved", metrics }, { ...result }] }))));
    await expect(fetchMetricRanks(config, two)).rejects.toMatchObject({ kind: "schema" });
  });
  it("classifies strict parse, HTTP, network, and abort paths", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}"))); await expect(fetchMetricRanks(config, request)).rejects.toMatchObject({ kind: "schema" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("no", { status: 404 }))); await expect(fetchMetricRanks(config, request)).rejects.toMatchObject({ kind: "http" });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline"))); await expect(fetchMetricRanks(config, request)).rejects.toMatchObject({ kind: "network" });
    const controller = new AbortController(); controller.abort(); vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new DOMException("Abort", "AbortError"))); await expect(fetchMetricRanks(config, request, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  });
});
