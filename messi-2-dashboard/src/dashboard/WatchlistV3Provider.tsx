import { createContext, useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { DuelPressPlayerCore, DuelPressModeContext } from "../api/duelPressTypes";
import type { Player } from "./types";
import { contextFromDataset, entryFromPlayer } from "./watchlistStorage";
import { duelPressEntry, legacyV3Entry } from "./watchlistStorageV3";
import { WATCHLIST_V3_KEY, watchlistV3Key, type WatchlistV3Entry, type WatchlistV3Envelope } from "./watchlistV3Contracts";
import { bootWatchlistV3, browserWatchlistV3LockCoordinator, commitWatchlistV3Operation, emptyWatchlistV3, envelopeRevision, parseWatchlistV3StorageEvent, type WatchlistV3LockCoordinator, type WatchlistV3Operation } from "./watchlistV3Repository";

export const WATCHLIST_V3_ENABLED = import.meta.env.VITE_WATCHLIST_V3_ENABLED === "true";

export type WatchlistV3ViewMode = "leaderboard" | "watchlist";
export type WatchlistV3ContextValue = {
  envelope: WatchlistV3Envelope; entries: readonly WatchlistV3Entry[]; watchCount: number; selectedEntries: readonly WatchlistV3Entry[];
  writable: boolean; feedback: string; viewMode: WatchlistV3ViewMode; drawerOpen: boolean; watchlistPage: number;
  displayPreference: Readonly<Record<string, "saved" | "current">>;
  isWatched(taxonomy: WatchlistV3Entry["taxonomy"], playerId: number, context: DuelPressModeContext): boolean;
  toggleDuel(player: DuelPressPlayerCore, context: DuelPressModeContext): Promise<boolean>; toggleLegacy(player: Player, context: DuelPressModeContext): Promise<boolean>;
  remove(key: string): Promise<boolean>; toggleSelection(key: string): Promise<boolean>;
  setViewMode(mode: WatchlistV3ViewMode): void; setDrawerOpen(open: boolean): void; setWatchlistPage(page: number): void;
  setDisplayPreference(key: string, preference: "saved" | "current"): void; announce(message: string): void;
};

export const WatchlistV3Context = createContext<WatchlistV3ContextValue | null>(null);

export function WatchlistV3Provider({ children, lockCoordinator }: { children: React.ReactNode; lockCoordinator?: WatchlistV3LockCoordinator }) {
  const coordinator = useMemo(() => lockCoordinator ?? browserWatchlistV3LockCoordinator(), [lockCoordinator]);
  const [repository, setRepository] = useState(() => {
    const booted = WATCHLIST_V3_ENABLED && typeof window !== "undefined" ? bootWatchlistV3(window.localStorage) : { envelope: emptyWatchlistV3(), writable: false, error: null };
    return WATCHLIST_V3_ENABLED && booted.writable && !coordinator.supported ? { ...booted, writable: false, error: "This browser does not support Web Locks. Watchlist V3 is read-only to prevent cross-tab data loss." } : booted;
  });
  const repositoryRef = useRef(repository); repositoryRef.current = repository;
  const [feedback, setFeedback] = useState(repository.error ?? "");
  const [viewMode, setViewMode] = useState<WatchlistV3ViewMode>("leaderboard");
  const [drawerOpen, setDrawerOpen] = useState(false); const [watchlistPage, setWatchlistPage] = useState(1);
  const [displayPreference, setDisplayPreferences] = useState<Record<string, "saved" | "current">>({});

  const commit = useCallback(async (operation: WatchlistV3Operation, success: string) => {
    const current = repositoryRef.current;
    if (!current.writable || typeof window === "undefined") { setFeedback(current.error ?? "Watchlist storage is read-only."); return false; }
    const result = await commitWatchlistV3Operation(window.localStorage, current.envelope, operation, coordinator);
    if (!result.ok) {
      setRepository((state) => ({ envelope: result.envelope, writable: result.readonly ? false : state.writable, error: result.readonly ? result.error : state.error })); setFeedback(result.error); return false;
    }
    setRepository({ envelope: result.envelope, writable: true, error: null }); setFeedback(success); return true;
  }, [coordinator]);

  const remove = useCallback((key: string) => commit({ type: "remove-entry", key }, "Watchlist entry removed."), [commit]);
  const toggleSelection = useCallback((key: string) => {
    const selected = repositoryRef.current.envelope.selectedEntryKeys.includes(key);
    return commit({ type: selected ? "unselect-entry" : "select-entry", key }, selected ? "Comparison selection removed." : "Saved context selected for comparison.");
  }, [commit]);
  const toggleEntry = useCallback((entry: WatchlistV3Entry) => {
    const present = repositoryRef.current.envelope.entries.some((saved) => saved.key === entry.key);
    return present ? remove(entry.key) : commit({ type: "put-entry", entry }, `${entry.snapshot.name} saved with this exact leaderboard context.`);
  }, [commit, remove]);
  const toggleDuel = useCallback((player: DuelPressPlayerCore, context: DuelPressModeContext) => toggleEntry(duelPressEntry(player, context)), [toggleEntry]);
  const toggleLegacy = useCallback((player: Player, context: DuelPressModeContext) => {
    const legacyContext = context.mode === "league" ? { season: context.season, mode: "league" as const, scope: context.scope, competition: null } : { season: context.season, mode: "europe" as const, scope: null, competition: context.competition };
    const snapshot = entryFromPlayer(player, legacyContext).snapshot;
    return toggleEntry(legacyV3Entry(player.id, snapshot, context));
  }, [toggleEntry]);
  const isWatched = useCallback((taxonomy: WatchlistV3Entry["taxonomy"], playerId: number, context: DuelPressModeContext) => repository.envelope.entries.some((entry) => entry.key === watchlistV3Key(taxonomy, playerId, context)), [repository.envelope.entries]);

  useEffect(() => {
    if (!WATCHLIST_V3_ENABLED) return;
    const sync = (event: StorageEvent) => {
      const parsed = parseWatchlistV3StorageEvent(event.key, event.newValue);
      if (parsed.kind === "unrelated") return;
      if (parsed.kind === "invalid" || parsed.kind === "deleted") {
        const error = parsed.kind === "invalid" ? "Saved Watchlist V3 data became corrupt in another tab. It was left unchanged." : "Watchlist storage was removed in another tab. Reload before making changes.";
        setRepository((current) => ({ ...current, writable: false, error })); setFeedback(error); return;
      }
      let persisted = parsed.envelope;
      try {
        const currentRaw = window.localStorage.getItem(WATCHLIST_V3_KEY); const currentParsed = parseWatchlistV3StorageEvent(WATCHLIST_V3_KEY, currentRaw);
        if (currentParsed.kind === "invalid" || currentParsed.kind === "deleted") { const error = "Saved Watchlist V3 data became invalid while synchronizing tabs. It was left unchanged."; setRepository((current) => ({ ...current, writable: false, error })); setFeedback(error); return; }
        if (currentParsed.kind === "valid") persisted = currentParsed.envelope;
      } catch { const error = "Browser storage is unavailable while synchronizing the Watchlist."; setRepository((current) => ({ ...current, writable: false, error })); setFeedback(error); return; }
      const current = repositoryRef.current; const incomingRevision = envelopeRevision(persisted); const currentRevision = envelopeRevision(current.envelope);
      if (incomingRevision < currentRevision || incomingRevision === currentRevision && JSON.stringify(persisted) !== JSON.stringify(current.envelope)) { const error = "Watchlist storage conflicted with this tab. Editing is disabled until reload."; setRepository({ ...current, writable: false, error }); setFeedback(error); return; }
      if (incomingRevision === currentRevision) return;
      setRepository({ envelope: persisted, writable: coordinator.supported, error: coordinator.supported ? null : "This browser does not support Web Locks. Watchlist V3 is read-only to prevent cross-tab data loss." }); setFeedback("Watchlist updated in another tab.");
    };
    addEventListener("storage", sync); return () => removeEventListener("storage", sync);
  }, [coordinator.supported]);
  useEffect(() => {
    const totalPages = Math.max(1, Math.ceil(repository.envelope.entries.length / 50));
    if (watchlistPage > totalPages) setWatchlistPage(totalPages);
    const known = new Set(repository.envelope.entries.map((entry) => entry.key));
    setDisplayPreferences((current) => Object.fromEntries(Object.entries(current).filter(([key]) => known.has(key))));
  }, [repository.envelope.entries, watchlistPage]);

  const selectedEntries = useMemo(() => repository.envelope.selectedEntryKeys.map((key) => repository.envelope.entries.find((entry) => entry.key === key)).filter((entry): entry is WatchlistV3Entry => Boolean(entry)), [repository.envelope]);
  const value = useMemo<WatchlistV3ContextValue>(() => ({ envelope: repository.envelope, entries: repository.envelope.entries, watchCount: repository.envelope.entries.length, selectedEntries, writable: repository.writable, feedback, viewMode, drawerOpen, watchlistPage, displayPreference, isWatched, toggleDuel, toggleLegacy, remove, toggleSelection, setViewMode, setDrawerOpen, setWatchlistPage, setDisplayPreference: (key, preference) => { if (!repository.writable) { setFeedback(repository.error ?? "Watchlist V3 is read-only."); return; } setDisplayPreferences((current) => ({ ...current, [key]: preference })); }, announce: setFeedback }), [displayPreference, drawerOpen, feedback, isWatched, remove, repository, selectedEntries, toggleDuel, toggleLegacy, toggleSelection, viewMode, watchlistPage]);
  return <WatchlistV3Context.Provider value={value}>{children}</WatchlistV3Context.Provider>;
}
