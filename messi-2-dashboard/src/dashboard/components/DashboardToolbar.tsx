import { useEffect, useId, useRef, useState } from "react";

import { datasetHref, positionFilterValues } from "../datasetRoute";
import type { DatasetRouteState, Player, PositionFilterCapability, SortKey } from "../types";
import { Icon } from "./Icon";

export type PositionFilter = { value: string; label: string };

export const positionFilters: readonly PositionFilter[] = [
  { value: "ALL", label: "All positions" },
  ...positionFilterValues.map((value) => ({ value, label: value })),
];

type Props = {
  query: string;
  role: string;
  sort: SortKey;
  watchOnly: boolean;
  watchCount: number;
  watchAvailable?: boolean;
  position?: string;
  positionCapability?: PositionFilterCapability;
  resultLabel?: string;
  hasFilters: boolean;
  players: readonly Player[];
  dataset: DatasetRouteState;
  onQueryChange(value: string): void;
  onRoleChange(value: string): void;
  onPositionChange?(value: string): void;
  onSortChange(value: SortKey): void;
  onDirectionChange?(value: "asc" | "desc"): void;
  direction?: "asc" | "desc";
  onWatchOnlyChange(value: boolean): void;
  onReset(): void;
};

const action = "inline-flex min-h-11 items-center justify-center rounded-md border px-3 text-[11px] font-bold outline-none focus-visible:ring-2 focus-visible:ring-[#8cff68] focus-visible:ring-offset-2 focus-visible:ring-offset-[#080b0c]";

export function DashboardToolbar(props: Props) {
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [needle, setNeedle] = useState(props.query);
  const onQueryChangeRef = useRef(props.onQueryChange);
  onQueryChangeRef.current = props.onQueryChange;

  useEffect(() => { setNeedle(props.query); }, [props.query]);
  useEffect(() => {
    if (needle === props.query) return;
    const timer = window.setTimeout(() => {
      if (needle !== props.query) onQueryChangeRef.current(needle);
    }, 180);
    return () => window.clearTimeout(timer);
  }, [needle, props.query]);

  const candidates = needle.trim()
    ? props.players.filter((player) => `${player.name} ${player.club.name} ${player.league.name}`.toLocaleLowerCase().includes(needle.toLocaleLowerCase())).slice(0, 8)
    : [];
  const choose = (player: Player) => { window.location.assign(datasetHref(`/players/${player.id}`, props.dataset)); };
  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" && candidates.length) {
      event.preventDefault(); setOpen(true); setActive((index) => Math.min(index + 1, candidates.length - 1));
    } else if (event.key === "ArrowUp" && candidates.length) {
      event.preventDefault(); setOpen(true); setActive((index) => Math.max(index - 1, 0));
    } else if (event.key === "Enter" && active >= 0 && candidates[active]) {
      event.preventDefault(); choose(candidates[active]);
    } else if (event.key === "Escape") {
      setOpen(false); setActive(-1);
    }
  };

  const positionCapability = props.positionCapability ?? "unsupported";
  const positionSupported = positionCapability === "supported";
  const selectedPosition = positionSupported ? (props.position ?? "ALL") : "ALL";

  return <section aria-labelledby="player-search-heading" className="mb-5 space-y-3">
    <h2 id="player-search-heading" className="sr-only">Player search and filters</h2>
    <label className="relative mx-auto block w-full min-w-0">
      <span className="sr-only">Search players</span>
      <Icon path="m21 21-4.35-4.35M19 11a8 8 0 1 1-16 0 0 1 16 0Z" className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500" />
      <input value={needle} onFocus={() => setOpen(true)} onChange={(event) => { setNeedle(event.target.value); setOpen(true); setActive(-1); }} onKeyDown={onKeyDown} role="combobox" aria-autocomplete="list" aria-haspopup="listbox" aria-controls={listId} aria-expanded={open && candidates.length > 0} aria-activedescendant={open && active >= 0 ? `${listId}-${active}` : undefined} placeholder="Search player, club, or league" className="h-12 w-full rounded-md border border-white/10 bg-[#111516] pl-10 pr-20 text-sm outline-none placeholder:text-zinc-600 focus:border-[#8cff68]/50 focus:ring-2 focus:ring-[#8cff68]/10" />
      {needle && <button type="button" onClick={() => { setNeedle(""); props.onQueryChange(""); setActive(-1); }} className="absolute right-2 top-1/2 min-h-9 -translate-y-1/2 rounded px-2 text-[11px] text-zinc-400">Clear</button>}
      {open && candidates.length > 0 && <ul id={listId} role="listbox" aria-label="Player suggestions" className="absolute z-50 mt-1 max-h-80 w-full overflow-auto rounded-md border border-white/10 bg-[#101415] p-1 shadow-2xl">
        {candidates.map((player, index) => <li id={`${listId}-${index}`} role="option" aria-selected={index === active} key={player.id} onMouseDown={(event) => event.preventDefault()} onClick={() => choose(player)} className={`flex min-h-11 w-full cursor-pointer items-center justify-between rounded px-3 text-left text-xs ${index === active ? "bg-lime-300/10 text-lime-200" : "hover:bg-white/5"}`}>
          <span className="font-bold">{player.name}</span><span className="text-zinc-500">{player.club.name} · {player.league.name} · {player.position}</span>
        </li>)}
      </ul>}
    </label>
    <fieldset aria-describedby={positionSupported ? undefined : "position-filter-status"} className="min-w-0">
      <legend className="sr-only">Position filters</legend>
      <div className="flex flex-wrap gap-2">
        {positionFilters.map((item) => {
          const available = item.value === "ALL" || positionSupported;
          const selected = selectedPosition === item.value;
          return <button type="button" key={item.value} disabled={!available} onClick={() => props.onPositionChange?.(item.value)} aria-pressed={selected} title={available ? undefined : "Detailed position filtering requires server support"} className={`${action} whitespace-nowrap ${selected ? "border-[#8cff68]/45 bg-[#8cff68]/10 text-[#a7ff5b]" : "border-white/10 bg-[#111516] text-zinc-500 hover:text-white"} disabled:cursor-not-allowed disabled:opacity-50`}>{item.label}</button>;
        })}
      </div>
      <div className="mt-2 min-h-5">
        {!positionSupported && <p id="position-filter-status" role="status" className="text-[11px] text-zinc-500">{positionCapability === "unknown" ? "Checking detailed position-filter support…" : "Detailed position filters are unavailable from this server."}</p>}
      </div>
    </fieldset>
    <div className="flex min-h-11 flex-wrap items-center gap-2">
      <select aria-label="Role" value={props.role} onChange={(event) => props.onRoleChange(event.target.value)} className="h-11 min-w-36 rounded-md border border-white/10 bg-[#111516] px-3 text-[11px] font-bold text-zinc-300"><option value="ALL">All roles</option><option value="Type A">Type A</option><option value="Type B">Type B</option></select>
      <select aria-label="Sort" value={props.sort} onChange={(event) => props.onSortChange(event.target.value as SortKey)} className="h-11 min-w-48 rounded-md border border-white/10 bg-[#111516] px-3 text-[11px] font-bold text-zinc-300"><option value="score">M.E.S.S.I. score</option><option value="name">Name</option><option value="age">Age</option></select>
      <select aria-label="Sort direction" value={props.direction ?? "desc"} onChange={(event) => props.onDirectionChange?.(event.target.value as "asc" | "desc")} className="h-11 min-w-28 rounded-md border border-white/10 bg-[#111516] px-3 text-[11px] font-bold text-zinc-300"><option value="desc">Descending</option><option value="asc">Ascending</option></select>
      {props.watchAvailable !== false && <button type="button" onClick={() => props.onWatchOnlyChange(!props.watchOnly)} aria-pressed={props.watchOnly} className={`${action} border-white/10 bg-[#111516] text-zinc-400`}>Watchlist {props.watchCount}</button>}
      {props.resultLabel && <b className="ml-1 text-[11px] text-zinc-300">{props.resultLabel}</b>}
      {props.hasFilters && <button type="button" onClick={props.onReset} className="ml-auto min-h-9 rounded px-2 text-[11px] font-bold text-[#a7ff5b]">Reset filters</button>}
    </div>
  </section>;
}
