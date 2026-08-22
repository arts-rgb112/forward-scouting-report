import { useEffect, useId, useMemo, useRef, useState } from "react";

import type { PlayerAnalysis, ShotmapPoint } from "../dashboard/types";
import { legacyDensityGrid, marchingSquares, normalizeDensity, renderLegacyHeatmap, type ActivityPoint } from "./legacyHeatmap";
import { formatShotMetric, outcomeOrder, outcomePresentation, outcomeSummary, OutcomeControls, shotIntegrity, shotMarkerLabel, type ShotOutcome, useShotOutcomeVisibility } from "./shotOutcomeVisibility";

const panel = "min-w-0 rounded-xl border border-white/10 bg-[#101415] p-4 shadow-sm";
type Spatial = NonNullable<PlayerAnalysis["spatial"]>;
type Integrity = { heat: boolean; shots: boolean };

const validPoint = (point: ActivityPoint) => Number.isFinite(point.x) && Number.isFinite(point.y) && point.x >= 0 && point.x <= 100 && point.y >= 0 && point.y <= 100;
const spatialIntegrity = (spatial: Spatial | undefined): Integrity => ({
  heat: Boolean(spatial?.available && spatial.heatmapPointCount === spatial.heatmapPoints.length && spatial.heatmapPoints.every(validPoint)),
  shots: shotIntegrity(spatial),
});

function HeatmapCanvas({ points, enabled }: { points: readonly ActivityPoint[]; enabled: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const paintedRef = useRef(false);
  const normalized = useMemo(() => normalizeDensity(legacyDensityGrid(points)), [points]);
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
      context.clearRect(0, 0, width, height); renderLegacyHeatmap(context, width, height, normalized); paintedRef.current = true;
    };
    draw();
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(draw);
    observer?.observe(canvas); window.addEventListener("resize", draw);
    return () => { observer?.disconnect(); window.removeEventListener("resize", draw); };
  }, [enabled, normalized, points.length]);
  return <canvas ref={canvasRef} aria-hidden="true" className="pointer-events-none absolute inset-0 h-full w-full" data-layer="legacy-density" />;
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
  const heat = !spatial?.available ? "Activity heatmap unavailable" : !integrity.heat ? "Activity heatmap integrity mismatch" : spatial.heatmapPoints.length ? `${spatial.heatmapPoints.length} activity points` : "Verified zero activity points";
  const shots = !spatial?.shotmapSnapshotAvailable ? "Shot snapshot unavailable" : !integrity.shots ? "Shot snapshot integrity mismatch" : spatial.shotmapPoints.length ? `${spatial.shotmapPoints.length} shots` : "Verified zero shots";
  return { heat, shots };
}

export function LegacySpatialPitchFigure({ analysis, visibleOutcomes, markerLayerId: suppliedMarkerLayerId, showCounts = true }: {
  analysis?: PlayerAnalysis; visibleOutcomes?: ReadonlySet<ShotOutcome>; markerLayerId?: string; showCounts?: boolean;
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
  const normalized = useMemo(() => integrity.heat ? normalizeDensity(legacyDensityGrid(spatial!.heatmapPoints)) : undefined, [integrity.heat, spatial?.heatmapPoints]);
  const contour = useMemo(() => normalized && spatial?.continuousCore.available && spatial.continuousCore.thresholdOfPeak > 0 ? marchingSquares(normalized, spatial.continuousCore.thresholdOfPeak) : [], [normalized, spatial?.continuousCore.available, spatial?.continuousCore.thresholdOfPeak]);
  const allVisible = visibleOutcomes ?? new Set(outcomeOrder);
  const visibleShots = integrity.shots ? spatial!.shotmapPoints.map((shot, sourceIndex) => ({ shot, sourceIndex })).filter(({ shot }) => allVisible.has(shot.outcome)) : [];
  const firstId = visibleShots.length ? `${rawId}-legacy-shot-${visibleShots[0].sourceIndex}` : null;
  const activeVisibleId = visibleShots.some(({ sourceIndex }) => `${rawId}-legacy-shot-${sourceIndex}` === activeId) ? activeId : firstId;
  const tooltipEntry = visibleShots.find(({ sourceIndex }) => `${rawId}-legacy-shot-${sourceIndex}` === tooltipIdState);
  const counts: Record<ShotOutcome, number> = { goal: 0, on_target: 0, off_target: 0, blocked: 0 };
  if (integrity.shots) spatial!.shotmapPoints.forEach((shot) => counts[shot.outcome]++);
  const navigate = (visibleIndex: number, direction: 1 | -1) => {
    if (!visibleShots.length) return;
    const next = visibleShots[(visibleIndex + direction + visibleShots.length) % visibleShots.length];
    const id = `${rawId}-legacy-shot-${next.sourceIndex}`;
    setActiveId(id); setTooltipIdState(id); markerRefs.current.get(id)?.focus();
  };
  const visibleOutcomeList = outcomeOrder.filter((outcome) => allVisible.has(outcome) && counts[outcome] > 0);
  const description = `Two-dimensional legacy spatial pitch. ${state.heat}. ${state.shots}. Visible shot outcomes: ${outcomeSummary(visibleOutcomeList)}. Outcome controls change markers only; density and CCA use all activity points.`;
  return <>
    <figure aria-describedby={`${descriptionId} ${captionId}`}>
      <p id={descriptionId} className="sr-only">{description}</p>
      <div ref={markerScale.ref} className="relative isolate w-full overflow-hidden rounded bg-[#063525]" style={{ aspectRatio: "108 / 70.9" }}>
        <svg viewBox="-4 0 108 100" preserveAspectRatio="none" role="img" aria-label={description} className="absolute inset-0 h-full w-full" data-layer="legacy-pitch"><image href="/assets/positional-grid-pitch.webp" x="-10.52" y="-5" width="121.17" height="110" preserveAspectRatio="none" /></svg>
        <HeatmapCanvas points={integrity.heat ? spatial!.heatmapPoints : []} enabled={integrity.heat && spatial!.heatmapPoints.length > 0}/>
        <svg viewBox="-4 0 108 100" preserveAspectRatio="none" role="group" aria-label="Interactive two-dimensional shot markers" className="absolute inset-0 h-full w-full" data-layer="legacy-events">
          {contour.length > 0 && <path aria-hidden="true" pointerEvents="none" data-layer="cca-contour" d={contour.map(([x1, y1, x2, y2]) => `M${x1.toFixed(4)} ${y1.toFixed(4)}L${x2.toFixed(4)} ${y2.toFixed(4)}`).join("")} fill="none" stroke="#C044FF" strokeWidth="3" vectorEffect="non-scaling-stroke"/>}
          <g id={markerLayerId}>{visibleShots.map(({ shot, sourceIndex }, visibleIndex) => { const id = `${rawId}-legacy-shot-${sourceIndex}`; const active = id === activeVisibleId; return <g key={id} ref={(element) => { if (element) markerRefs.current.set(id, element); else markerRefs.current.delete(id); }} id={id} role="img" tabIndex={active ? 0 : -1} aria-label={shotMarkerLabel(shot)} aria-describedby={tooltipId} data-shot-index={sourceIndex} data-shot-outcome={shot.outcome} data-marker-symbol={outcomePresentation[shot.outcome].symbol} data-marker-size={outcomePresentation[shot.outcome].size} transform={`translate(${shot.x} ${100 - shot.y}) scale(${markerScale.x} ${markerScale.y})`} onFocus={() => { setActiveId(id); setTooltipIdState(id); }} onPointerEnter={() => { setActiveId(id); setTooltipIdState(id); }} onPointerLeave={(event) => { if (document.activeElement !== event.currentTarget) setTooltipIdState(null); }} onKeyDown={(event) => { if (event.key === "ArrowRight" || event.key === "ArrowDown") { event.preventDefault(); navigate(visibleIndex, 1); } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") { event.preventDefault(); navigate(visibleIndex, -1); } }}><LegacyShotShape shot={shot}/><circle r="12" fill="transparent" pointerEvents="all" /></g>; })}</g>
        </svg>
        {tooltipEntry && <div id={tooltipId} role="tooltip" className="pointer-events-none absolute z-10 max-w-36 rounded border border-white/20 bg-[#0b0e0f]/95 px-2 py-1 text-[11px] text-zinc-100 shadow-lg" style={{ left: `${Math.max(4, Math.min(96, ((tooltipEntry.shot.x + 4) / 108) * 100))}%`, top: `${Math.max(4, Math.min(96, 100 - tooltipEntry.shot.y))}%`, transform: "translate(-50%, -110%)" }}><b className="block">{outcomePresentation[tooltipEntry.shot.outcome].label}</b><span className="block">xG {formatShotMetric(tooltipEntry.shot.xg)}</span><span className="block">xGOT {formatShotMetric(tooltipEntry.shot.xgot)}</span></div>}
      </div>
      <figcaption id={captionId} className="mt-2 text-xs text-zinc-400">{state.heat}. {state.shots}. Goal ◇ · on target ● · off target × · blocked ■.</figcaption>
    </figure>
    {showCounts && integrity.shots && <ul className="mt-2 flex flex-wrap gap-x-3 text-xs text-zinc-400"><li>Goals {counts.goal}</li><li>On target {counts.on_target}</li><li>Off target {counts.off_target}</li><li>Blocked {counts.blocked}</li></ul>}
  </>;
}

export function LegacySpatialPitch({ analysis, contextIdentity = "" }: { analysis?: PlayerAnalysis; contextIdentity?: string }) {
  const controller = useShotOutcomeVisibility(analysis?.spatial, contextIdentity);
  const rawId = useId().replace(/:/g, ""), markerLayerId = `legacy-shot-markers-${rawId}`;
  return <section className={panel} aria-labelledby={`spatial-pitch-${rawId}`}><h2 id={`spatial-pitch-${rawId}`} className="text-sm font-black">Spatial pitch</h2>
    {controller.integrity && controller.presentOutcomes.length > 0 && <OutcomeControls outcomes={controller.presentOutcomes} counts={controller.counts} visible={controller.visibleOutcomes} markerLayerId={markerLayerId} onClick={controller.onClick} onDoubleClick={controller.onDoubleClick}/>}<p role="status" aria-live="polite" className="sr-only">Visible shot outcomes: {outcomeSummary(controller.presentOutcomes.filter((outcome) => controller.visibleOutcomes.has(outcome)))}.</p><div className="mt-3"><LegacySpatialPitchFigure analysis={analysis} visibleOutcomes={controller.visibleOutcomes} markerLayerId={markerLayerId}/></div>
  </section>;
}
