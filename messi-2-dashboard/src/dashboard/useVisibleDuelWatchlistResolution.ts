import { useEffect, useRef, useState } from "react";
import type { MessiApiConfig } from "../api/env";
import type { DuelPressV3Entry } from "./watchlistV3Contracts";
import { resolveDuelWatchlistEntryV2, resolveVisibleDuelWatchlistEntries, type DuelWatchlistResolution } from "./duelPressWatchlistResolver";

export function useVisibleDuelWatchlistResolution(config: MessiApiConfig | undefined, entries: readonly DuelPressV3Entry[], active: boolean, retryEpoch = 0, useV2 = false) {
  const [results, setResults] = useState<Record<string, DuelWatchlistResolution>>({}); const generation = useRef(0);
  const key = entries.map((entry) => entry.key).join("\u0000");
  useEffect(() => {
    const id = ++generation.current; const controller = new AbortController();
    if (!active || !entries.length) { setResults({}); return () => controller.abort(); }
    setResults(Object.fromEntries(entries.map((entry) => [entry.key, { status: "pending" } satisfies DuelWatchlistResolution])));
    if (!config) { setResults(Object.fromEntries(entries.map((entry) => [entry.key, { status: "offline" } satisfies DuelWatchlistResolution]))); return () => controller.abort(); }
    void resolveVisibleDuelWatchlistEntries(config, entries, controller.signal, (entryKey, result) => {
      if (!controller.signal.aborted && id === generation.current) setResults((current) => ({ ...current, [entryKey]: result }));
    }, useV2 ? resolveDuelWatchlistEntryV2 : undefined);
    return () => controller.abort();
  }, [active, config, key, retryEpoch, useV2]); // entries are represented by their immutable exact keys
  return results;
}
