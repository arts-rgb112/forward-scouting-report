import { describe, expect, it } from "vitest";
import validLeaderboard from "../../../docs/fixtures/duel_press_v1/valid_leaderboard.json";
import { duelPressPlayerSchema } from "../api/duelPressContracts";
import { DuelPressApiError } from "../api/duelPressApi";
import { duelPressEntry } from "./watchlistStorageV3";
import { duelResolutionFromError, resolveVisibleDuelWatchlistEntries } from "./duelPressWatchlistResolver";

const config = { baseUrl: "https://api.test", season: "2025/2026", scope: 8 as const, limit: 1000 }; const context = { season: "2025/2026", mode: "league" as const, scope: 8 as const, competition: "all" as const };
const base = duelPressPlayerSchema.parse(validLeaderboard.data[0]);
describe("visible duel watchlist resolver", () => {
  it("caps concurrency at four and commits partial outcomes independently", async () => {
    const entries = Array.from({ length: 9 }, (_, index) => duelPressEntry({ ...base, id: base.id + index }, context)); let active = 0; let maximum = 0;
    const results: string[] = []; await resolveVisibleDuelWatchlistEntries(config, entries, new AbortController().signal, (key, result) => results.push(`${key}:${result.status}`), async (_config, entry) => { active += 1; maximum = Math.max(maximum, active); await Promise.resolve(); active -= 1; if (entry.playerId === base.id + 3) throw new DuelPressApiError("not-found"); return { ...base, id: entry.playerId }; });
    expect(maximum).toBe(4); expect(results).toHaveLength(9); expect(results.some((result) => result.endsWith(":unavailable"))).toBe(true);
  });
  it("deduplicates resource keys and stops commits after abort", async () => {
    const entry = duelPressEntry(base, context); let calls = 0; const committed: string[] = [];
    await resolveVisibleDuelWatchlistEntries(config, [entry, entry], new AbortController().signal, (key) => committed.push(key), async () => { calls += 1; return base; }); expect(calls).toBe(1); expect(committed).toHaveLength(2);
    const controller = new AbortController(); await resolveVisibleDuelWatchlistEntries(config, [entry], controller.signal, (key) => committed.push(key), async () => { controller.abort(); return base; }); expect(committed).toHaveLength(2);
  });
  it("isolates 404, 422, schema, and network statuses", () => {
    expect(duelResolutionFromError(new DuelPressApiError("not-found")).status).toBe("unavailable"); expect(duelResolutionFromError(new DuelPressApiError("invalid-request")).status).toBe("unavailable"); expect(duelResolutionFromError(new DuelPressApiError("schema")).status).toBe("contract-error"); expect(duelResolutionFromError(new TypeError("offline")).status).toBe("offline");
  });
});
