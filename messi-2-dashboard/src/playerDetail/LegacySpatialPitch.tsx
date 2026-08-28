import { useEffect, useId, useMemo, useRef, useState } from "react";

import type { PlayerAnalysis, ShotmapPoint } from "../dashboard/types";
import { displayDensityGrid, legacyDensityGrid, marchingSquares, normalizeDensity, renderDisplayHeatmap, type ActivityPoint } from "./legacyHeatmap";
import { groupPitchShots, medianObservedXg, pitchMarkerRadius, PitchShotMarker } from "./PitchShotMarker";
import { DEFAULT_PITCH_LAYERS, type PitchLayerVisibility } from "./pitchLayers";
import { usePitchPenalty } from "./PitchPenaltyContext";
import { excludePenaltyShots } from "./pitchPenalties";
import { CCA_STYLE, PATH_STYLE, pkAxisLines, pitchMarkings, zone20Lines, type Projection as GeometryProjection } from "./pitchGeometry";
import { formatShotMetric, outcomeOrder, outcomePresentation, outcomeSummary, OutcomeControls, shotIntegrity, shotMarkerLabel, type ShotOutcome, useShotOutcomeVisibility } from "./shotOutcomeVisibility";

const panel = "min-w-0 rounded-xl border border-white/10 bg-[#101415] p-4 shadow-sm";
const TWO_D_COPY = {
  corridorToggle: "6레인 슈팅 회랑",
  corridorNote: "페널티는 분할선 위라 회랑 집계에서 항상 제외",
  unavailable: "정확한 6레인 서버 집계가 아직 없어 브라우저에서 값을 만들지 않았습니다.",
} as const;
const CORRIDOR_LABELS = ["L5 · 왼쪽 외곽", "L4 · 왼쪽 하프스페이스", "L3L · 중앙 왼쪽", "L3R · 중앙 오른쪽", "L2 · 오른쪽 하프스페이스", "L1 · 오른쪽 외곽"] as const;
type Spatial = NonNullable<PlayerAnalysis["spatial"]>;
type Integrity = { heat: boolean; shots: boolean };

const validPoint = (point: ActivityPoint) => Number.isFinite(point.x) && Number.isFinite(point.y) && point.x >= 0 && point.x <= 100 && point.y >= 0 && point.y <= 100;
const spatialIntegrity = (spatial: Spatial | undefined): Integrity => ({
  heat: Boolean(spatial?.available && spatial.heatmapPointCount === spatial.heatmapPoints.length && spatial.heatmapPoints.every(validPoint)),
  shots: shotIntegrity(spatial),
});

function HeatmapCanvas({ points, enabled, opacity = .62 }: { points: readonly ActivityPoint[]; enabled: boolean; opacity?: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const paintedRef = useRef(false);
  const normalized = useMemo(() => normalizeDensity(legacyDensityGrid(points)), [points]);
  const displayDensity = useMemo(() => displayDensityGrid(normalized), [normalized]);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (!enabled || !points.length) {
      if (paintedRef.current) canvas.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height);
      canvas.width = 0; canvas.height = 0; paintedRef.current = false;
      return;
    }
    const draw = () => {
      const rect = canvas.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      const width = Math.max(1, Math.round(rect.width * ratio)), height = Math.max(1, Math.round(rect.height * ratio));
      if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
      const context = canvas.getContext("2d");
      if (!context) return;
      context.clearRect(0, 0, width, height); renderDisplayHeatmap(context, width, height, displayDensity, opacity); paintedRef.current = true;
    };
    draw();
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(draw);
    observer?.observe(canvas); window.addEventListener("resize", draw);
    return () => { observer?.disconnect(); window.removeEventListener("resize", draw); };
  }, [displayDensity, enabled, opacity, points.length]);
  return <canvas ref={canvasRef} aria-hidden="true" className="pointer-events-none absolute inset-0 h-full w-full blur-[10px]" data-layer="legacy-density" data-density-columns="96" data-density-rows="66" />;
}

function useMarkerScale() {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => { const rect = element.getBoundingClientRect(); setSize({ width: rect.width, height: rect.height }); };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(measure);
    observer?.observe(element); window.addEventListener("resize", measure);
    return () => { observer?.disconnect(); window.removeEventListener("resize", measure); };
  }, []);
  return { ref, x: size.width > 0 ? 108 / size.width : 1, y: size.height > 0 ? 100 / size.height : 1 };
}

const screenY = (sourceY: number) => 100 - sourceY;
const pitchPath = (points: readonly { x: number; y: number }[]) => points.map((point, index) => `${index ? "L" : "M"}${point.x} ${screenY(point.y)}`).join(" ");
const planGeometryProjection: GeometryProjection = {
  project: ([worldX, worldY]) => [worldX / 1.05, 100 - worldY / .68],
  pp: (yPct, xPct) => [xPct, screenY(yPct)],
  cameraPosition: [0, 0, 0],
  scale: 1,
};

/** Visual-only Guardiola 20-zone guide. It never derives a zone metric client-side. */
function GuardiolaPitchGuide({ showCorridors }: { showCorridors: boolean }) {
  const markings = PATH_STYLE.marking, grid = PATH_STYLE["zone-grid"], pk = PATH_STYLE["pk-axis"];
  return <g data-layer="guardiola-20-zone-guide" fill="none" vectorEffect="non-scaling-stroke">
    <g data-layer="pitch-markings" stroke={markings.stroke} strokeOpacity={markings.opacity} strokeWidth={markings.width}>
      {pitchMarkings(planGeometryProjection).map((path, index) => <path key={index} d={path.d}/>) }
    </g>
    <g data-layer="positional-grid" stroke={grid.stroke} strokeOpacity={grid.opacity} strokeWidth={grid.width}>
      {zone20Lines(planGeometryProjection).map((path, index) => <path key={index} d={path.d}/>) }
    </g>
    <g data-layer="pk-axis" stroke={pk.stroke} strokeOpacity={pk.opacity} strokeWidth={pk.width} strokeDasharray={pk.dash}>{pkAxisLines(planGeometryProjection).map((path, index) => <path key={index} d={path.d}/>)}</g>
    {showCorridors && <g data-layer="shot-corridors" stroke="#FFFFFF" strokeOpacity=".13" strokeWidth="1" strokeDasharray="3 4">{[21.82, 37, 50, 63, 78.18].map((edge) => <path key={`corridor-${edge}`} d={`M0 ${screenY(edge)}H100`}/>)}</g>}
  </g>;
}

export function starPath(outer: number, inner: number) {
  return Array.from({ length: 10 }, (_, index) => {
    const angle = -Math.PI / 2 + index * Math.PI / 5;
    const radius = index % 2 === 0 ? outer : inner;
    return `${index === 0 ? "M" : "L"}${(Math.cos(angle) * radius).toFixed(3)} ${(Math.sin(angle) * radius).toFixed(3)}`;
  }).join("") + "Z";
}

export function LegacyShotShape({ shot }: { shot: ShotmapPoint }) {
  const { color, size } = outcomePresentation[shot.outcome];
  if (shot.outcome === "goal") return <path d={starPath(size / 2, size / 4.25)} fill={color} stroke="#111827" strokeWidth="1.2" />;
  if (shot.outcome === "on_target") return <circle r={size / 2} fill={color} stroke="#111827" strokeWidth="1.2" />;
  if (shot.outcome === "off_target") return <path d={`M${-size / 2} ${-size / 2}L${size / 2} ${size / 2}M${size / 2} ${-size / 2}L${-size / 2} ${size / 2}`} fill="none" stroke={color} strokeWidth="1.2" />;
  return <path d={`M0 ${-size / 2}L${size / 2} 0L0 ${size / 2}L${-size / 2} 0Z`} fill="none" stroke={color} strokeWidth="1.2" />;
}

function states(spatial: Spatial | undefined, integrity: Integrity) {
  const heat = !spatial?.available ? "활동 히트맵 사용 불가" : !integrity.heat ? "활동 히트맵 무결성 불일치" : spatial.heatmapPoints.length ? `활동 좌표 ${spatial.heatmapPoints.length}개` : "관측된 활동 좌표 0개";
  const shots = !spatial?.shotmapSnapshotAvailable ? "슈팅 스냅샷 사용 불가" : !integrity.shots ? "슈팅 스냅샷 무결성 불일치" : spatial.shotmapPoints.length ? `슛 ${spatial.shotmapPoints.length}개` : "관측된 슛 0개";
  return { heat, shots };
}

export function LegacySpatialPitchFigure({ analysis, visibleOutcomes, markerLayerId: suppliedMarkerLayerId, showCounts = true, layers = DEFAULT_PITCH_LAYERS, corridors = false }: {
  analysis?: PlayerAnalysis; visibleOutcomes?: ReadonlySet<ShotOutcome>; markerLayerId?: string; showCounts?: boolean; layers?: PitchLayerVisibility; corridors?: boolean;
}) {
  const spatial = analysis?.spatial;
  const integrity = spatialIntegrity(spatial);
  const state = states(spatial, integrity);
  const rawId = useId().replace(/:/g, "");
  const markerLayerId = suppliedMarkerLayerId ?? `legacy-shot-markers-${rawId}`;
  const tooltipId = `legacy-shot-tooltip-${rawId}`, descriptionId = `legacy-shot-description-${rawId}`, captionId = `legacy-shot-caption-${rawId}`;
  const markerScale = useMarkerScale();
  const markerRefs = useRef(new Map<string, SVGGElement>());
  const [activeId, setActiveId] = useState<string | null>(null);
  const [tooltipIdState, setTooltipIdState] = useState<string | null>(null);
  const [showCorridors, setShowCorridors] = useState(corridors);
  const normalized = useMemo(() => integrity.heat ? normalizeDensity(legacyDensityGrid(spatial!.heatmapPoints)) : undefined, [integrity.heat, spatial?.heatmapPoints]);
  const contour = useMemo(() => normalized && spatial?.continuousCore.available && spatial.continuousCore.thresholdOfPeak > 0 ? marchingSquares(normalized, spatial.continuousCore.thresholdOfPeak) : [], [normalized, spatial?.continuousCore.available, spatial?.continuousCore.thresholdOfPeak]);
  const allVisible = visibleOutcomes ?? new Set(outcomeOrder);
  const visibleShots = integrity.shots ? spatial!.shotmapPoints.map((shot, sourceIndex) => ({ shot, sourceIndex })).filter(({ shot }) => allVisible.has(shot.outcome)) : [];
  const medianXg = integrity.shots ? medianObservedXg(spatial!.shotmapPoints) : null;
  const markerGroups = groupPitchShots(visibleShots);
  const firstId = markerGroups.length ? `${rawId}-legacy-shot-${markerGroups[0].key}` : null;
  const activeVisibleId = markerGroups.some((group) => `${rawId}-legacy-shot-${group.key}` === activeId) ? activeId : firstId;
  const tooltipEntry = markerGroups.find((group) => `${rawId}-legacy-shot-${group.key}` === tooltipIdState);
  const counts: Record<ShotOutcome, number> = { goal: 0, on_target: 0, off_target: 0, blocked: 0 };
  if (integrity.shots) spatial!.shotmapPoints.forEach((shot) => counts[shot.outcome]++);
  const navigate = (visibleIndex: number, direction: 1 | -1) => {
    if (!markerGroups.length) return;
    const next = markerGroups[(visibleIndex + direction + markerGroups.length) % markerGroups.length];
    const id = `${rawId}-legacy-shot-${next.key}`;
    setActiveId(id); setTooltipIdState(id); markerRefs.current.get(id)?.focus();
  };
  const visibleOutcomeList = outcomeOrder.filter((outcome) => allVisible.has(outcome) && counts[outcome] > 0);
  const description = `2D 회랑. ${state.heat}. ${state.shots}. 표시 결과: ${outcomeSummary(visibleOutcomeList)}. 결과 필터는 마커에만 적용되고 밀도와 CCA는 전체 활동 좌표를 사용합니다.`;
  return <>
    <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-xs">
      {!corridors && <button type="button" aria-pressed={showCorridors} onClick={() => setShowCorridors((visible) => !visible)} className="rounded border border-sky-300/50 px-2 py-1 text-sky-200 hover:bg-sky-300/10">{TWO_D_COPY.corridorToggle}</button>}
      <p className="text-zinc-400">{TWO_D_COPY.corridorNote}</p>
    </div>
    <figure aria-describedby={`${descriptionId} ${captionId}`}>
      <p id={descriptionId} className="sr-only">{description}</p>
      <div ref={markerScale.ref} className="relative isolate w-full overflow-hidden rounded bg-[#063525]" style={{ aspectRatio: "108 / 70.9" }}>
        <HeatmapCanvas points={integrity.heat ? spatial!.heatmapPoints : []} enabled={layers.heatmap && integrity.heat && spatial!.heatmapPoints.length > 0}/>
        <svg viewBox="-4 0 108 100" preserveAspectRatio="none" role="group" aria-label="Interactive two-dimensional shot markers" className="absolute inset-0 h-full w-full" data-layer="legacy-events">
          <GuardiolaPitchGuide showCorridors={showCorridors}/>
          {layers.cca && contour.length > 0 && <path aria-hidden="true" pointerEvents="none" data-layer="cca-contour" d={contour.map(([x1, y1, x2, y2]) => `M${x1.toFixed(4)} ${y1.toFixed(4)}L${x2.toFixed(4)} ${y2.toFixed(4)}`).join("")} fill="none" stroke={CCA_STYLE.stroke} strokeOpacity={CCA_STYLE.opacity} strokeWidth={CCA_STYLE.width} strokeDasharray={CCA_STYLE.dash} vectorEffect="non-scaling-stroke"/>}
          {layers.trajectories && <g data-layer="shot-trajectories-2d" fill="none" pointerEvents="none">{visibleShots.map(({ shot, sourceIndex }) => shot.trajectory ? <path key={sourceIndex} d={`M${shot.x} ${screenY(shot.y)}L${shot.trajectory.endX} ${screenY(shot.trajectory.endY)}`} stroke={outcomePresentation[shot.outcome].color} strokeOpacity=".32" strokeWidth=".65" vectorEffect="non-scaling-stroke"/> : null)}</g>}
          {layers.markers && <g id={markerLayerId}>{markerGroups.map((group, visibleIndex) => { const { shot } = group; const id = `${rawId}-legacy-shot-${group.key}`; const active = id === activeVisibleId; const radius = pitchMarkerRadius(shot.xg, medianXg); const composition = group.count > 1 ? ` Stack: ${group.outcomeCounts.goal} goals, ${group.outcomeCounts.on_target} on target, ${group.outcomeCounts.off_target} off target, ${group.outcomeCounts.blocked} blocked.` : ""; return <g key={id} ref={(element) => { if (element) markerRefs.current.set(id, element); else markerRefs.current.delete(id); }} id={id} role="img" tabIndex={active ? 0 : -1} aria-label={`${shotMarkerLabel(shot)}${group.count > 1 ? ` ${group.count} shots share this exact coordinate.` : ""}${composition}`} aria-describedby={tooltipId} data-shot-marker data-shot-index={group.sourceIndexes[0]} data-shot-indexes={group.sourceIndexes.join(",")} data-shot-outcome={group.outcome} data-marker-symbol={outcomePresentation[group.outcome].symbol} data-marker-size={radius * 2} data-marker-count={group.count} transform={`translate(${shot.x} ${100 - shot.y}) scale(${markerScale.x} ${markerScale.y})`} onFocus={() => { setActiveId(id); setTooltipIdState(id); }} onPointerEnter={() => { setActiveId(id); setTooltipIdState(id); }} onPointerLeave={(event) => { if (document.activeElement !== event.currentTarget) setTooltipIdState(null); }} onKeyDown={(event) => { if (event.key === "ArrowRight" || event.key === "ArrowDown") { event.preventDefault(); navigate(visibleIndex, 1); } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") { event.preventDefault(); navigate(visibleIndex, -1); } }}><g data-marker-visual><PitchShotMarker outcome={group.outcome} radius={radius} count={group.count} outcomeCounts={group.outcomeCounts} expandedStack={tooltipIdState === id}/></g><circle data-marker-hit r="12" fill="transparent" pointerEvents="all" /></g>; })}</g>}
        </svg>
        {tooltipEntry && <div id={tooltipId} role="tooltip" className="pointer-events-none absolute z-10 max-w-36 rounded border border-white/20 bg-[#0b0e0f]/95 px-2 py-1 text-[11px] text-zinc-100 shadow-lg" style={{ left: `${Math.max(4, Math.min(96, ((tooltipEntry.shot.x + 4) / 108) * 100))}%`, top: `${Math.max(4, Math.min(96, 100 - tooltipEntry.shot.y))}%`, transform: "translate(-50%, -110%)" }}><b className="block">{outcomePresentation[tooltipEntry.shot.outcome].label}</b><span className="block">xG {formatShotMetric(tooltipEntry.shot.xg)}</span><span className="block">xGOT {formatShotMetric(tooltipEntry.shot.xgot)}</span></div>}
      </div>
      <figcaption id={captionId} className="mt-2 text-xs text-zinc-400">{state.heat} · {state.shots} · 득점 ◇ · 유효 슛 ● · 빗나감 × · 블록 ■</figcaption>
    </figure>
    {corridors && <section data-layout="six-lane-corridor-summary" className="mt-3 rounded-lg border border-white/10 bg-black/20 p-3" aria-label="6레인 회랑 요약"><div className="overflow-x-auto"><table className="w-full min-w-[560px] text-left text-xs"><thead className="text-zinc-400"><tr><th className="py-2">레인</th><th>슛</th><th>득점</th><th>xG</th><th>활동</th></tr></thead><tbody>{CORRIDOR_LABELS.map((label) => <tr key={label} className="border-t border-white/10"><th className="py-2 font-medium text-zinc-200">{label}</th><td>—</td><td>—</td><td>—</td><td>—</td></tr>)}</tbody></table></div><p role="status" className="mt-3 text-xs text-amber-200">{TWO_D_COPY.unavailable}</p><p className="mt-1 text-xs text-zinc-400">{TWO_D_COPY.corridorNote}</p></section>}
    {showCounts && integrity.shots && <ul className="mt-2 flex flex-wrap gap-x-3 text-xs text-zinc-400"><li>Goals {counts.goal}</li><li>On target {counts.on_target}</li><li>Off target {counts.off_target}</li><li>Blocked {counts.blocked}</li></ul>}
  </>;
}

export function LegacySpatialPitch({ analysis, contextIdentity = "" }: { analysis?: PlayerAnalysis; contextIdentity?: string }) {
  const { includePenalties } = usePitchPenalty();
  const displayAnalysis = useMemo(() => {
    if (!analysis?.spatial || includePenalties) return analysis;
    const shotmapPoints = [...excludePenaltyShots(analysis.spatial.shotmapPoints, false)];
    return { ...analysis, spatial: { ...analysis.spatial, shotmapPoints, shotmapPointCount: shotmapPoints.length } };
  }, [analysis, includePenalties]);
  const controller = useShotOutcomeVisibility(displayAnalysis?.spatial, contextIdentity);
  const rawId = useId().replace(/:/g, ""), markerLayerId = `legacy-shot-markers-${rawId}`;
  return <section className={panel} aria-labelledby={`spatial-pitch-${rawId}`}><h2 id={`spatial-pitch-${rawId}`} className="text-sm font-black">2D 회랑</h2>
    {controller.integrity && controller.presentOutcomes.length > 0 && <OutcomeControls outcomes={controller.presentOutcomes} counts={controller.counts} visible={controller.visibleOutcomes} markerLayerId={markerLayerId} onClick={controller.onClick} onDoubleClick={controller.onDoubleClick}/>}<p role="status" aria-live="polite" className="sr-only">Visible shot outcomes: {outcomeSummary(controller.presentOutcomes.filter((outcome) => controller.visibleOutcomes.has(outcome)))}.</p><div className="mt-3"><LegacySpatialPitchFigure analysis={displayAnalysis} visibleOutcomes={controller.visibleOutcomes} markerLayerId={markerLayerId}/></div>
  </section>;
}
