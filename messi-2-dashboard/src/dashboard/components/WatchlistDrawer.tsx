import { useEffect, useRef } from "react";

import { datasetHref, leaderboardHref } from "../datasetRoute";
import type { DatasetRouteState } from "../types";
import type { WatchlistEntry } from "../watchlistStorage";
import { enabledLegacyHref, legacyCompareHref, legacyDetailHref } from "../../navigation/legacyHandoff";
import { AssetImage } from "./AssetImage";

type Props = {
  open: boolean;
  entries: readonly WatchlistEntry[];
  selectedKeys: readonly string[];
  onClose(): void;
  onRemove(key: string): void;
  onToggleSelection(key: string): void;
  feedback: string;
};

function stateFromEntry(entry: WatchlistEntry): DatasetRouteState {
  return entry.context.mode === "league"
    ? { season: entry.context.season, mode: "league", scope: entry.context.scope ?? 8, competition: "all" }
    : { season: entry.context.season, mode: "europe", scope: 8, competition: entry.context.competition ?? "all" };
}
function contextLabel(entry: WatchlistEntry) {
  return entry.context.mode === "league"
    ? `${entry.context.season} · League · ${entry.context.scope} leagues`
    : `${entry.context.season} · Europe · ${(entry.context.competition ?? "all").toUpperCase()}`;
}

export function WatchlistDrawer({ open, entries, selectedKeys, onClose, onRemove, onToggleSelection, feedback }: Props) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!open) return;
    previouslyFocused.current = document.activeElement as HTMLElement;
    closeRef.current?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); onClose(); }
      if (event.key !== "Tab") return;
      const dialog = document.getElementById("watchlist-drawer");
      const focusable = dialog?.querySelectorAll<HTMLElement>('a[href], button:not([disabled])') ?? [];
      if (!focusable.length) return;
      const first = focusable[0]; const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", keydown);
    return () => { document.removeEventListener("keydown", keydown); previouslyFocused.current?.focus?.(); };
  }, [onClose, open]);
  if (!open) return null;
  // Preserve the user's selection order: it is Streamlit's left/right order.
  const entriesByKey = new Map(entries.map((entry) => [entry.key, entry]));
  const selectedEntries = selectedKeys.map((key) => entriesByKey.get(key)).filter((entry): entry is WatchlistEntry => Boolean(entry));
  const legacyCompare = selectedEntries.length === 2 ? legacyCompareHref(selectedEntries) : null;
  const compareHref = legacyCompare ? enabledLegacyHref(legacyCompare) ?? "/compare" : null;
  return <div className="fixed inset-0 z-[80] bg-black/60" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <aside id="watchlist-drawer" role="dialog" aria-modal="true" aria-labelledby="watchlist-title" className="ml-auto flex h-full w-full max-w-md flex-col border-l border-white/10 bg-[#101415] shadow-2xl">
      <header className="flex min-h-16 items-center justify-between border-b border-white/10 px-4"><div><h2 id="watchlist-title" className="font-black">Manage / Compare watchlist</h2><p className="text-xs text-zinc-500">Manage saved contexts and select two for comparison. Use Watchlist to browse them.</p></div><button ref={closeRef} type="button" onClick={onClose} className="min-h-11 min-w-11 rounded border border-white/10 text-sm" aria-label="Close watchlist manager">Close</button></header>
      <p aria-live="polite" className="min-h-8 px-4 pt-2 text-xs text-lime-200">{feedback}</p>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
        {!entries.length && <p className="rounded border border-dashed border-white/15 p-4 text-sm text-zinc-400">No saved players yet. Watch a player from any leaderboard context to keep its snapshot here.</p>}
        <ul className="space-y-3">{entries.map((entry) => {
          const selected = selectedKeys.includes(entry.key); const state = stateFromEntry(entry);
          const detailHref = enabledLegacyHref(legacyDetailHref(entry.playerId, { name: entry.snapshot.name, clubName: entry.snapshot.clubName }, state) ?? "") ?? datasetHref(`/players/${entry.playerId}`, state);
          return <li key={entry.key} className="rounded-lg border border-white/10 bg-black/20 p-3"><div className="flex gap-3"><AssetImage src={entry.snapshot.face ?? null} alt="" kind="face" fallbackLabel={entry.snapshot.name} width={44} height={44} className="h-11 w-11 rounded object-cover" /><div className="min-w-0 flex-1"><b className="block truncate text-sm">{entry.snapshot.name}</b><p className="truncate text-xs text-zinc-400">{entry.snapshot.position} · {entry.snapshot.clubName}</p><span className="mt-2 inline-flex rounded border border-lime-300/25 bg-lime-300/10 px-2 py-1 text-[10px] font-bold text-lime-100">{contextLabel(entry)}</span></div></div><div className="mt-3 grid grid-cols-2 gap-2"><button type="button" onClick={() => onToggleSelection(entry.key)} aria-pressed={selected} className="min-h-11 rounded border border-white/10 px-2 text-xs">{selected ? "Selected for compare" : "Select for compare"}</button><button type="button" onClick={() => onRemove(entry.key)} className="min-h-11 rounded border border-white/10 px-2 text-xs text-zinc-300">Remove</button><a href={detailHref} className="inline-flex min-h-11 items-center justify-center rounded border border-white/10 px-2 text-xs">View detail</a><a href={leaderboardHref(state)} className="inline-flex min-h-11 items-center justify-center rounded border border-white/10 px-2 text-xs">Open source leaderboard</a></div></li>;
        })}</ul>
      </div>
      <footer className="border-t border-white/10 p-4"><p className="mb-2 text-xs text-zinc-500">{selectedEntries.length}/2 selected. Select two saved contexts to open the comparison page.</p>{compareHref ? <a href={compareHref} className="inline-flex min-h-11 w-full items-center justify-center rounded bg-lime-300 px-3 text-xs font-black text-black">Open comparison page</a> : <span aria-disabled="true" className="inline-flex min-h-11 w-full items-center justify-center rounded bg-white/10 px-3 text-xs font-black text-zinc-500">Open comparison page</span>}</footer>
    </aside>
  </div>;
}
