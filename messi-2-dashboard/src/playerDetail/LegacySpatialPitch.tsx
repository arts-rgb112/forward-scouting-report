import { useEffect, useId, useMemo, useRef, useState } from "react";

import type { PlayerAnalysis } from "../dashboard/types";
import { legacyDensityGrid, marchingSquares, normalizeDensity, renderLegacyHeatmap, type ActivityPoint } from "./legacyHeatmap";

const panel = "min-w-0 rounded-xl border border-white/10 bg-[#101415] p-4 shadow-sm";
type Spatial = NonNullable<PlayerAnalysis["spatial"]>;
type Shot = Spatial["shotmapPoints"][number];
type ShotOutcome = Shot["outcome"];
type Integrity = { heat: boolean; shots: boolean };

const outcomeOrder: readonly ShotOutcome[] = ["goal", "on_target", "off_target", "blocked"];
const outcomePresentation: Record<ShotOutcome, { label: string; color: string; symbol: string; size: number }> = {
  goal: { label: "Goals", color: "#F8FAFC", symbol: "star", size: 12 },
  on_target: { label: "On target", color: "#22D3EE", symbol: "circle", size: 9 },
  off_target: { label: "Off target", color: "#FB923C", symbol: "x", size: 9 },
  blocked: { label: "Blocked", color: "#A3A3A3", symbol: "diamond-open", size: 8 },
};
const singleClickDelayMs = 350;

const validPoint = (point: ActivityPoint) => Number.isFinite(point.x) && Number.isFinite(point.y) && point.x >= 0 && point.x <= 100 && point.y >= 0 && point.y <= 100;
const isShotOutcome = (value: unknown): value is ShotOutcome => typeof value === "string" && (outcomeOrder as readonly string[]).includes(value);
const validShot = (shot: Shot) => validPoint(shot) && isShotOutcome(shot.outcome);
const formatMetric = (value: number | null | undefined) => Number.isFinite(value) ? Number(value).toFixed(2) : "—";
const outcomeSummary = (outcomes: readonly ShotOutcome[]) => outcomes.length ? outcomes.map((outcome) => outcomePresentation[outcome].label).join(", ") : "none";
const markerLabel = (shot: Shot) => `${outcomePresentation[shot.outcome].label}. xG ${formatMetric(shot.xg)}. xGOT ${formatMetric(shot.xgot)}.`;

const spatialIntegrity = (spatial: Spatial | undefined): Integrity => ({
  heat: Boolean(spatial?.available && spatial.heatmapPointCount === spatial.heatmapPoints.length && spatial.heatmapPoints.every(validPoint)),
  shots: Boolean(spatial?.shotmapSnapshotAvailable && spatial.shotmapPointCount === spatial.shotmapPoints.length && spatial.shotmapPoints.every(validShot)),
});

function snapshotIdentity(contextIdentity: string, spatial: Spatial | undefined) {
  if (!spatial) return `${contextIdentity}|no-spatial`;
  return `${contextIdentity}|${spatial.shotmapSnapshotAvailable}|${spatial.shotmapPointCount}|${spatial.shotmapPoints.map((shot) => `${shot.x},${shot.y},${shot.outcome},${shot.xg ?? "—"},${shot.xgot ?? "—"}`).join(";")}`;
}

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

function starPath(outer: number, inner: number) {
  return Array.from({ length: 10 }, (_, index) => {
    const angle = -Math.PI / 2 + index * Math.PI / 5;
    const radius = index % 2 === 0 ? outer : inner;
    return `${index === 0 ? "M" : "L"}${(Math.cos(angle) * radius).toFixed(3)} ${(Math.sin(angle) * radius).toFixed(3)}`;
  }).join("") + "Z";
}

function ShotMarker({ shot, index, id, markerScale, active, tooltipId, registerRef, onActivate, onDeactivate, onNavigate }: {
  shot: Shot; index: number; id: string; markerScale: { x: number; y: number }; active: boolean; tooltipId: string;
  registerRef(element: SVGGElement | null): void; onActivate(id: string): void; onDeactivate(id: string): void; onNavigate(index: number, direction: 1 | -1): void;
}) {
  const { color, symbol, size } = outcomePresentation[shot.outcome];
  const visual = shot.outcome === "goal"
    ? <path d={starPath(size / 2, size / 4.25)} fill={color} stroke="#111827" strokeWidth="1.2" />
    : shot.outcome === "on_target"
      ? <circle r={size / 2} fill={color} stroke="#111827" strokeWidth="1.2" />
      : shot.outcome === "off_target"
        ? <path d={`M${-size / 2} ${-size / 2}L${size / 2} ${size / 2}M${size / 2} ${-size / 2}L${-size / 2} ${size / 2}`} fill="none" stroke={color} strokeWidth="1.2" />
        : <path d={`M0 ${-size / 2}L${size / 2} 0L0 ${size / 2}L${-size / 2} 0Z`} fill="none" stroke={color} strokeWidth="1.2" />;
  return <g ref={registerRef} id={id} role="img" tabIndex={active ? 0 : -1} aria-label={markerLabel(shot)} aria-describedby={tooltipId} data-shot-index={index} data-shot-outcome={shot.outcome} data-marker-symbol={symbol} data-marker-size={size}
    transform={`translate(${shot.x} ${100 - shot.y}) scale(${markerScale.x} ${markerScale.y})`}
    onFocus={() => onActivate(id)} onPointerEnter={() => onActivate(id)} onPointerMove={() => onActivate(id)} onPointerLeave={(event) => { if (document.activeElement !== event.currentTarget) onDeactivate(id); }}
    onKeyDown={(event) => { if (event.key === "ArrowRight" || event.key === "ArrowDown") { event.preventDefault(); onNavigate(index, 1); } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") { event.preventDefault(); onNavigate(index, -1); } }}>
    {visual}<circle r="12" fill="transparent" pointerEvents="all" />
  </g>;
}

function OutcomeControls({ outcomes, counts, visible, markerLayerId, onClick, onDoubleClick }: {
  outcomes: readonly ShotOutcome[]; counts: Record<ShotOutcome, number>; visible: ReadonlySet<ShotOutcome>; markerLayerId: string;
  onClick(outcome: ShotOutcome, detail: number): void; onDoubleClick(outcome: ShotOutcome): void;
}) {
  return <div role="group" aria-label="Shot outcome visibility" className="mt-3 grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
    {outcomes.map((outcome) => { const item = outcomePresentation[outcome]; const pressed = visible.has(outcome); return <button key={outcome} type="button" aria-pressed={pressed} aria-controls={markerLayerId} aria-label={`${item.label}, ${counts[outcome]} shots. ${pressed ? "Visible" : "Hidden"}. Click to show or hide; double-click to isolate.`}
      onClick={(event) => onClick(outcome, event.detail)} onDoubleClick={() => onDoubleClick(outcome)}
      className={`inline-flex min-h-11 min-w-11 items-center justify-center gap-2 rounded border px-3 text-xs font-bold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lime-300 ${pressed ? "border-white/30 bg-white/10 text-zinc-100" : "border-white/10 bg-black/20 text-zinc-500"}`}>
      <span aria-hidden="true" className="font-mono" style={{ color: item.color }}>{outcome === "goal" ? "★" : outcome === "on_target" ? "●" : outcome === "off_target" ? "×" : "◇"}</span><span>{item.label} {counts[outcome]}</span>
    </button>; })}
  </div>;
}

function states(spatial: Spatial | undefined, integrity: Integrity) {
  const heat = !spatial?.available ? "Activity heatmap unavailable" : !integrity.heat ? "Activity heatmap integrity mismatch" : spatial.heatmapPoints.length ? `${spatial.heatmapPoints.length} activity points` : "Verified zero activity points";
  const shots = !spatial?.shotmapSnapshotAvailable ? "Shot snapshot unavailable" : !integrity.shots ? "Shot snapshot integrity mismatch" : spatial.shotmapPoints.length ? `${spatial.shotmapPoints.length} shots` : "Verified zero shots";
  return { heat, shots };
}

export function LegacySpatialPitch({ analysis, contextIdentity = "" }: { analysis?: PlayerAnalysis; contextIdentity?: string }) {
  const spatial = analysis?.spatial;
  const integrity = spatialIntegrity(spatial);
  const state = states(spatial, integrity);
  const baseId = useId();
  const markerLayerId = `${baseId}-shot-markers`;
  const descriptionId = `${baseId}-shot-description`;
  const tooltipId = `${baseId}-shot-tooltip`;
  const identity = snapshotIdentity(contextIdentity, spatial);
  const pendingSingleClick = useRef<{ outcome: ShotOutcome; timer: number } | null>(null);
  const identityRef = useRef(identity);
  identityRef.current = identity;
  const markerRefs = useRef(new Map<string, SVGGElement>());
  const markerScale = useMarkerScale();
  const normalized = useMemo(() => integrity.heat ? normalizeDensity(legacyDensityGrid(spatial!.heatmapPoints)) : undefined, [integrity.heat, spatial?.heatmapPoints]);
  const contour = useMemo(() => normalized && spatial?.continuousCore.available && spatial.continuousCore.thresholdOfPeak > 0 ? marchingSquares(normalized, spatial.continuousCore.thresholdOfPeak) : [], [normalized, spatial?.continuousCore.available, spatial?.continuousCore.thresholdOfPeak]);
  const counts: Record<ShotOutcome, number> = { goal: 0, on_target: 0, off_target: 0, blocked: 0 };
  if (integrity.shots) spatial!.shotmapPoints.forEach((shot) => { counts[shot.outcome] += 1; });
  const presentOutcomes = outcomeOrder.filter((outcome) => counts[outcome] > 0);
  const [visibility, setVisibility] = useState<{ identity: string; visible: ReadonlySet<ShotOutcome> }>({ identity: "", visible: new Set() });
  const [activeMarkerId, setActiveMarkerId] = useState<string | null>(null);
  const [tooltipMarkerId, setTooltipMarkerId] = useState<string | null>(null);
  const visibleOutcomes = visibility.identity === identity ? visibility.visible : new Set(presentOutcomes);
  const visibleShots = integrity.shots ? spatial!.shotmapPoints.filter((shot) => visibleOutcomes.has(shot.outcome)) : [];
  const activeVisibleId = visibleShots.some((_shot, index) => `${baseId}-shot-${index}` === activeMarkerId) ? activeMarkerId : visibleShots.length ? `${baseId}-shot-0` : null;
  const tooltipShot = visibleShots.find((_shot, index) => `${baseId}-shot-${index}` === tooltipMarkerId) ?? null;
  const updateVisibility = (transform: (current: ReadonlySet<ShotOutcome>) => ReadonlySet<ShotOutcome>) => setVisibility((current) => current.identity === identity ? { identity, visible: transform(current.visible) } : current);
  const toggleOutcome = (outcome: ShotOutcome) => updateVisibility((current) => { const next = new Set(current); next.has(outcome) ? next.delete(outcome) : next.add(outcome); return next; });
  const isolateOutcome = (outcome: ShotOutcome) => updateVisibility(() => new Set([outcome]));
  const cancelPendingClick = () => {
    const pending = pendingSingleClick.current;
    if (pending) { window.clearTimeout(pending.timer); pendingSingleClick.current = null; }
  };
  const commitPendingClick = () => {
    const pending = pendingSingleClick.current;
    cancelPendingClick();
    if (pending) toggleOutcome(pending.outcome);
  };
  useEffect(() => {
    cancelPendingClick(); setVisibility({ identity, visible: new Set(presentOutcomes) }); setActiveMarkerId(null); setTooltipMarkerId(null);
    return cancelPendingClick;
  // The serialised source snapshot resets interaction state even when its context is unchanged.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identity]);
  const handleControlClick = (outcome: ShotOutcome, detail: number) => {
    const pending = pendingSingleClick.current;
    if (detail === 0) { commitPendingClick(); toggleOutcome(outcome); return; }
    if (pending?.outcome === outcome) { cancelPendingClick(); return; }
    if (pending) commitPendingClick();
    const pendingIdentity = identity;
    const timer = window.setTimeout(() => {
      if (pendingSingleClick.current?.timer !== timer) return;
      pendingSingleClick.current = null;
      if (identityRef.current === pendingIdentity) toggleOutcome(outcome);
    }, singleClickDelayMs);
    pendingSingleClick.current = { outcome, timer };
  };
  const navigateMarker = (currentIndex: number, direction: 1 | -1) => {
    if (!visibleShots.length) return;
    const nextIndex = (currentIndex + direction + visibleShots.length) % visibleShots.length;
    const id = `${baseId}-shot-${nextIndex}`;
    setActiveMarkerId(id); setTooltipMarkerId(id); markerRefs.current.get(id)?.focus();
  };
  const visibleOutcomeList = presentOutcomes.filter((outcome) => visibleOutcomes.has(outcome));
  const description = `Legacy spatial pitch. ${state.heat}. ${state.shots}. Visible shot outcomes: ${outcomeSummary(visibleOutcomeList)}. Outcome controls change markers only; density and CCA use all activity points.`;
  return <section className={panel} aria-labelledby="spatial-pitch-heading"><h2 id="spatial-pitch-heading" className="text-sm font-black">Spatial pitch</h2>
    {integrity.shots && presentOutcomes.length > 0 && <OutcomeControls outcomes={presentOutcomes} counts={counts} visible={visibleOutcomes} markerLayerId={markerLayerId} onClick={handleControlClick} onDoubleClick={(outcome) => { const pending = pendingSingleClick.current; if (pending?.outcome === outcome) cancelPendingClick(); else if (pending) commitPendingClick(); isolateOutcome(outcome); }} />}
    <p role="status" aria-live="polite" className="sr-only">Visible shot outcomes: {outcomeSummary(presentOutcomes.filter((outcome) => visibleOutcomes.has(outcome)))}.</p>
    <figure className="mt-3" aria-describedby={`${descriptionId} spatial-pitch-caption`}>
      <p id={descriptionId} className="sr-only">{description}</p>
      <div ref={markerScale.ref} className="relative isolate w-full overflow-hidden rounded bg-[#063525]" style={{ aspectRatio: "108 / 70.9" }}>
        <svg viewBox="-4 0 108 100" preserveAspectRatio="none" role="img" aria-label={description} className="absolute inset-0 h-full w-full" data-layer="legacy-pitch"><image href="/assets/positional-grid-pitch.webp" x="-10.52" y="-5" width="121.17" height="110" preserveAspectRatio="none" /></svg>
        <HeatmapCanvas points={integrity.heat ? spatial!.heatmapPoints : []} enabled={integrity.heat && spatial!.heatmapPoints.length > 0}/>
        <svg viewBox="-4 0 108 100" preserveAspectRatio="none" role="group" aria-label="Interactive shot outcome markers" className="absolute inset-0 h-full w-full" data-layer="legacy-events">
          {contour.length > 0 && <path aria-hidden="true" pointerEvents="none" data-layer="cca-contour" d={contour.map(([x1, y1, x2, y2]) => `M${x1.toFixed(4)} ${y1.toFixed(4)}L${x2.toFixed(4)} ${y2.toFixed(4)}`).join("")} fill="none" stroke="#C044FF" strokeWidth="3" vectorEffect="non-scaling-stroke"/>}
          <g id={markerLayerId}>{visibleShots.map((shot, index) => { const id = `${baseId}-shot-${index}`; return <ShotMarker key={`${shot.outcome}-${shot.x}-${shot.y}-${index}`} shot={shot} index={index} id={id} markerScale={markerScale} active={id === activeVisibleId} tooltipId={tooltipId} registerRef={(element) => { if (element) markerRefs.current.set(id, element); else markerRefs.current.delete(id); }} onActivate={(markerId) => { setActiveMarkerId(markerId); setTooltipMarkerId(markerId); }} onDeactivate={(markerId) => { if (tooltipMarkerId === markerId) setTooltipMarkerId(null); }} onNavigate={navigateMarker}/>; })}</g>
        </svg>
        {tooltipShot && <div id={tooltipId} role="tooltip" className="pointer-events-none absolute z-10 max-w-36 rounded border border-white/20 bg-[#0b0e0f]/95 px-2 py-1 text-[11px] text-zinc-100 shadow-lg" style={{ left: `${Math.max(4, Math.min(96, ((tooltipShot.x + 4) / 108) * 100))}%`, top: `${Math.max(4, Math.min(96, 100 - tooltipShot.y))}%`, transform: "translate(-50%, -110%)" }}><b className="block">{outcomePresentation[tooltipShot.outcome].label}</b><span className="block">xG {formatMetric(tooltipShot.xg)}</span><span className="block">xGOT {formatMetric(tooltipShot.xgot)}</span></div>}
      </div>
      <figcaption id="spatial-pitch-caption" className="mt-2 text-xs text-zinc-400">{state.heat}. {state.shots}. Goal ◇ · on target ● · off target × · blocked ■.</figcaption>
    </figure>
    {integrity.shots && <ul className="mt-2 flex flex-wrap gap-x-3 text-xs text-zinc-400"><li>Goals {counts.goal}</li><li>On target {counts.on_target}</li><li>Off target {counts.off_target}</li><li>Blocked {counts.blocked}</li></ul>}
  </section>;
}
