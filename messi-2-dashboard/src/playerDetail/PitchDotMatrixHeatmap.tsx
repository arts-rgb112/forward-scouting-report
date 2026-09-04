import { useEffect, useId, useMemo, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";

import type { FullActivityHeatmapData } from "../api/fullActivityHeatmapContracts";
import type { PlayerAnalysis, PositionalGridCell, ShotmapPoint } from "../dashboard/types";
import { bilinearDensity, displayHeatmapColor, fullActivityDensityGrid, normalizeDensity } from "./legacyHeatmap";
import { POSITIONAL_DEPTH_BOUNDARIES, POSITIONAL_LANE_BOUNDARIES } from "./planPitchGeometry";
import type { FullActivityHeatmapState } from "./useFullActivityHeatmap";

/**
 * Approved dot-matrix heatmap (mockup `heatmap_dotmatrix_v16.html`, generator
 * `heatmap_dotmatrix_v16_generator.py`). The numbers below are lifted from
 * that file, not re-derived — see CODEX_HEATMAP_DOTMATRIX_ORDER.md §B-3/B-4.
 * Density itself comes from `legacyHeatmap.ts` (`fullActivityDensityGrid` →
 * `normalizeDensity` → `bilinearDensity`); nothing here recomputes it.
 */
export const DOTMATRIX_COLUMNS = 64;
export const DOTMATRIX_ROWS = 24;
export const DOTMATRIX_DENSITY_CUTOFF = .05;

const VW = 1560, VH = 720, OX = 170, OY = 132, W = 1060, H = 392, FS = .66, THICK = 38;
const SLIDE = 24, ELEV = 6;
/** Third polygons overlap by this much so the shared turf gradient shows no seam at the boundary. */
const SEAM = .10;

const sc = (y: number) => FS + (1 - FS) * (y / 100);
export const dotmatrixProject = (x: number, y: number): readonly [number, number] => [OX + W / 2 + ((x - 50) / 100) * W * sc(y), OY + (y / 100) * H];
const px = (x: number, y: number) => dotmatrixProject(x, y)[0];
const py = (x: number, y: number) => dotmatrixProject(x, y)[1];
const quad = (x1: number, y1: number, x2: number, y2: number) => `M ${px(x1, y1)} ${py(x1, y1)} L ${px(x2, y1)} ${py(x2, y1)} L ${px(x2, y2)} ${py(x2, y2)} L ${px(x1, y2)} ${py(x1, y2)} Z`;
const seg = (x1: number, y1: number, x2: number, y2: number) => `M ${px(x1, y1)} ${py(x1, y1)} L ${px(x2, y2)} ${py(x2, y2)}`;
const front = (a: number, b: number) => { const x1 = px(a, 100), y1 = py(a, 100), x2 = px(b, 100), y2 = py(b, 100); return `M ${x1} ${y1} L ${x2} ${y2} L ${x2} ${y2 + THICK} L ${x1} ${y1 + THICK} Z`; };
const wall = (a: number) => { const x0 = px(a, 0), y0 = py(a, 0), x1 = px(a, 100), y1 = py(a, 100); return `M ${x0} ${y0} L ${x1} ${y1} L ${x1} ${y1 + THICK} L ${x1 - SLIDE} ${y1 + THICK} L ${x0 - SLIDE} ${y0} Z`; };

/** Radius formula from the approved mockup — grows toward 94% of the cell spacing so the hottest cells nearly touch. */
export function dotRadius(density: number, rowY: number): number {
  const rmax = .47 * Math.min((W / DOTMATRIX_COLUMNS) * sc(rowY), H / DOTMATRIX_ROWS);
  const t = Math.min(1, Math.max(0, (density - DOTMATRIX_DENSITY_CUTOFF) / (1 - DOTMATRIX_DENSITY_CUTOFF)));
  return rmax * (.26 + .74 * Math.pow(t, .55));
}

const THIRD_X = [0, POSITIONAL_DEPTH_BOUNDARIES[2], POSITIONAL_DEPTH_BOUNDARIES[4], 100] as const;
const THIRD_LABELS = ["수비 서드", "중원 서드", "어태킹 서드"] as const;
export function thirdIndexForX(x: number): 0 | 1 | 2 {
  if (x < THIRD_X[1]) return 0;
  if (x < THIRD_X[2]) return 1;
  return 2;
}

type DotCell = { row: number; col: number; x: number; y: number; density: number };
function computeCells(cellCounts: readonly number[] | undefined): readonly DotCell[] {
  if (!cellCounts) return [];
  const normalized = normalizeDensity(fullActivityDensityGrid(cellCounts));
  const cells: DotCell[] = [];
  for (let row = 0; row < DOTMATRIX_ROWS; row += 1) {
    const y = (row + .5) * 100 / DOTMATRIX_ROWS;
    for (let col = 0; col < DOTMATRIX_COLUMNS; col += 1) {
      const x = (col + .5) * 100 / DOTMATRIX_COLUMNS;
      const density = bilinearDensity(normalized, x, y);
      if (density > DOTMATRIX_DENSITY_CUTOFF) cells.push({ row, col, x, y, density });
    }
  }
  return cells.sort((left, right) => left.density - right.density);
}

const inRange = (value: number, low: number, high: number, lastBand: boolean) => value >= low && (lastBand ? value <= high : value < high);
function shotsInBox(shots: readonly ShotmapPoint[], x0: number, x1: number, xLast: boolean, y0 = 0, y1 = 100, yLast = true) {
  const matched = shots.filter((shot) => inRange(shot.x, x0, x1, xLast) && inRange(shot.y, y0, y1, yLast));
  return { shots: matched.length, goals: matched.filter((shot) => shot.outcome === "goal").length, xg: matched.reduce((total, shot) => total + (typeof shot.xg === "number" && Number.isFinite(shot.xg) ? shot.xg : 0), 0) };
}

function usePrefersReducedMotion() {
  const query = "(prefers-reduced-motion: reduce)";
  const read = () => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(query).matches;
  const [reduced, setReduced] = useState(read);
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const media = window.matchMedia(query);
    const update = () => setReduced(media.matches);
    update();
    media.addEventListener?.("change", update);
    return () => media.removeEventListener?.("change", update);
  }, []);
  return reduced;
}

const COPY = {
  title: "도트 매트릭스 히트맵",
  hint: "점 하나 = 격자 셀 하나. 크기·색은 그 지점의 밀도가 결정합니다. 서드를 누르면 그 구획만 분리되고, 선택된 서드 안에서 30구역을 다시 누르면 구역 단위로 내려갑니다.",
  loading: "히트맵 원천을 불러오는 중입니다.",
  unavailableFallback: "이 컨텍스트에서 활동 히트맵 원천을 사용할 수 없습니다.",
  error: "히트맵 원천을 불러오지 못했습니다.",
} as const;

function ZoneGauge({ label, value, denominator }: { label: string; value: string; denominator?: string }) {
  return <div className="rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-center">
    <dt className="type-caption text-zinc-500">{label}</dt>
    <dd className="font-mono text-lg font-black text-zinc-100">{value}{denominator && <span className="ml-0.5 text-sm font-semibold text-zinc-400">/{denominator}</span>}</dd>
  </div>;
}

export function PitchDotMatrixHeatmap({ analysis, fullHeatmap }: { analysis?: PlayerAnalysis; fullHeatmap: FullActivityHeatmapState }) {
  const rawId = useId().replace(/:/g, "");
  const reducedMotion = usePrefersReducedMotion();
  const [selectedThird, setSelectedThird] = useState<0 | 1 | 2 | null>(null);
  const [selectedZone, setSelectedZone] = useState<PositionalGridCell | null>(null);

  const data: FullActivityHeatmapData | undefined = fullHeatmap.kind === "ready" || fullHeatmap.kind === "unavailable" ? fullHeatmap.data : undefined;
  const cells = useMemo(() => computeCells(data?.available ? data.cellCounts : undefined), [data]);
  const shots = analysis?.spatial.shotmapPoints ?? [];
  const positionalGrid = analysis?.spatial.positionalGrid ?? [];

  const select = (third: 0 | 1 | 2) => {
    setSelectedThird((current) => (current === third ? null : third));
    setSelectedZone(null);
  };
  const selectZone = (cell: PositionalGridCell) => {
    const third = thirdIndexForX((POSITIONAL_DEPTH_BOUNDARIES[cell.depth] + POSITIONAL_DEPTH_BOUNDARIES[cell.depth + 1]) / 2);
    if (selectedThird !== third) { setSelectedThird(third); setSelectedZone(null); return; }
    setSelectedZone((current) => (current && current.depth === cell.depth && current.lane === cell.lane ? null : cell));
  };
  const clear = () => { setSelectedThird(null); setSelectedZone(null); };
  const onKeyActivate = (event: ReactKeyboardEvent, action: () => void) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); action(); } };

  const overall = { activity: data?.validPointCount, shots: shots.length, goals: shots.filter((shot) => shot.outcome === "goal").length, xg: shots.reduce((total, shot) => total + (typeof shot.xg === "number" && Number.isFinite(shot.xg) ? shot.xg : 0), 0) };
  const thirdSummary = selectedThird !== null ? (() => {
    const x0 = THIRD_X[selectedThird], x1 = THIRD_X[selectedThird + 1];
    const occupancy = positionalGrid.filter((cell) => thirdIndexForX((POSITIONAL_DEPTH_BOUNDARIES[cell.depth] + POSITIONAL_DEPTH_BOUNDARIES[cell.depth + 1]) / 2) === selectedThird).reduce((total, cell) => total + cell.occupancyPct, 0);
    return { occupancy, ...shotsInBox(shots, x0, x1, selectedThird === 2) };
  })() : null;
  const zoneSummary = selectedZone ? (() => {
    const cell = positionalGrid.find((candidate) => candidate.depth === selectedZone.depth && candidate.lane === selectedZone.lane);
    const x0 = POSITIONAL_DEPTH_BOUNDARIES[selectedZone.depth], x1 = POSITIONAL_DEPTH_BOUNDARIES[selectedZone.depth + 1];
    const y0 = POSITIONAL_LANE_BOUNDARIES[selectedZone.lane], y1 = POSITIONAL_LANE_BOUNDARIES[selectedZone.lane + 1];
    return { occupancy: cell?.occupancyPct, ...shotsInBox(shots, x0, x1, selectedZone.depth === 5, y0, y1, selectedZone.lane === 4) };
  })() : null;

  if (fullHeatmap.kind === "loading") return <section aria-label={COPY.title} className="rounded-xl border border-white/10 bg-[#0b1011] p-3"><p role="status" aria-live="polite" className="p-4 text-sm text-zinc-300">{COPY.loading}</p></section>;
  if (fullHeatmap.kind === "error") return <section aria-label={COPY.title} className="rounded-xl border border-white/10 bg-[#0b1011] p-3"><p role="status" aria-live="polite" className="p-4 text-sm text-amber-200">{COPY.error}</p></section>;
  if (!data || !data.available) return <section aria-label={COPY.title} className="rounded-xl border border-white/10 bg-[#0b1011] p-3"><p role="status" aria-live="polite" className="p-4 text-sm text-amber-200">{data?.reason ?? COPY.unavailableFallback}</p></section>;

  const transition = reducedMotion ? "none" : "transform .38s cubic-bezier(.22,.92,.26,1)";
  const turfId = `${rawId}-turf`, soilId = `${rawId}-soil`, turfSelId = `${rawId}-turfsel`, soilSelId = `${rawId}-soilsel`, liteId = `${rawId}-lite`, grainId = `${rawId}-grain`, dropId = `${rawId}-drop`;

  return <section data-layout="pitch-dot-matrix-heatmap" className="rounded-xl border border-white/10 bg-[#0b1011] p-3" aria-labelledby={`${rawId}-title`}>
    <h3 id={`${rawId}-title`} className="text-sm font-black text-zinc-100">{COPY.title}</h3>
    <dl className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
      {selectedZone && zoneSummary ? <>
        <ZoneGauge label="구역 점유" value={zoneSummary.occupancy == null ? "—" : `${zoneSummary.occupancy.toFixed(2)}%`}/>
        <ZoneGauge label="슛" value={String(zoneSummary.shots)} denominator={String(overall.shots)}/>
        <ZoneGauge label="득점" value={String(zoneSummary.goals)} denominator={zoneSummary.shots ? String(zoneSummary.shots) : "—"}/>
        <ZoneGauge label="xG" value={zoneSummary.xg.toFixed(2)}/>
      </> : selectedThird !== null && thirdSummary ? <>
        <ZoneGauge label={`${THIRD_LABELS[selectedThird]} 점유`} value={`${thirdSummary.occupancy.toFixed(1)}%`}/>
        <ZoneGauge label="슛" value={String(thirdSummary.shots)} denominator={String(overall.shots)}/>
        <ZoneGauge label="득점" value={String(thirdSummary.goals)} denominator={thirdSummary.shots ? String(thirdSummary.shots) : "—"}/>
        <ZoneGauge label="xG" value={thirdSummary.xg.toFixed(2)}/>
      </> : <>
        <ZoneGauge label="활동 좌표" value={overall.activity == null ? "—" : String(overall.activity)}/>
        <ZoneGauge label="슛" value={String(overall.shots)}/>
        <ZoneGauge label="득점" value={String(overall.goals)} denominator={overall.shots ? String(overall.shots) : "—"}/>
        <ZoneGauge label="xG" value={overall.xg.toFixed(2)}/>
      </>}
    </dl>
    <div role="group" aria-label="서드 선택" className="mt-3 flex flex-wrap gap-2">
      {THIRD_LABELS.map((label, index) => <button key={label} type="button" aria-pressed={selectedThird === index} onClick={() => select(index as 0 | 1 | 2)} className="min-h-9 rounded-full border border-white/15 px-4 text-sm font-bold text-zinc-300 aria-pressed:border-transparent aria-pressed:bg-red-500 aria-pressed:text-white">{label}</button>)}
    </div>
    <figure className="mt-3">
      <svg viewBox={`0 0 ${VW} ${VH}`} role="img" aria-label={`${COPY.title}. ${data.validPointCount}개 활동 좌표, ${overall.shots}개 슛.`} className="h-auto w-full" onClick={clear}>
        <defs>
          <linearGradient id={turfId} gradientUnits="userSpaceOnUse" x1={OX} y1={OY} x2={OX + W * .3} y2={OY + H}>
            <stop offset="0" stopColor="#3BB985"/><stop offset=".55" stopColor="#279B69"/><stop offset="1" stopColor="#17714B"/>
          </linearGradient>
          <linearGradient id={soilId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#329769"/><stop offset=".16" stopColor="#1B6543"/><stop offset=".26" stopColor="#7E5A2E"/><stop offset=".6" stopColor="#573A1B"/><stop offset="1" stopColor="#2E1E0B"/>
          </linearGradient>
          <linearGradient id={turfSelId} gradientUnits="userSpaceOnUse" x1={OX} y1={OY} x2={OX + W * .3} y2={OY + H}>
            <stop offset="0" stopColor="#4C121B"/><stop offset=".55" stopColor="#350D13"/><stop offset="1" stopColor="#1F070C"/>
          </linearGradient>
          <linearGradient id={soilSelId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#7A2320"/><stop offset=".2" stopColor="#54120F"/><stop offset=".34" stopColor="#4A2614"/><stop offset="1" stopColor="#1E0D05"/>
          </linearGradient>
          <radialGradient id={liteId} gradientUnits="userSpaceOnUse" cx={OX + W * .42} cy={OY + H * .2} r={W * .8}>
            <stop offset="0" stopColor="#ffffff" stopOpacity=".15"/><stop offset=".6" stopColor="#ffffff" stopOpacity=".02"/><stop offset="1" stopColor="#00190C" stopOpacity=".10"/>
          </radialGradient>
          <filter id={grainId} x="0" y="0" width="100%" height="100%"><feTurbulence type="fractalNoise" baseFrequency=".9" numOctaves={2}/><feColorMatrix type="saturate" values="0"/><feComponentTransfer><feFuncA type="linear" slope=".05"/></feComponentTransfer></filter>
          <filter id={dropId} x="-70%" y="-70%" width="260%" height="300%"><feDropShadow dx="0" dy="20" stdDeviation="18" floodColor="#000000" floodOpacity=".5"/></filter>
        </defs>
        {([0, 1, 2] as const).map((third) => {
          const a = THIRD_X[third], b = THIRD_X[third + 1];
          const la = third === 0 ? a : a - SEAM, lb = third === 2 ? b : b + SEAM;
          const selected = selectedThird === third;
          const dimmed = selectedThird !== null && !selected;
          const tx = selectedThird === null ? 0 : third < selectedThird ? 0 : third === selectedThird ? (selectedThird > 0 ? SLIDE : 0) : (selectedThird > 0 ? 2 * SLIDE : SLIDE);
          const ty = selected ? -ELEV : 0;
          const showWall = selectedThird !== null && third > 0 && (third === selectedThird || third === selectedThird + 1);
          const thirdCells = cells.filter((cell) => cell.x >= a && cell.x < b || (third === 2 && cell.x === 100));
          return <g key={third} style={{ transform: `translate(${tx}px,${ty}px)`, transition }} data-third={third} data-third-selected={selected}>
            <path d={wall(a)} fill={`url(#${soilId})`} opacity={showWall ? 1 : 0} style={{ transition }}/>
            <path d={wall(a)} fill={`url(#${soilSelId})`} opacity={showWall && selected ? 1 : 0} style={{ transition }}/>
            <g filter={`url(#${dropId})`}>
              <path d={front(la, lb)} fill={`url(#${soilId})`}/>
              <path d={quad(la, 0, lb, 100)} fill={`url(#${turfId})`}/>
            </g>
            {[0, 2, 4, 6, 8, 10].filter((stripe) => stripe * 100 / 12 < lb && (stripe + 1) * 100 / 12 > la).map((stripe) => <path key={stripe} d={quad(Math.max(a, stripe * 100 / 12), 0, Math.min(b, (stripe + 1) * 100 / 12), 100)} fill="#ffffff" fillOpacity=".055"/>)}
            <path d={quad(a, 0, b, 100)} fill={`url(#${liteId})`}/>
            <path d={quad(a, 0, b, 100)} filter={`url(#${grainId})`} fill="#ffffff" fillOpacity=".5"/>
            {/* 선택된 서드의 버건디 바닥 — 도트보다 아래 레이어 */}
            <path d={quad(a, 0, b, 100)} fill={`url(#${turfSelId})`} fillOpacity={selected ? .9 : 0} pointerEvents="none" style={{ transition }}/>
            <path d={front(la, lb)} fill={`url(#${soilSelId})`} fillOpacity={selected ? 1 : 0} pointerEvents="none" style={{ transition }}/>
            <path d={quad(a, 0, b, 100)} fill="#04120A" fillOpacity={dimmed ? .42 : 0} pointerEvents="none" style={{ transition }}/>
            {thirdCells.map((cell) => { const [cx, cy] = dotmatrixProject(cell.x, cell.y); const [r, g, b2, alpha] = displayHeatmapColor(cell.density); return <circle key={`${cell.row}-${cell.col}`} cx={cx} cy={cy} r={dotRadius(cell.density, cell.y)} fill={`rgb(${Math.round(r)},${Math.round(g)},${Math.round(b2)})`} fillOpacity={alpha} pointerEvents="none"/>; })}
            <path d={seg(a, 0, b, 0)} stroke="#ffffff" strokeOpacity=".88" strokeWidth="2.1" fill="none"/>
            <path d={seg(a, 100, b, 100)} stroke="#ffffff" strokeOpacity=".88" strokeWidth="2.1" fill="none"/>
            {third === 0 && <path d={seg(0, 0, 0, 100)} stroke="#ffffff" strokeOpacity=".88" strokeWidth="2.1" fill="none"/>}
            {third === 2 && <path d={seg(100, 0, 100, 100)} stroke="#ffffff" strokeOpacity=".88" strokeWidth="2.1" fill="none"/>}
            {third === 1 && <>
              <path d={seg(50, 0, 50, 100)} stroke="#ffffff" strokeOpacity=".88" strokeWidth="2.1" fill="none"/>
              <path d={Array.from({ length: 45 }, (_, index) => { const theta = index / 44 * 2 * Math.PI; const cx2 = 50 + 9.15 * Math.cos(theta), cy2 = 50 + 14.1 * Math.sin(theta); return `${index ? "L" : "M"} ${px(cx2, cy2)} ${py(cx2, cy2)}`; }).join(" ")} stroke="#ffffff" strokeOpacity=".88" strokeWidth="2.1" fill="none"/>
            </>}
            {(third === 0 || third === 2) && (() => { const gx = third === 2 ? 100 : 0, out = third === 2 ? 1 : -1; const y1 = 44.6, y2 = 55.4, lift = 30, depth = 3.4; const f1x = px(gx, y1), f1y = py(gx, y1), f2x = px(gx, y2), f2y = py(gx, y2); const b1x = f1x + out * depth / 100 * W * sc(y1), b1y = f1y; const b2x = f2x + out * depth / 100 * W * sc(y2), b2y = f2y; return <g>
              <path d={`M ${b1x} ${b1y - lift} L ${b2x} ${b2y - lift} L ${b2x} ${b2y} L ${b1x} ${b1y} Z`} fill="#07301F" fillOpacity=".7"/>
              {[1, 2, 3, 4, 5, 6].map((step) => { const f = step / 7; return <path key={`h${step}`} d={`M ${b1x + (b2x - b1x) * f} ${b1y + (b2y - b1y) * f - lift} L ${b1x + (b2x - b1x) * f} ${b1y + (b2y - b1y) * f}`} stroke="#fff" strokeOpacity=".3" strokeWidth=".9"/>; })}
              {[1, 2, 3, 4].map((step) => { const f = step / 5; return <path key={`v${step}`} d={`M ${b1x} ${b1y - lift + lift * f} L ${b2x} ${b2y - lift + lift * f}`} stroke="#fff" strokeOpacity=".24" strokeWidth=".9"/>; })}
              <path d={`M ${f1x} ${f1y - lift} L ${b1x} ${b1y - lift}`} stroke="#fff" strokeOpacity=".85" strokeWidth="2"/>
              <path d={`M ${f2x} ${f2y - lift} L ${b2x} ${b2y - lift}`} stroke="#fff" strokeOpacity=".85" strokeWidth="2"/>
              <path d={`M ${f1x} ${f1y} L ${f1x} ${f1y - lift} L ${f2x} ${f2y - lift} L ${f2x} ${f2y}`} stroke="#fff" strokeWidth="4.4" fill="none" strokeLinejoin="round" strokeLinecap="round"/>
              {[0, 100].map((cy3) => { const cxp = px(gx, cy3), cyp = py(gx, cy3), fl = 24, dir = gx < 50 ? 1 : -1; return <g key={cy3}><path d={`M ${cxp} ${cyp} L ${cxp} ${cyp - fl}`} stroke="#f2f5f6" strokeWidth="2"/><path d={`M ${cxp} ${cyp - fl} L ${cxp + dir * 14} ${cyp - fl + 5} L ${cxp} ${cyp - fl + 10} Z`} fill="#E8342A"/></g>; })}
            </g>; })()}
            {[0, 1, 2, 3, 4, 5].filter((depth) => Math.floor(depth / 2) === third).flatMap((depth) => [0, 1, 2, 3, 4].map((lane) => {
              const cell = positionalGrid.find((candidate) => candidate.depth === depth && candidate.lane === lane);
              if (!cell) return null;
              const x0 = POSITIONAL_DEPTH_BOUNDARIES[depth], x1 = POSITIONAL_DEPTH_BOUNDARIES[depth + 1];
              const y0 = POSITIONAL_LANE_BOUNDARIES[lane], y1 = POSITIONAL_LANE_BOUNDARIES[lane + 1];
              const cx = (px(x0, y0) + px(x1, y0) + px(x0, y1) + px(x1, y1)) / 4;
              const cy = (py(0, y0) + py(0, y1)) / 2;
              const zoneSelected = selectedZone?.depth === depth && selectedZone?.lane === lane;
              return <g key={`${depth}-${lane}`} data-zone={`${depth}-${lane}`} role="button" tabIndex={selected ? 0 : -1} aria-label={`구역 ${depth * 5 + lane + 1}, 깊이 ${depth + 1} 레인 ${lane + 1}, 점유 ${cell.occupancyPct.toFixed(2)}%`} aria-pressed={zoneSelected} className="cursor-pointer" onClick={(event) => { event.stopPropagation(); selectZone(cell); }} onKeyDown={(event) => onKeyActivate(event, () => selectZone(cell))}>
                <path d={quad(x0, y0, x1, y1)} fill="#ffffff" fillOpacity={zoneSelected ? .14 : .005}/>
                <path d={quad(x0, y0, x1, y1)} fill="none" stroke={zoneSelected ? "#FFD9D5" : "#ffffff"} strokeOpacity={zoneSelected ? .95 : .18} strokeWidth={zoneSelected ? 2.2 : 1.1} strokeDasharray={zoneSelected ? undefined : "7 5"}/>
                <text x={cx} y={cy + 4} textAnchor="middle" fill="#ffffff" fillOpacity={selected ? .95 : .42} fontSize="11.5" fontWeight="800" pointerEvents="none" style={{ paintOrder: "stroke", stroke: "#0d4530", strokeWidth: 3.6 }}>{cell.occupancyPct.toFixed(1)}</text>
              </g>;
            }))}
          </g>;
        })}
      </svg>
    </figure>
    <p className="mt-2 type-caption text-zinc-400">{COPY.hint}</p>
  </section>;
}
