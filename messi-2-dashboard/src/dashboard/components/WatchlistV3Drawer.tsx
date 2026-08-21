import { useEffect, useRef } from "react";

import { legacyCompareHref, legacyDetailHref, resolveLegacyOrInternalHref, type LegacyCompareEntry } from "../../navigation/legacyHandoff";
import { datasetHref } from "../datasetRoute";
import { duelPressDetailHref } from "../duelPressRoute";
import type { WatchlistV3Entry } from "../watchlistV3Contracts";

type Props = { open: boolean; entries: readonly WatchlistV3Entry[]; selectedKeys: readonly string[]; feedback: string; onClose(): void; onRemove(key: string): void; onToggleSelection(key: string): void };
const context = (entry: WatchlistV3Entry) => entry.context.mode === "league" ? `${entry.context.season} · ${entry.context.scope} leagues` : `${entry.context.season} · Europe ${entry.context.competition.toUpperCase()}`;
const datasetFor = (entry: WatchlistV3Entry) => entry.context.mode === "league" ? { season: entry.context.season, mode: "league" as const, scope: entry.context.scope, competition: "all" as const } : { season: entry.context.season, mode: "europe" as const, scope: 8 as const, competition: entry.context.competition };
function detailHref(entry: WatchlistV3Entry) {
  const dataset = datasetFor(entry);
  const player = entry.taxonomy === "legacy-v1" ? { name: entry.snapshot.name, clubName: entry.snapshot.clubName } : { name: entry.snapshot.name, clubName: entry.snapshot.club.name };
  const internal = entry.taxonomy === "legacy-v1" ? datasetHref(`/players/${entry.playerId}`, dataset) : duelPressDetailHref(entry.playerId, dataset);
  return resolveLegacyOrInternalHref(legacyDetailHref(entry.playerId, player, dataset), internal);
}
function compareEntry(entry: WatchlistV3Entry): LegacyCompareEntry {
  const snapshot = entry.taxonomy === "legacy-v1" ? { name: entry.snapshot.name, clubName: entry.snapshot.clubName } : { name: entry.snapshot.name, clubName: entry.snapshot.club.name };
  return { playerId: entry.playerId, snapshot, context: entry.context };
}

export function WatchlistV3Drawer({ open, entries, selectedKeys, feedback, onClose, onRemove, onToggleSelection }: Props) {
  const panel = useRef<HTMLElement>(null); const close = useRef<HTMLButtonElement>(null); const restore = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!open) return; restore.current = document.activeElement as HTMLElement; close.current?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); onClose(); return; }
      if (event.key !== "Tab" || !panel.current) return;
      const controls = [...panel.current.querySelectorAll<HTMLElement>('button:not([disabled]), select:not([disabled]), [href], [tabindex]:not([tabindex="-1"])')]; if (!controls.length) return;
      const first = controls[0]; const last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    addEventListener("keydown", keydown); return () => { removeEventListener("keydown", keydown); restore.current?.focus(); };
  }, [onClose, open]);
  if (!open) return null;
  const selectedEntries = selectedKeys.map((key) => entries.find((entry) => entry.key === key)).filter((entry): entry is WatchlistV3Entry => Boolean(entry));
  const compareHref = selectedEntries.length === 2 ? resolveLegacyOrInternalHref(legacyCompareHref(selectedEntries.map(compareEntry)), "/compare") : null;
  return <div className="fixed inset-0 z-[80] bg-black/70" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><aside ref={panel} role="dialog" aria-modal="true" aria-labelledby="watchlist-v3-title" className="ml-auto flex h-full w-full max-w-xl flex-col bg-[#0d1112] text-zinc-100 shadow-2xl"><header className="flex items-center justify-between border-b border-white/10 p-4"><div><h2 id="watchlist-v3-title" className="font-black">Manage saved contexts</h2><p className="text-xs text-zinc-500">{entries.length} exact contexts · {selectedKeys.length}/2 selected</p></div><button ref={close} type="button" onClick={onClose} aria-label="Close watchlist manager" className="min-h-11 min-w-11 rounded border border-white/10">×</button></header><p role="status" aria-live="polite" className="min-h-8 px-4 py-2 text-xs text-zinc-400">{feedback}</p><div className="flex-1 overflow-y-auto p-4"><ul className="space-y-2">{entries.map((entry) => { const selected = selectedKeys.includes(entry.key); return <li key={entry.key} className="rounded border border-white/10 p-3"><div className="flex items-start justify-between gap-2"><div><b className="text-sm">{entry.snapshot.name}</b><p className="text-xs text-zinc-500">{entry.taxonomy === "duel-press-v1" ? "Duel / Press" : "Legacy"} · {context(entry)}</p><p className="text-[10px] text-zinc-600">Saved {new Date(entry.savedAt).toLocaleString()}</p></div>{selected && <span className="rounded bg-lime-300/10 px-2 py-1 text-[10px] text-lime-200">Position {selectedKeys.indexOf(entry.key) + 1}</span>}</div><div className="mt-3 grid grid-cols-3 gap-2"><a href={detailHref(entry)} className="inline-flex min-h-11 items-center justify-center rounded border border-white/10 px-2 text-xs">View detail</a><button type="button" aria-pressed={selected} onClick={() => onToggleSelection(entry.key)} className="min-h-11 rounded border border-white/10 px-2 text-xs">{selected ? "Selected for compare" : "Select for compare"}</button><button type="button" onClick={() => onRemove(entry.key)} className="min-h-11 rounded border border-white/10 px-2 text-xs">Remove</button></div></li>; })}</ul>{!entries.length && <p className="rounded border border-dashed border-white/15 p-5 text-sm text-zinc-400">No saved contexts yet.</p>}</div><footer className="border-t border-white/10 p-4">{compareHref ? <a href={compareHref} className="inline-flex min-h-11 w-full items-center justify-center rounded bg-lime-300 px-3 text-xs font-black text-black">Compare selected</a> : <span aria-disabled="true" className="inline-flex min-h-11 w-full items-center justify-center rounded bg-white/10 px-3 text-xs font-black text-zinc-500">{selectedKeys.length}/2 selected</span>}</footer></aside></div>;
}
