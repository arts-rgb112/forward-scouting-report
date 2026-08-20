import { describe, expect, it, vi } from "vitest";
import validLeaderboard from "../../../docs/fixtures/duel_press_v1/valid_leaderboard.json";
import { duelPressPlayerSchema } from "../api/duelPressContracts";
import { entryFromPlayer, WATCHLIST_KEY } from "./watchlistStorage";
import { duelPressEntry, legacyV3Entry } from "./watchlistStorageV3";
import { bootWatchlistV3, commitWatchlistV3Operation, createMemoryWatchlistV3LockCoordinator, parseWatchlistV3StorageEvent, persistWatchlistV3, WATCHLIST_V3_MIGRATION_MARKER_KEY } from "./watchlistV3Repository";
import { parseWatchlistV3, WATCHLIST_V3_KEY, watchlistV3EnvelopeSchema, watchlistV3Key } from "./watchlistV3Contracts";
import { samplePlayers } from "../test/fixtures/players";

const now = "2026-08-20T00:00:00.000Z"; const context = { season: "2025/2026", mode: "league" as const, scope: 8 as const, competition: "all" as const };
const player = duelPressPlayerSchema.parse(validLeaderboard.data[0]); const entry = duelPressEntry(player, context, now);
const envelope = { version: 3 as const, entries: [entry], selectedEntryKeys: [entry.key], migration: { v2SourceKey: WATCHLIST_KEY, completedAt: now }, updatedAt: now };

describe("Watchlist V3 strict contract", () => {
  it("accepts a canonical immutable duel snapshot", () => { expect(watchlistV3EnvelopeSchema.parse(envelope)).toEqual(envelope); expect(parseWatchlistV3(JSON.stringify(envelope))).not.toBe(envelope); });
  it("rejects extra, missing, corrupt, duplicate and non-canonical identity data", () => {
    expect(watchlistV3EnvelopeSchema.safeParse({ ...envelope, extra: true }).success).toBe(false);
    expect(watchlistV3EnvelopeSchema.safeParse({ ...envelope, updatedAt: undefined }).success).toBe(false);
    expect(parseWatchlistV3("not json")).toBeNull();
    expect(watchlistV3EnvelopeSchema.safeParse({ ...envelope, entries: [entry, entry] }).success).toBe(false);
    expect(watchlistV3EnvelopeSchema.safeParse({ ...envelope, entries: [{ ...entry, key: "wrong" }], selectedEntryKeys: [] }).success).toBe(false);
    expect(watchlistV3EnvelopeSchema.safeParse({ ...envelope, entries: [{ ...entry, snapshot: { ...entry.snapshot, id: entry.playerId + 1 } }], selectedEntryKeys: [] }).success).toBe(false);
    expect(watchlistV3EnvelopeSchema.safeParse({ ...envelope, entries: [{ ...entry, context: { ...context, competition: "ucl" } }], selectedEntryKeys: [] }).success).toBe(false);
  });
  it("preserves raw zero/null/source truth and rejects contradictions", () => {
    const raw = { ...entry.snapshot.pressingRawMetrics, recoveries: 0, recoveriesPer90: 0, recoveriesSource: "player_season_total" as const };
    expect(watchlistV3EnvelopeSchema.safeParse({ ...envelope, entries: [{ ...entry, snapshot: { ...entry.snapshot, pressingRawMetrics: raw } }] }).success).toBe(true);
    expect(watchlistV3EnvelopeSchema.safeParse({ ...envelope, entries: [{ ...entry, snapshot: { ...entry.snapshot, pressingRawMetrics: { ...raw, recoveriesSource: null } } }] }).success).toBe(false);
  });
  it("rejects unknown, duplicate, or more than two selected keys", () => {
    expect(watchlistV3EnvelopeSchema.safeParse({ ...envelope, selectedEntryKeys: ["unknown"] }).success).toBe(false);
    expect(watchlistV3EnvelopeSchema.safeParse({ ...envelope, selectedEntryKeys: [entry.key, entry.key] }).success).toBe(false);
    expect(watchlistV3EnvelopeSchema.safeParse({ ...envelope, selectedEntryKeys: [entry.key, entry.key, entry.key] }).success).toBe(false);
  });
  it("makes same player cross-season and cross-taxonomy identities distinct", () => {
    const other = { ...context, season: "2024/2025" }; expect(watchlistV3Key("duel-press-v1", player.id, context)).not.toBe(watchlistV3Key("duel-press-v1", player.id, other)); expect(watchlistV3Key("legacy-v1", player.id, context)).not.toBe(entry.key);
  });
  it("accepts historical partial legacy snapshots and future saves with only real identity assets", () => {
    const historical = legacyV3Entry(999, { profile: "legacy-partial", name: "Historical", position: "", clubName: "Known club" }, context, now); expect(watchlistV3EnvelopeSchema.safeParse({ ...envelope, entries: [historical], selectedEntryKeys: [] }).success).toBe(true);
    const future = legacyV3Entry(samplePlayers[0].id, entryFromPlayer(samplePlayers[0], { season: context.season, mode: "league", scope: 8, competition: null }, now).snapshot, context, now); const parsed = watchlistV3EnvelopeSchema.parse({ ...envelope, entries: [future], selectedEntryKeys: [] }); const snapshot = parsed.entries[0].taxonomy === "legacy-v1" ? parsed.entries[0].snapshot : null; expect(snapshot).toMatchObject({ rank: samplePlayers[0].rank, nation: samplePlayers[0].nation, league: samplePlayers[0].league, club: samplePlayers[0].club });
  });
});

describe("Watchlist V3 repository", () => {
  it("migrates V2 once without modifying its source or resurrecting removed entries", () => {
    const v2Entry = entryFromPlayer(samplePlayers[0], { season: context.season, mode: "league", scope: 8, competition: null }, now);
    const source = JSON.stringify({ version: 2, entries: [v2Entry], unresolvedLegacyIds: [], migration: { legacyKey: "messi-2-watchlist", migratedAt: null }, selectedEntryKeys: [] });
    const values = new Map([[WATCHLIST_KEY, source]]); const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
    const first = bootWatchlistV3(storage, now); expect(first.envelope.entries).toHaveLength(1); expect(values.get(WATCHLIST_KEY)).toBe(source);
    const removed = { ...first.envelope, entries: [], selectedEntryKeys: [], updatedAt: "2026-08-20T00:01:00.000Z" }; expect(persistWatchlistV3(storage, first.envelope, removed).ok).toBe(true);
    expect(bootWatchlistV3(storage, now).envelope.entries).toHaveLength(0); expect(values.get(WATCHLIST_KEY)).toBe(source);
  });
  it("never overwrites corrupt V3 and rolls back quota failures", () => {
    const getItem = vi.fn((key: string) => key === WATCHLIST_V3_KEY ? "corrupt" : null); const setItem = vi.fn(); const corrupt = bootWatchlistV3({ getItem, setItem }, now); expect(corrupt.writable).toBe(false); expect(setItem).not.toHaveBeenCalled();
    const candidate = { ...envelope, entries: [], selectedEntryKeys: [], updatedAt: "2026-08-20T00:01:00.000Z" }; const quota = persistWatchlistV3({ getItem: () => null, setItem: () => { throw new DOMException("quota", "QuotaExceededError"); } }, envelope, candidate); expect(quota.ok).toBe(false); expect(quota.envelope).toBe(envelope);
  });
  it("classifies storage events and blocks a mutation when persisted V3 becomes corrupt", async () => {
    expect(parseWatchlistV3StorageEvent("other", "bad")).toEqual({ kind: "unrelated" }); expect(parseWatchlistV3StorageEvent(WATCHLIST_V3_KEY, null)).toEqual({ kind: "deleted" }); expect(parseWatchlistV3StorageEvent(WATCHLIST_V3_KEY, "bad")).toEqual({ kind: "invalid" }); expect(parseWatchlistV3StorageEvent(WATCHLIST_V3_KEY, JSON.stringify(envelope)).kind).toBe("valid");
    const values = new Map([[WATCHLIST_V3_KEY, "corrupt"]]); const setItem = vi.fn((key: string, value: string) => values.set(key, value)); const result = await commitWatchlistV3Operation({ getItem: (key) => values.get(key) ?? null, setItem }, envelope, { type: "remove-entry", key: entry.key }, createMemoryWatchlistV3LockCoordinator()); expect(result).toMatchObject({ ok: false, readonly: true }); expect(setItem).not.toHaveBeenCalled(); expect(values.get(WATCHLIST_V3_KEY)).toBe("corrupt");
  });
  it("rebases serialized operations so two providers preserve both saves", async () => {
    const values = new Map([[WATCHLIST_V3_KEY, JSON.stringify({ ...envelope, entries: [], selectedEntryKeys: [], revision: 0 })]]); const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
    const second = duelPressEntry({ ...player, id: player.id + 1, name: "Second" }, context, now);
    const observed = parseWatchlistV3(values.get(WATCHLIST_V3_KEY)!)!; const coordinator = createMemoryWatchlistV3LockCoordinator(); const [left, right] = await Promise.all([commitWatchlistV3Operation(storage, observed, { type: "put-entry", entry }, coordinator), commitWatchlistV3Operation(storage, observed, { type: "put-entry", entry: second }, coordinator)]);
    expect(left.ok).toBe(true); expect(right.ok).toBe(true); const persisted = parseWatchlistV3(values.get(WATCHLIST_V3_KEY)!)!; expect(persisted.entries.map((item) => item.key)).toEqual([entry.key, second.key]); expect(persisted.revision).toBe(2);
  });
  it("refuses no-lock and lock-rejection mutations with typed rollback", async () => {
    const values = new Map([[WATCHLIST_V3_KEY, JSON.stringify(envelope)]]); const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
    await expect(commitWatchlistV3Operation(storage, envelope, { type: "remove-entry", key: entry.key }, { supported: false, runExclusive: async (task) => task() })).resolves.toMatchObject({ ok: false, readonly: true, error: expect.stringMatching(/Web Locks/) });
    await expect(commitWatchlistV3Operation(storage, envelope, { type: "remove-entry", key: entry.key }, { supported: true, runExclusive: async () => { throw new Error("denied"); } })).resolves.toMatchObject({ ok: false, readonly: true, error: expect.stringMatching(/lock could not be acquired/) }); expect(parseWatchlistV3(values.get(WATCHLIST_V3_KEY)!)!.entries).toHaveLength(1);
  });
  it("preserves the first immutable snapshot on duplicate save and removes only explicitly", async () => {
    const values = new Map([[WATCHLIST_V3_KEY, JSON.stringify(envelope)]]); const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } }; const coordinator = createMemoryWatchlistV3LockCoordinator(); const replacement = duelPressEntry({ ...player, name: "Changed later" }, context, "2026-09-01T00:00:00.000Z");
    const duplicate = await commitWatchlistV3Operation(storage, envelope, { type: "put-entry", entry: replacement }, coordinator); expect(duplicate).toMatchObject({ ok: true, changed: false }); let persisted = parseWatchlistV3(values.get(WATCHLIST_V3_KEY)!)!; expect(persisted.entries[0].snapshot.name).toBe(entry.snapshot.name); expect(persisted.entries[0].savedAt).toBe(entry.savedAt);
    await commitWatchlistV3Operation(storage, persisted, { type: "remove-entry", key: entry.key }, coordinator); persisted = parseWatchlistV3(values.get(WATCHLIST_V3_KEY)!)!; expect(persisted.entries).toHaveLength(0); await commitWatchlistV3Operation(storage, persisted, { type: "put-entry", entry: replacement }, coordinator); expect(parseWatchlistV3(values.get(WATCHLIST_V3_KEY)!)!.entries[0].savedAt).toBe(replacement.savedAt);
  });
  it("uses a durable migration marker so V3 deletion never resurrects V2", () => {
    const v2Entry = entryFromPlayer(samplePlayers[0], { season: context.season, mode: "league", scope: 8, competition: null }, now); const source = JSON.stringify({ version: 2, entries: [v2Entry], unresolvedLegacyIds: [], migration: { legacyKey: "messi-2-watchlist", migratedAt: null }, selectedEntryKeys: [] }); const values = new Map([[WATCHLIST_KEY, source]]); const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
    expect(bootWatchlistV3(storage, now).envelope.entries).toHaveLength(1); expect(values.has(WATCHLIST_V3_MIGRATION_MARKER_KEY)).toBe(true); values.delete(WATCHLIST_V3_KEY); const reloaded = bootWatchlistV3(storage, now); expect(reloaded.envelope.entries).toHaveLength(0); expect(reloaded.writable).toBe(false); expect(values.get(WATCHLIST_KEY)).toBe(source);
    values.set(WATCHLIST_V3_MIGRATION_MARKER_KEY, "corrupt"); const corruptMarker = bootWatchlistV3(storage, now); expect(corruptMarker.writable).toBe(false); expect(corruptMarker.error).toMatch(/marker is corrupt/); expect(values.get(WATCHLIST_KEY)).toBe(source);
  });
  it("writes the migration tombstone before V3 so a partial initialization cannot remigrate V2", () => {
    const v2Entry = entryFromPlayer(samplePlayers[0], { season: context.season, mode: "league", scope: 8, competition: null }, now); const source = JSON.stringify({ version: 2, entries: [v2Entry], unresolvedLegacyIds: [], migration: { legacyKey: "messi-2-watchlist", migratedAt: null }, selectedEntryKeys: [] }); const values = new Map([[WATCHLIST_KEY, source]]);
    const partial = bootWatchlistV3({ getItem: (key) => values.get(key) ?? null, setItem: (key, value) => { if (key === WATCHLIST_V3_KEY) throw new DOMException("quota", "QuotaExceededError"); values.set(key, value); } }, now); expect(partial.writable).toBe(false); expect(values.has(WATCHLIST_V3_MIGRATION_MARKER_KEY)).toBe(true); expect(values.has(WATCHLIST_V3_KEY)).toBe(false);
    const reloaded = bootWatchlistV3({ getItem: (key) => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); } }, now); expect(reloaded.writable).toBe(false); expect(reloaded.envelope.entries).toHaveLength(0); expect(values.get(WATCHLIST_KEY)).toBe(source);
  });
});
