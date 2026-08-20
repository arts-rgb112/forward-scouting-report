import { useEffect, useMemo, useState } from "react";
import { fetchWatchlistDataQuality } from "../api/dataQualityApi";
import type { MessiApiConfig } from "../api/env";
import { watchlistQualityDisplays, type QualityDisplay } from "./dataQualityViewModel";
import { bridgeLegacyV3Entry, type LegacyWatchlistResolution } from "./useLegacyWatchlistResolution";
import type { LegacyV3Entry } from "./watchlistV3Contracts";

/** Only exact current-resolved legacy entries reach the legacy quality endpoint. */
export function useLegacyWatchlistQuality(config: MessiApiConfig | undefined, entries: readonly LegacyV3Entry[], resolutions: Readonly<Record<string, LegacyWatchlistResolution>>, active: boolean) {
  const currentEntries = useMemo(() => entries.filter((entry) => resolutions[entry.key]?.status === "current").map(bridgeLegacyV3Entry), [entries, resolutions]);
  const key = currentEntries.map((entry) => entry.key).join("\u0000"); const [quality, setQuality] = useState<Record<string, QualityDisplay>>({});
  useEffect(() => {
    const controller = new AbortController();
    if (!active || !config || !currentEntries.length) { setQuality({}); return () => controller.abort(); }
    setQuality(Object.fromEntries(currentEntries.map((entry) => [entry.key, { kind: "pending" } satisfies QualityDisplay])));
    void fetchWatchlistDataQuality(config, currentEntries, controller.signal).then((results) => { if (!controller.signal.aborted) setQuality(watchlistQualityDisplays(currentEntries, results)); }).catch(() => { if (!controller.signal.aborted) setQuality(Object.fromEntries(currentEntries.map((entry) => [entry.key, { kind: "unknown", cause: "network" } satisfies QualityDisplay]))); });
    return () => controller.abort();
  }, [active, config, key]);
  return quality;
}
