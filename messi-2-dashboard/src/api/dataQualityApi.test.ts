import { afterEach, describe, expect, it, vi } from "vitest";

import { dataQualitySchema } from "./contracts";
import type { DataQualityDto } from "./contracts";
import { fetchPlayerDataQuality, fetchWatchlistDataQuality } from "./dataQualityApi";
import { qualityDisplay, watchlistQualityDisplays } from "../dashboard/dataQualityViewModel";
import { entryFromPlayer } from "../dashboard/watchlistStorage";
import { samplePlayers } from "../test/fixtures/players";

const config = { baseUrl: "https://api.example.test", season: "2025/2026", scope: 7 as const, limit: 1000 };
const state = { season: "2025/2026", mode: "league" as const, scope: 7 as const, competition: "all" as const };
const context = { season: "2025/2026", mode: "league" as const, scope: 7 as const, competition: null };
const incomplete: DataQualityDto = { qualityVersion: "messi-quality-v1", spatialAvailable: false, messiScoreComplete: false, reason: "spatial_session_missing", imputedMetrics: ["spaceControl"], imputedComponents: ["spaceControl.volume"], observedWeightPct: 62.5, fallbackComponentScore: 20 };
const complete: DataQualityDto = { qualityVersion: "messi-quality-v1", spatialAvailable: true, messiScoreComplete: true, reason: "complete", imputedMetrics: [], imputedComponents: [], observedWeightPct: 100, fallbackComponentScore: 20 };

afterEach(() => vi.restoreAllMocks());
describe("data quality companion contract", () => {
  it("rejects unknown keys, invalid fallback/pct, duplicated metrics, and invalid components", () => {
    expect(dataQualitySchema.safeParse({ ...incomplete, extra: true }).success).toBe(false);
    expect(dataQualitySchema.safeParse({ ...incomplete, fallbackComponentScore: 21 }).success).toBe(false);
    expect(dataQualitySchema.safeParse({ ...incomplete, observedWeightPct: 101 }).success).toBe(false);
    expect(dataQualitySchema.safeParse({ ...incomplete, imputedMetrics: ["spaceControl", "spaceControl"] }).success).toBe(false);
    expect(dataQualitySchema.safeParse({ ...incomplete, imputedComponents: ["spaceControl.other"] }).success).toBe(false);
    expect(dataQualitySchema.safeParse({ ...incomplete, imputedComponents: ["boxThreat.volume"] }).success).toBe(false);
    expect(dataQualitySchema.safeParse({ ...incomplete, messiScoreComplete: true }).success).toBe(false);
    expect(dataQualitySchema.safeParse({ ...incomplete, reason: "complete" }).success).toBe(false);
    expect(dataQualitySchema.safeParse({ ...incomplete, imputedMetrics: [], imputedComponents: [] }).success).toBe(false);
    expect(dataQualitySchema.safeParse(complete).success).toBe(true);
    expect(dataQualitySchema.safeParse({ ...complete, spatialAvailable: false }).success).toBe(false);
  });
  it("posts the exact resolve-shaped payload with credentials omitted and rejects more than 100 without fetching", async () => {
    const entry = entryFromPlayer(samplePlayers[0], context);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ results: [] })));
    await fetchWatchlistDataQuality(config, [entry]);
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({ entries: [{ key: entry.key, player: { idNamespace: "fotmob", playerId: entry.playerId }, context: entry.context }] });
    expect(fetchMock.mock.calls[0][1]?.credentials).toBe("omit");
    await expect(fetchWatchlistDataQuality(config, Array.from({ length: 101 }, () => entry))).rejects.toThrow();
    await expect(fetchWatchlistDataQuality(config, [])).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("fails closed for a mismatched GET identity and isolates bad batch siblings", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ data: { playerId: 2, ...context, dataQuality: incomplete } })));
    await expect(fetchPlayerDataQuality(config, 1, state)).rejects.toThrow("identity");
    const first = entryFromPlayer(samplePlayers[0], context); const second = entryFromPlayer({ ...samplePlayers[0], id: 2 }, context);
    const results = [{ key: first.key, status: "resolved" as const, playerId: first.playerId, context: first.context, dataQuality: incomplete }, { key: second.key, status: "unavailable" as const, playerId: null, context: null, dataQuality: null }];
    const displays = watchlistQualityDisplays([first, second], results);
    expect(displays[first.key].kind).toBe("incomplete"); expect(displays[second.key]).toMatchObject({ kind: "unknown", cause: "partial" });
    expect(qualityDisplay(complete).kind).toBe("complete");
  });
  it("rejects a contradictory complete companion response so callers show unknown quality", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ data: { playerId: 1, ...context, dataQuality: { ...complete, spatialAvailable: false } } })));
    await expect(fetchPlayerDataQuality(config, 1, state)).rejects.toMatchObject({ kind: "schema" });
  });
});
