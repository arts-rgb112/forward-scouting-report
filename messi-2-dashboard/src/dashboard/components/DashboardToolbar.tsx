import { useEffect, useId, useRef, useState } from "react";

import { datasetHref, positionFilterValues } from "../datasetRoute";
import type { AgeBand, DatasetRouteState, MinutesBand, Player, PositionFilterCapability } from "../types";
import { enabledLegacyHref, legacyDetailHref } from "../../navigation/legacyHandoff";
import { Icon } from "./Icon";

export type PositionFilter = { value: string; label: string };
export const positionFilters: readonly PositionFilter[] = [{ value: "ALL", label: "All positions" }, ...positionFilterValues.map((value) => ({ value, label: value }))];
const ageFilters: readonly { value: AgeBand; label: string }[] = [{ value: "all", label: "All ages" }, { value: "u23", label: "U23 (≤22)" }, { value: "23-25", label: "23–25" }, { value: "26-30", label: "26–30" }, { value: "31-plus", label: "31+" }];
const minutesFilters: readonly { value: MinutesBand; label: string }[] = [{ value: "all", label: "All minutes" }, { value: "200-499", label: "200–499" }, { value: "500-999", label: "500–999" }, { value: "1000-1499", label: "1,000–1,499" }, { value: "1500-1999", label: "1,500–1,999" }, { value: "2000-2999", label: "2,000–2,999" }, { value: "3000-plus", label: "3,000+" }];

type Props = {
  query: string; role: string; position?: string; ageBand?: AgeBand; minutesBand?: MinutesBand;
  positionCapability?: PositionFilterCapability; ageCapability?: PositionFilterCapability; minutesCapability?: PositionFilterCapability;
  watchOnly: boolean; watchCount: number; watchAvailable?: boolean; resultLabel?: string; hasFilters: boolean;
  players: readonly Player[]; dataset: DatasetRouteState;
  onQueryChange(value: string): void; onRoleChange(value: string): void; onPositionChange?(value: string): void;
  onAgeBandChange?(value: AgeBand): void; onMinutesBandChange?(value: MinutesBand): void;
  onWatchOnlyChange(value: boolean): void; onOpenWatchlist?(): void; viewMode?: "leaderboard" | "watchlist";
  onViewModeChange?(mode: "leaderboard" | "watchlist"): void; onReset(): void;
  /** Retained only to keep older embedding callers type-compatible; toolbar sorting is no longer rendered. */
  sort?: string; direction?: "asc" | "desc"; onSortChange?(value: never): void; onDirectionChange?(value: "asc" | "desc"): void;
};
const action = "inline-flex min-h-11 items-center justify-center rounded-md border px-3 text-[11px] font-bold outline-none focus-visible:ring-2 focus-visible:ring-[#8cff68] focus-visible:ring-offset-2 focus-visible:ring-offset-[#080b0c]";
const selectClass = "min-h-11 min-w-[9rem] rounded-md border border-white/10 bg-[#111516] px-3 text-[11px] font-bold text-zinc-300";
function capabilityMessage(capability: PositionFilterCapability, label: string) {
  return capability === "unknown" ? `Checking ${label} filter support.` : `${label} filters are unavailable from this server.`;
}

export function DashboardToolbar(props: Props) {
  const watchlistMode = props.viewMode === "watchlist";
  const listId = useId(); const [open, setOpen] = useState(false); const [active, setActive] = useState(-1); const [needle, setNeedle] = useState(props.query);
  const onQueryChangeRef = useRef(props.onQueryChange); onQueryChangeRef.current = props.onQueryChange;
  useEffect(() => { setNeedle(props.query); }, [props.query]);
  useEffect(() => { if (needle === props.query) return; const timer = window.setTimeout(() => { if (needle !== props.query) onQueryChangeRef.current(needle); }, 180); return () => window.clearTimeout(timer); }, [needle, props.query]);
  const candidates = needle.trim() ? props.players.filter((player) => `${player.name} ${player.club.name} ${player.league.name}`.toLocaleLowerCase().includes(needle.toLocaleLowerCase())).slice(0, 8) : [];
  const choose = (player: Player) => { const legacy = enabledLegacyHref(legacyDetailHref(player.id, { name: player.name, clubName: player.club.name }, props.dataset) ?? ""); window.location.assign(legacy || datasetHref(`/players/${player.id}`, props.dataset)); };
  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" && candidates.length) { event.preventDefault(); setOpen(true); setActive((index) => Math.min(index + 1, candidates.length - 1)); }
    else if (event.key === "ArrowUp" && candidates.length) { event.preventDefault(); setOpen(true); setActive((index) => Math.max(index - 1, 0)); }
    else if (event.key === "Enter" && active >= 0 && candidates[active]) { event.preventDefault(); choose(candidates[active]); }
    else if (event.key === "Escape") { setOpen(false); setActive(-1); }
  };
  const positionCapability = props.positionCapability ?? "unsupported"; const ageCapability = props.ageCapability ?? "unsupported"; const minutesCapability = props.minutesCapability ?? "unsupported";
  const positionSupported = positionCapability === "supported"; const ageSupported = ageCapability === "supported"; const minutesSupported = minutesCapability === "supported";
  const statusMessages = !watchlistMode ? [[positionCapability, "Position"], [ageCapability, "Age"], [minutesCapability, "Minutes played"]].filter(([capability]) => capability !== "supported") as [PositionFilterCapability, string][] : [];

  return <section aria-labelledby="player-search-heading" className="mb-5 space-y-3">
    <h2 id="player-search-heading" className="sr-only">{watchlistMode ? "Saved-context filters" : "Player search and filters"}</h2>
    <label className="relative mx-auto block w-full min-w-0"><span className="sr-only">{watchlistMode ? "Search saved contexts" : "Search players"}</span><Icon path="m21 21-4.35-4.35M19 11a8 8 0 1 1-16 0 0 1 16 0Z" className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500" /><input value={needle} onFocus={() => setOpen(true)} onChange={(event) => { setNeedle(event.target.value); setOpen(true); setActive(-1); }} onKeyDown={onKeyDown} role="combobox" aria-autocomplete="list" aria-haspopup="listbox" aria-controls={listId} aria-expanded={!watchlistMode && open && candidates.length > 0} aria-activedescendant={!watchlistMode && open && active >= 0 ? `${listId}-${active}` : undefined} placeholder={watchlistMode ? "Search saved player, club, or league" : "Search player, club, or league"} className="h-12 w-full rounded-md border border-white/10 bg-[#111516] pl-10 pr-20 text-sm outline-none placeholder:text-zinc-600 focus:border-[#8cff68]/50 focus:ring-2 focus:ring-[#8cff68]/10" />{needle && <button type="button" onClick={() => { setNeedle(""); props.onQueryChange(""); setActive(-1); }} className="absolute right-2 top-1/2 min-h-9 -translate-y-1/2 rounded px-2 text-[11px] text-zinc-400">Clear</button>}{!watchlistMode && open && candidates.length > 0 && <ul id={listId} role="listbox" aria-label="Player suggestions" className="absolute z-50 mt-1 max-h-80 w-full overflow-auto rounded-md border border-white/10 bg-[#101415] p-1 shadow-2xl">{candidates.map((player, index) => <li id={`${listId}-${index}`} role="option" aria-selected={index === active} key={player.id} onMouseDown={(event) => event.preventDefault()} onClick={() => choose(player)} className={`flex min-h-11 w-full cursor-pointer items-center justify-between rounded px-3 text-left text-xs ${index === active ? "bg-lime-300/10 text-lime-200" : "hover:bg-white/5"}`}><span className="font-bold">{player.name}</span><span className="text-zinc-500">{player.club.name} · {player.league.name} · {player.position}</span></li>)}</ul>}</label>
    <div className="flex min-h-11 flex-wrap items-center gap-2" aria-describedby={statusMessages.length ? "server-filter-status" : undefined}>
      <select aria-label="Role" value={props.role} onChange={(event) => props.onRoleChange(event.target.value)} className={selectClass}><option value="ALL">All roles</option><option value="Type A">Type A</option><option value="Type B">Type B</option></select>
      <select aria-label="Position" value={positionSupported || watchlistMode ? (props.position ?? "ALL") : "ALL"} onChange={(event) => props.onPositionChange?.(event.target.value)} className={selectClass}>{positionFilters.map((item) => <option key={item.value} value={item.value} disabled={item.value !== "ALL" && !positionSupported && !watchlistMode}>{item.label}</option>)}</select>
      <select aria-label="Age" value={ageSupported || watchlistMode ? (props.ageBand ?? "all") : "all"} onChange={(event) => props.onAgeBandChange?.(event.target.value as AgeBand)} className={selectClass}>{ageFilters.map((item) => <option key={item.value} value={item.value} disabled={item.value !== "all" && !ageSupported && !watchlistMode}>{item.label}</option>)}</select>
      <select aria-label="Minutes played" value={minutesSupported || watchlistMode ? (props.minutesBand ?? "all") : "all"} onChange={(event) => props.onMinutesBandChange?.(event.target.value as MinutesBand)} className={selectClass}>{minutesFilters.map((item) => <option key={item.value} value={item.value} disabled={item.value !== "all" && !minutesSupported && !watchlistMode}>{item.label}</option>)}</select>
      <button type="button" onClick={() => props.onViewModeChange?.(watchlistMode ? "leaderboard" : "watchlist")} aria-pressed={watchlistMode} className={`${action} ${watchlistMode ? "border-[#8cff68]/45 bg-[#8cff68]/10 text-[#a7ff5b]" : "border-white/10 bg-[#111516] text-zinc-300"}`}>Watchlist {props.watchCount}</button><button type="button" onClick={props.onOpenWatchlist} className={`${action} border-white/10 bg-[#111516] text-zinc-300`}>Manage / Compare</button>{props.resultLabel && <b className="ml-1 text-[11px] text-zinc-300">{props.resultLabel}</b>}{props.hasFilters && <button type="button" onClick={props.onReset} className="ml-auto min-h-9 rounded px-2 text-[11px] font-bold text-[#a7ff5b]">Reset filters</button>}
    </div>
    {statusMessages.length > 0 && <p id="server-filter-status" role="status" className="min-h-5 text-[11px] text-zinc-500">{statusMessages.map(([capability, label]) => capabilityMessage(capability, label)).join(" ")}</p>}
  </section>;
}
