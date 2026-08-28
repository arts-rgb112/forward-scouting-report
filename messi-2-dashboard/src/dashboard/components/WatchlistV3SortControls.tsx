import type { WatchlistV3CommonSort } from "../watchlistV3ViewModel";
import { duelPressAxisLabels } from "../duelPressAxisLabels";

/** One global mobile-safe control. Values always come from immutable saved snapshots. */
export function WatchlistV3SortControls({ sort, direction, onChange }: { sort: WatchlistV3CommonSort; direction: "asc" | "desc"; onChange(sort: WatchlistV3CommonSort, direction: "asc" | "desc"): void }) {
  return <div className="mb-3 flex min-h-11 flex-wrap items-center gap-2" aria-label="Saved context sorting">
    <label className="text-xs text-zinc-400">저장된 컨텍스트 정렬
      <select aria-label="Watchlist 정렬 기준" value={sort} onChange={(event) => onChange(event.target.value as WatchlistV3CommonSort, direction)} className="ml-2 min-h-11 rounded border border-white/10 bg-[#111516] px-3 text-xs text-zinc-200">
        <option value="savedAt">저장 시점</option><option value="name">선수 이름</option><option value="score">M.E.S.S.I. 점수</option>
        <option value="outsideShot">{duelPressAxisLabels.outsideShot}</option><option value="boxThreat">{duelPressAxisLabels.boxThreat}</option><option value="dangerZone">{duelPressAxisLabels.dangerZone}</option>
        <option value="aerial">공중 경합 (레거시)</option><option value="groundDuel">지상 경합 (레거시)</option><option value="combinedDuel">{duelPressAxisLabels.combinedDuel}</option>
        <option value="spaceControl">{duelPressAxisLabels.spaceControl}</option><option value="forwardPress">{duelPressAxisLabels.forwardPress}</option><option value="minutes">출전 시간</option><option value="age">나이</option>
      </select>
    </label>
    <button type="button" aria-label={`Sort direction ${direction === "asc" ? "ascending" : "descending"}`} onClick={() => onChange(sort, direction === "asc" ? "desc" : "asc")} className="min-h-11 rounded border border-white/10 px-3 text-xs">{direction === "asc" ? "오름차순 ↑" : "내림차순 ↓"}</button>
    <span className="text-[10px] text-zinc-500">저장 시점 스냅샷 값을 기준으로 정렬합니다. 각 택소노미에 없는 지표는 마지막에 표시됩니다.</span>
  </div>;
}
