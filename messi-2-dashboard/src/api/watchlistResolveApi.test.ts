import { afterEach, describe, expect, it, vi } from "vitest";

import { entryFromPlayer } from "../dashboard/watchlistStorage";
import type { WatchlistEntry } from "../dashboard/watchlistStorage";
import { samplePlayers } from "../test/fixtures/players";
import type { WatchlistResolveResultDto } from "./contracts";
import { resolveWatchlistEntries } from "./watchlistResolveApi";

const config = { baseUrl: "https://api.example.test", season: "2025/2026", scope: 7 as const, limit: 1000 };
const context = { season: "2025/2026", mode: "league" as const, scope: 7 as const, competition: null };
const resolvedFor = (entry: WatchlistEntry): WatchlistResolveResultDto => ({
  key: entry.key,
  status: "resolved",
  player: { ...samplePlayers[0], id: entry.playerId, idNamespace: entry.namespace, playerId: entry.playerId },
  context: { ...entry.context },
});

const mockResults = (results: WatchlistResolveResultDto[]) => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ results })));
};

afterEach(() => vi.restoreAllMocks());

describe("watchlist resolver API", () => {
  it("chunks at 100 and does not associate unrequested responses with saved entries", async () => {
    const entries = Array.from({ length: 101 }, (_, index) => entryFromPlayer({ ...samplePlayers[0], id: index + 1 }, context));
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      const sent = JSON.parse(String(init?.body)).entries as { key: string }[];
      const entry = entries.find((candidate) => candidate.key === sent[0].key)!;
      return new Response(JSON.stringify({ results: [resolvedFor(entry), { key: "not-requested", status: "unavailable", player: null, context: null }] }));
    });
    const results = await resolveWatchlistEntries(config, entries);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body)).entries).toHaveLength(100);
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body)).entries).toHaveLength(1);
    expect(results).toHaveLength(101);
    expect(results.filter((result) => result.status === "resolved")).toHaveLength(2);
    expect(results.every((result) => result.key !== "not-requested")).toBe(true);
  });

  it.each([
    ["playerId", (result: WatchlistResolveResultDto) => ({ ...result, player: { ...result.player!, playerId: result.player!.playerId + 1 } })],
    ["player.id", (result: WatchlistResolveResultDto) => ({ ...result, player: { ...result.player!, id: result.player!.id + 1 } })],
    ["season", (result: WatchlistResolveResultDto) => ({ ...result, context: { ...result.context!, season: "2024/2025" } })],
    ["mode", (result: WatchlistResolveResultDto) => ({ ...result, context: { ...result.context!, mode: "europe" as const } })],
    ["scope", (result: WatchlistResolveResultDto) => ({ ...result, context: { ...result.context!, scope: 3 as const } })],
    ["competition", (result: WatchlistResolveResultDto) => ({ ...result, context: { ...result.context!, competition: "ucl" as const } })],
  ])("falls back to the saved snapshot when resolved %s does not match the request", async (_field, mutate) => {
    const entry = entryFromPlayer(samplePlayers[0], context);
    mockResults([mutate(resolvedFor(entry))]);

    await expect(resolveWatchlistEntries(config, [entry])).resolves.toEqual([{ key: entry.key, status: "unavailable" }]);
  });

  it("falls back to the saved snapshot for duplicate response keys", async () => {
    const entry = entryFromPlayer(samplePlayers[0], context);
    const matching = resolvedFor(entry);
    mockResults([matching, matching]);

    await expect(resolveWatchlistEntries(config, [entry])).resolves.toEqual([{ key: entry.key, status: "unavailable" }]);
  });

  it("returns a current profile only for an exact resolved response", async () => {
    const entry = entryFromPlayer(samplePlayers[0], context);
    mockResults([resolvedFor(entry)]);

    await expect(resolveWatchlistEntries(config, [entry])).resolves.toEqual([{ key: entry.key, status: "resolved", player: samplePlayers[0] }]);
  });
});
