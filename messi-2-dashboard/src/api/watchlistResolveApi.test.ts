import { afterEach, describe, expect, it, vi } from "vitest";

import { entryFromPlayer } from "../dashboard/watchlistStorage";
import { samplePlayers } from "../test/fixtures/players";
import { resolveWatchlistEntries } from "./watchlistResolveApi";

const config = { baseUrl: "https://api.example.test", season: "2025/2026", scope: 7 as const, limit: 1000 };
const context = { season: "2025/2026", mode: "league" as const, scope: 7 as const, competition: null };
const player = { ...samplePlayers[0], idNamespace: "fotmob", playerId: samplePlayers[0].id };

afterEach(() => vi.restoreAllMocks());

describe("watchlist resolver API", () => {
  it("chunks at 100 and ignores response keys that were not requested", async () => {
    const base = entryFromPlayer(samplePlayers[0], context);
    const entries = Array.from({ length: 101 }, (_, index) => ({ ...base, key: `${base.key}|${index}` }));
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      const sent = JSON.parse(String(init?.body)).entries as { key: string }[];
      return new Response(JSON.stringify({ results: [{ key: sent[0].key, status: "resolved", player, context }, { key: "not-requested", status: "unavailable", player: null, context: null }] }));
    });
    const results = await resolveWatchlistEntries(config, entries);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body)).entries).toHaveLength(100);
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body)).entries).toHaveLength(1);
    expect(results).toHaveLength(2);
    expect(results.every((result) => result.key !== "not-requested")).toBe(true);
  });
});
