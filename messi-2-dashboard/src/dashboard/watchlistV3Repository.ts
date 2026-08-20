import { WATCHLIST_KEY } from "./watchlistStorage";
import { migrateWatchlistV2Source } from "./watchlistStorageV3";
import { parseWatchlistV3, WATCHLIST_V2_SOURCE_KEY, WATCHLIST_V3_KEY, watchlistV3EnvelopeSchema, type WatchlistV3Entry, type WatchlistV3Envelope } from "./watchlistV3Contracts";
import { z } from "zod";

export type WatchlistV3RepositoryState = { envelope: WatchlistV3Envelope; writable: boolean; error: string | null };
export type StorageLike = Pick<Storage, "getItem" | "setItem">;
export const WATCHLIST_V3_MIGRATION_MARKER_KEY = "messi-2-watchlist:v3:v2-migration" as const;
const migrationMarkerSchema = z.object({ version: z.literal(1), sourceKey: z.literal(WATCHLIST_V2_SOURCE_KEY), completedAt: z.string().datetime({ offset: true }) }).strict();
export type WatchlistV3LockCoordinator = { supported: boolean; runExclusive<T>(task: () => Promise<T>): Promise<T> };
export type WatchlistV3StorageEventResult = { kind: "unrelated" } | { kind: "deleted" } | { kind: "invalid" } | { kind: "valid"; envelope: WatchlistV3Envelope };
export type WatchlistV3Operation =
  | { type: "put-entry"; entry: WatchlistV3Entry }
  | { type: "remove-entry"; key: string }
  | { type: "select-entry"; key: string }
  | { type: "unselect-entry"; key: string };
export type WatchlistV3MutationResult = { ok: true; envelope: WatchlistV3Envelope; changed: boolean } | { ok: false; envelope: WatchlistV3Envelope; error: string; readonly: boolean };

export const envelopeRevision = (envelope: WatchlistV3Envelope) => envelope.revision ?? 0;
export const emptyWatchlistV3 = (now = new Date().toISOString(), migrated = false): WatchlistV3Envelope => ({ version: 3, revision: 0, entries: [], selectedEntryKeys: [], migration: { v2SourceKey: WATCHLIST_V2_SOURCE_KEY, completedAt: migrated ? now : null }, updatedAt: now });

export function bootWatchlistV3(storage: StorageLike, now = new Date().toISOString()): WatchlistV3RepositoryState {
  let raw: string | null;
  try { raw = storage.getItem(WATCHLIST_V3_KEY); } catch { return { envelope: emptyWatchlistV3(now), writable: false, error: "Browser storage is unavailable." }; }
  if (raw !== null) {
    const parsed = parseWatchlistV3(raw);
    return parsed ? { envelope: parsed, writable: true, error: null } : { envelope: emptyWatchlistV3(now), writable: false, error: "Saved Watchlist V3 data is corrupt. It was left unchanged." };
  }
  let markerRaw: string | null;
  try { markerRaw = storage.getItem(WATCHLIST_V3_MIGRATION_MARKER_KEY); } catch { return { envelope: emptyWatchlistV3(now), writable: false, error: "Browser storage is unavailable." }; }
  if (markerRaw !== null) {
    let marker: unknown; try { marker = JSON.parse(markerRaw); } catch { marker = null; }
    if (!migrationMarkerSchema.safeParse(marker).success) return { envelope: emptyWatchlistV3(now), writable: false, error: "The Watchlist migration marker is corrupt. Legacy data was not remigrated." };
    return { envelope: emptyWatchlistV3(now, true), writable: false, error: "Watchlist V3 storage was removed after migration. Legacy entries were not resurrected; reload after storage recovery." };
  }
  let source: string | null = null;
  try { source = storage.getItem(WATCHLIST_KEY); } catch { /* an unreadable legacy source is equivalent to no migration source */ }
  const envelope: WatchlistV3Envelope = { ...emptyWatchlistV3(now, true), entries: migrateWatchlistV2Source(source) };
  const valid = watchlistV3EnvelopeSchema.parse(envelope);
  try { storage.setItem(WATCHLIST_V3_MIGRATION_MARKER_KEY, JSON.stringify({ version: 1, sourceKey: WATCHLIST_V2_SOURCE_KEY, completedAt: now })); storage.setItem(WATCHLIST_V3_KEY, JSON.stringify(valid)); return { envelope: structuredClone(valid), writable: true, error: null }; }
  catch { return { envelope: structuredClone(valid), writable: false, error: "Watchlist could not be initialized in browser storage." }; }
}

export function parseWatchlistV3StorageEvent(key: string | null, raw: string | null): WatchlistV3StorageEventResult {
  if (key !== WATCHLIST_V3_KEY) return { kind: "unrelated" };
  if (raw === null) return { kind: "deleted" };
  const envelope = parseWatchlistV3(raw); return envelope ? { kind: "valid", envelope } : { kind: "invalid" };
}

function applyOperation(base: WatchlistV3Envelope, operation: WatchlistV3Operation): { entries: WatchlistV3Entry[]; selectedEntryKeys: string[]; changed: boolean } | { error: string } {
  if (operation.type === "put-entry") {
    const index = base.entries.findIndex((entry) => entry.key === operation.entry.key);
    if (index < 0) return { entries: [...base.entries, structuredClone(operation.entry)], selectedEntryKeys: [...base.selectedEntryKeys], changed: true };
    return { entries: [...base.entries], selectedEntryKeys: [...base.selectedEntryKeys], changed: false };
  }
  if (operation.type === "remove-entry") {
    const entries = base.entries.filter((entry) => entry.key !== operation.key); const selectedEntryKeys = base.selectedEntryKeys.filter((key) => key !== operation.key);
    return { entries, selectedEntryKeys, changed: entries.length !== base.entries.length || selectedEntryKeys.length !== base.selectedEntryKeys.length };
  }
  if (!base.entries.some((entry) => entry.key === operation.key)) return { error: "That saved context is no longer available." };
  if (operation.type === "select-entry") {
    if (base.selectedEntryKeys.includes(operation.key)) return { entries: [...base.entries], selectedEntryKeys: [...base.selectedEntryKeys], changed: false };
    if (base.selectedEntryKeys.length >= 2) return { error: "You can select up to two saved contexts for comparison." };
    return { entries: [...base.entries], selectedEntryKeys: [...base.selectedEntryKeys, operation.key], changed: true };
  }
  const selectedEntryKeys = base.selectedEntryKeys.filter((key) => key !== operation.key);
  return { entries: [...base.entries], selectedEntryKeys, changed: selectedEntryKeys.length !== base.selectedEntryKeys.length };
}

function operationSatisfied(envelope: WatchlistV3Envelope, operation: WatchlistV3Operation) {
  if (operation.type === "put-entry") return envelope.entries.some((entry) => entry.key === operation.entry.key);
  if (operation.type === "remove-entry") return !envelope.entries.some((entry) => entry.key === operation.key) && !envelope.selectedEntryKeys.includes(operation.key);
  if (operation.type === "select-entry") return envelope.selectedEntryKeys.includes(operation.key);
  return !envelope.selectedEntryKeys.includes(operation.key);
}

type LocksNavigator = Navigator & { locks?: { request<T>(name: string, callback: () => Promise<T>): Promise<T> } };
export function browserWatchlistV3LockCoordinator(): WatchlistV3LockCoordinator {
  const locks = typeof navigator === "undefined" ? undefined : (navigator as LocksNavigator).locks;
  return { supported: Boolean(locks?.request), runExclusive: <T,>(task: () => Promise<T>) => {
    if (!locks?.request) return Promise.reject(new Error("Web Locks unavailable"));
    return locks.request("messi-watchlist-v3", task);
  } };
}
export function createMemoryWatchlistV3LockCoordinator(): WatchlistV3LockCoordinator {
  let queue: Promise<void> = Promise.resolve();
  return { supported: true, runExclusive: async <T,>(task: () => Promise<T>) => { const previous = queue; let release: () => void = () => undefined; queue = new Promise<void>((resolve) => { release = resolve; }); await previous; try { return await task(); } finally { release(); } } };
}

/**
 * Rebases an idempotent operation on the latest strict persisted envelope. Production uses
 * Web Locks; tests inject an explicit coordinator so there is no unsafe runtime fallback.
 */
export async function commitWatchlistV3Operation(storage: StorageLike, observed: WatchlistV3Envelope, operation: WatchlistV3Operation, coordinator: WatchlistV3LockCoordinator, now: () => string = () => new Date().toISOString()): Promise<WatchlistV3MutationResult> {
  if (!coordinator.supported) return { ok: false, envelope: observed, error: "This browser does not support Web Locks. Watchlist V3 is read-only to prevent cross-tab data loss.", readonly: true };
  const mutate = async (): Promise<WatchlistV3MutationResult> => {
    let lastValid = observed;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      let raw: string | null;
      try { raw = storage.getItem(WATCHLIST_V3_KEY); } catch { return { ok: false, envelope: lastValid, error: "Browser storage is unavailable.", readonly: true }; }
      if (raw === null) return { ok: false, envelope: lastValid, error: "Watchlist storage was removed in another tab. Reload before making changes.", readonly: true };
      const latest = parseWatchlistV3(raw);
      if (!latest) return { ok: false, envelope: lastValid, error: "Saved Watchlist V3 data is corrupt. It was left unchanged.", readonly: true };
      lastValid = latest;
      const applied = applyOperation(latest, operation);
      if ("error" in applied) return { ok: false, envelope: latest, error: applied.error, readonly: false };
      if (!applied.changed && operationSatisfied(latest, operation)) return { ok: true, envelope: latest, changed: false };
      const candidate = watchlistV3EnvelopeSchema.parse({ ...latest, revision: envelopeRevision(latest) + 1, entries: applied.entries, selectedEntryKeys: applied.selectedEntryKeys, updatedAt: now() });
      try { storage.setItem(WATCHLIST_V3_KEY, JSON.stringify(candidate)); } catch { return { ok: false, envelope: latest, error: "The Watchlist change could not be saved. Your previous list is unchanged.", readonly: false }; }
      let verificationRaw: string | null;
      try { verificationRaw = storage.getItem(WATCHLIST_V3_KEY); } catch { return { ok: false, envelope: latest, error: "The saved Watchlist could not be verified.", readonly: true }; }
      const verified = parseWatchlistV3(verificationRaw);
      if (!verified) return { ok: false, envelope: latest, error: "Watchlist storage became corrupt while saving. No further writes will be attempted.", readonly: true };
      if (operationSatisfied(verified, operation)) return { ok: true, envelope: verified, changed: true };
      lastValid = verified;
    }
    return { ok: false, envelope: lastValid, error: "The Watchlist changed in another tab. Please try again.", readonly: false };
  };
  try { return await coordinator.runExclusive(mutate); }
  catch { return { ok: false, envelope: observed, error: "The Watchlist lock could not be acquired. No change was saved.", readonly: true }; }
}

/** Kept for low-level compatibility tests; new UI mutations must use operations above. */
export function persistWatchlistV3(storage: StorageLike, previous: WatchlistV3Envelope, candidate: WatchlistV3Envelope): { ok: true; envelope: WatchlistV3Envelope } | { ok: false; envelope: WatchlistV3Envelope; error: string } {
  const parsed = watchlistV3EnvelopeSchema.safeParse(candidate);
  if (!parsed.success) return { ok: false, envelope: previous, error: "The Watchlist change was invalid and was not saved." };
  let raw: string | null; try { raw = storage.getItem(WATCHLIST_V3_KEY); } catch { return { ok: false, envelope: previous, error: "Browser storage is unavailable." }; }
  if (!parseWatchlistV3(raw)) return { ok: false, envelope: previous, error: "Saved Watchlist V3 data is corrupt. It was left unchanged." };
  try { storage.setItem(WATCHLIST_V3_KEY, JSON.stringify(parsed.data)); return { ok: true, envelope: structuredClone(parsed.data) }; }
  catch { return { ok: false, envelope: previous, error: "The Watchlist change could not be saved. Your previous list is unchanged." }; }
}
