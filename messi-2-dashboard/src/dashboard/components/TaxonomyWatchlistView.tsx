import { useEffect, useRef, type RefObject } from "react";

import { DUEL_PRESS_METRIC_KEYS } from "../../api/duelPressTypes";
import { duelPressMetricConfig } from "../duelPressRegistry";
import { metricConfig } from "../scoutingConfig";
import { legacyMetricKeys } from "../types";
import type { QualityDisplay } from "../dataQualityViewModel";
import type { DuelWatchlistResolution } from "../duelPressWatchlistResolver";
import type { LegacyWatchlistResolution } from "../useLegacyWatchlistResolution";
import type { DuelPressV3Entry, LegacyV3Entry, WatchlistV3Entry } from "../watchlistV3Contracts";
import { duelWatchlistPresentationRow, legacyWatchlistPresentationRow, watchlistV3ContextLabel } from "../watchlistPresentationAdapter";
import { LeaderboardPlayerCardList, LeaderboardPlayerTable, type WatchPresentation } from "./LeaderboardPresentation";

type RemoveResult = boolean | void | Promise<boolean | void>;
type Props = { entries: readonly WatchlistV3Entry[]; resolutions: Readonly<Record<string, DuelWatchlistResolution>>; legacyResolutions?: Readonly<Record<string, LegacyWatchlistResolution>>; legacyQuality?: Readonly<Record<string, QualityDisplay>>; preferences: Readonly<Record<string, "saved" | "current">>; fallbackFocusRef: RefObject<HTMLElement | null>; onPreference(key: string, value: "saved" | "current"): void; onRemove(key: string): RemoveResult; onRetry(): void };
type Surface = "table" | "mobile";
type FocusTarget = { removedKey: string; surface: Surface; orderedKeys: string[]; taxonomy: WatchlistV3Entry["taxonomy"] };
const staticSort = { key: "savedAt", direction: "desc" as const };

export function TaxonomyWatchlistView(props: Props) {
  const legacy = props.entries.filter((entry): entry is LegacyV3Entry => entry.taxonomy === "legacy-v1");
  const duel = props.entries.filter((entry): entry is DuelPressV3Entry => entry.taxonomy === "duel-press-v1");
  const buttons = useRef(new Map<string, Partial<Record<Surface, HTMLButtonElement>>>()); const pendingFocus = useRef<FocusTarget | null>(null);
  const legacyHeading = useRef<HTMLHeadingElement>(null); const duelHeading = useRef<HTMLHeadingElement>(null);
  const register = (key: string, surface: Surface, element: HTMLButtonElement | null) => {
    const refs = buttons.current.get(key) ?? {};
    if (element) { refs[surface] = element; buttons.current.set(key, refs); }
    else { delete refs[surface]; if (!refs.table && !refs.mobile) buttons.current.delete(key); }
  };
  const remove = async (entry: WatchlistV3Entry, surface: Surface) => {
    pendingFocus.current = { removedKey: entry.key, surface, orderedKeys: props.entries.map((candidate) => candidate.key), taxonomy: entry.taxonomy };
    const result = await props.onRemove(entry.key);
    if (result === false) { pendingFocus.current = null; return; }
    if (props.entries.length === 1) { pendingFocus.current = null; props.fallbackFocusRef.current?.focus(); }
  };
  useEffect(() => {
    const pending = pendingFocus.current; if (!pending || props.entries.some((entry) => entry.key === pending.removedKey)) return;
    pendingFocus.current = null; const removedIndex = pending.orderedKeys.indexOf(pending.removedKey); const remaining = new Set(props.entries.map((entry) => entry.key));
    const next = pending.orderedKeys.slice(removedIndex + 1).find((key) => remaining.has(key)); const previous = [...pending.orderedKeys.slice(0, removedIndex)].reverse().find((key) => remaining.has(key));
    const target = (next && buttons.current.get(next)?.[pending.surface]) || (previous && buttons.current.get(previous)?.[pending.surface]);
    if (target) { target.focus(); return; }
    const heading = pending.taxonomy === "legacy-v1" ? legacyHeading.current : duelHeading.current;
    if (heading) { heading.focus(); return; }
    props.fallbackFocusRef.current?.focus();
  }, [props.entries]);
  const watch = <E extends WatchlistV3Entry>(): WatchPresentation<E> => ({
    available: true, isWatched: () => true, onToggle: (entry) => remove(entry, "table"),
    accessibleLabel: (entry) => `Remove ${entry.snapshot.name} ${watchlistV3ContextLabel(entry)} from watchlist`, visibleLabel: () => "Remove",
    buttonRef: (entry, surface, element) => register(entry.key, surface, element),
  });
  const legacyWatch = watch<LegacyV3Entry>(); const duelWatch = watch<DuelPressV3Entry>();

  return <div className="space-y-8">
    {legacy.length > 0 && <section aria-labelledby="legacy-watchlist-heading" className="space-y-2"><div><h2 ref={legacyHeading} tabIndex={-1} id="legacy-watchlist-heading" className="text-sm font-black uppercase tracking-wider">Legacy M.E.S.S.I. taxonomy</h2><p className="text-xs text-zinc-500">Original Aerial and Ground duel metrics are preserved.</p></div><LeaderboardPlayerCardList players={legacy} metricKeys={legacyMetricKeys} metricRegistry={metricConfig} sort={staticSort} rowAdapter={(entry) => legacyWatchlistPresentationRow(entry, props.legacyResolutions?.[entry.key], props.legacyQuality?.[entry.key], { preference: props.preferences[entry.key], onPreference: props.onPreference })} caption="Saved legacy taxonomy contexts" density="watchlist" watch={{ ...legacyWatch, onToggle: (entry) => remove(entry, "mobile") }} /><LeaderboardPlayerTable players={legacy} metricKeys={legacyMetricKeys} metricRegistry={metricConfig} sort={staticSort} rowAdapter={(entry) => legacyWatchlistPresentationRow(entry, props.legacyResolutions?.[entry.key], props.legacyQuality?.[entry.key], { preference: props.preferences[entry.key], onPreference: props.onPreference })} caption="Saved legacy taxonomy contexts" density="watchlist" watch={legacyWatch} /></section>}
    {duel.length > 0 && <section aria-labelledby="duel-watchlist-heading" className="space-y-2"><div className="flex flex-wrap items-center justify-between gap-2"><div><h2 ref={duelHeading} tabIndex={-1} id="duel-watchlist-heading" className="text-sm font-black uppercase tracking-wider">Duel / Press taxonomy</h2><p className="text-xs text-zinc-500">Combined Duel and Forward Press use duel-press-v1 only.</p></div><button type="button" onClick={props.onRetry} className="min-h-11 rounded border border-white/10 px-3 text-xs">Refresh visible contexts</button></div><LeaderboardPlayerCardList players={duel} metricKeys={DUEL_PRESS_METRIC_KEYS} metricRegistry={duelPressMetricConfig} sort={staticSort} rowAdapter={(entry) => duelWatchlistPresentationRow(entry, props.resolutions[entry.key], { preference: props.preferences[entry.key], onPreference: props.onPreference })} caption="Saved duel and press taxonomy contexts" density="watchlist" watch={{ ...duelWatch, onToggle: (entry) => remove(entry, "mobile") }} /><LeaderboardPlayerTable players={duel} metricKeys={DUEL_PRESS_METRIC_KEYS} metricRegistry={duelPressMetricConfig} sort={staticSort} rowAdapter={(entry) => duelWatchlistPresentationRow(entry, props.resolutions[entry.key], { preference: props.preferences[entry.key], onPreference: props.onPreference })} caption="Saved duel and press taxonomy contexts" density="watchlist" watch={duelWatch} /></section>}
  </div>;
}
