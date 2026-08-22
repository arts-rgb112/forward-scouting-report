import { useEffect, useMemo, useRef } from "react";

import type { PlayerAnalysis } from "../dashboard/types";
import { legacyDensityGrid, marchingSquares, normalizeDensity, renderLegacyHeatmap, type ActivityPoint } from "./legacyHeatmap";

const panel = "min-w-0 rounded-xl border border-white/10 bg-[#101415] p-4 shadow-sm";
type Spatial = NonNullable<PlayerAnalysis["spatial"]>;
type Shot = Spatial["shotmapPoints"][number];
type Integrity = { heat: boolean; shots: boolean };

const validPoint = (point: ActivityPoint) => Number.isFinite(point.x) && Number.isFinite(point.y) && point.x >= 0 && point.x <= 100 && point.y >= 0 && point.y <= 100;
const spatialIntegrity = (spatial: Spatial | undefined): Integrity => ({
  heat: Boolean(spatial?.available && spatial.heatmapPointCount === spatial.heatmapPoints.length && spatial.heatmapPoints.every(validPoint)),
  shots: Boolean(spatial?.shotmapSnapshotAvailable && spatial.shotmapPointCount === spatial.shotmapPoints.length && spatial.shotmapPoints.every(validPoint)),
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
      // Resetting the backing store guarantees that a previously painted
      // raster cannot survive a populated -> unavailable/invalid/zero switch.
      canvas.width = 0;
      canvas.height = 0;
      paintedRef.current = false;
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
      context.clearRect(0, 0, width, height);
      renderLegacyHeatmap(context, width, height, normalized);
      paintedRef.current = true;
    };
    draw();
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(draw);
    observer?.observe(canvas);
    window.addEventListener("resize", draw);
    return () => { observer?.disconnect(); window.removeEventListener("resize", draw); };
  }, [enabled, normalized, points.length]);
  return <canvas ref={canvasRef} aria-hidden="true" className="pointer-events-none absolute inset-0 h-full w-full" data-layer="legacy-density" />;
}

function marker(shot: Shot, index: number) {
  const x = shot.x, y = 100 - shot.y;
  const common = { "data-shot-index": index, "data-shot-outcome": shot.outcome };
  if (shot.outcome === "goal") return <g key={index} {...common}><path d={`M${x} ${y - 1.8}L${x + 1.8} ${y}L${x} ${y + 1.8}L${x - 1.8} ${y}Z`} fill="none" stroke="#F8FAFC" strokeWidth="1.25"/></g>;
  if (shot.outcome === "on_target") return <g key={index} {...common}><circle cx={x} cy={y} r="1.7" fill="#22D3EE" stroke="#111827" strokeWidth="1.2"/></g>;
  if (shot.outcome === "off_target") return <g key={index} {...common}><path d={`M${x - 1.7} ${y - 1.7}L${x + 1.7} ${y + 1.7}M${x + 1.7} ${y - 1.7}L${x - 1.7} ${y + 1.7}`} fill="none" stroke="#FB923C" strokeWidth="1.15"/></g>;
  return <g key={index} {...common}><rect x={x - 1.4} y={y - 1.4} width="2.8" height="2.8" fill="#A3A3A3" stroke="#111827" strokeWidth=".8"/></g>;
}

function states(spatial: Spatial | undefined, integrity: Integrity) {
  const heat = !spatial?.available ? "Activity heatmap unavailable" : !integrity.heat ? "Activity heatmap integrity mismatch" : spatial.heatmapPoints.length ? `${spatial.heatmapPoints.length} activity points` : "Verified zero activity points";
  const shots = !spatial?.shotmapSnapshotAvailable ? "Shot snapshot unavailable" : !integrity.shots ? "Shot snapshot integrity mismatch" : spatial.shotmapPoints.length ? `${spatial.shotmapPoints.length} shots` : "Verified zero shots";
  return { heat, shots };
}

export function LegacySpatialPitch({ analysis }: { analysis?: PlayerAnalysis }) {
  const spatial = analysis?.spatial;
  const integrity = spatialIntegrity(spatial);
  const state = states(spatial, integrity);
  const normalized = useMemo(() => integrity.heat ? normalizeDensity(legacyDensityGrid(spatial!.heatmapPoints)) : undefined, [integrity.heat, spatial?.heatmapPoints]);
  const contour = useMemo(() => normalized && spatial?.continuousCore.available && spatial.continuousCore.thresholdOfPeak > 0 ? marchingSquares(normalized, spatial.continuousCore.thresholdOfPeak) : [], [normalized, spatial?.continuousCore.available, spatial?.continuousCore.thresholdOfPeak]);
  const counts = { goal: 0, on_target: 0, off_target: 0, blocked: 0 };
  if (integrity.shots) spatial!.shotmapPoints.forEach((shot) => { counts[shot.outcome] += 1; });
  const showCountLine = integrity.shots;
  const description = `Legacy spatial pitch. ${state.heat}. ${state.shots}.`;
  return <section className={panel} aria-labelledby="spatial-pitch-heading"><h2 id="spatial-pitch-heading" className="text-sm font-black">Spatial pitch</h2>
    <figure className="mt-3" aria-describedby="spatial-pitch-caption">
      <div className="relative isolate w-full overflow-hidden rounded bg-[#063525]" style={{ aspectRatio: "108 / 70.9" }}>
        <svg viewBox="-4 0 108 100" preserveAspectRatio="none" role="img" aria-label={description} className="absolute inset-0 h-full w-full" data-layer="legacy-pitch"><image href="/assets/positional-grid-pitch.webp" x="-10.52" y="-5" width="121.17" height="110" preserveAspectRatio="none" /></svg>
        <HeatmapCanvas points={integrity.heat ? spatial!.heatmapPoints : []} enabled={integrity.heat && spatial!.heatmapPoints.length > 0}/>
        <svg viewBox="-4 0 108 100" preserveAspectRatio="none" aria-hidden="true" className="pointer-events-none absolute inset-0 h-full w-full" data-layer="legacy-events">
          {contour.length > 0 && <path data-layer="cca-contour" d={contour.map(([x1, y1, x2, y2]) => `M${x1.toFixed(4)} ${y1.toFixed(4)}L${x2.toFixed(4)} ${y2.toFixed(4)}`).join("")} fill="none" stroke="#C044FF" strokeWidth="3" vectorEffect="non-scaling-stroke"/>}
          {integrity.shots && spatial!.shotmapPoints.map(marker)}
        </svg>
      </div>
      <figcaption id="spatial-pitch-caption" className="mt-2 text-xs text-zinc-400">{state.heat}. {state.shots}. Goal ◇ · on target ● · off target × · blocked ■.</figcaption>
    </figure>
    {showCountLine && <ul className="mt-2 flex flex-wrap gap-x-3 text-xs text-zinc-400"><li>Goals {counts.goal}</li><li>On target {counts.on_target}</li><li>Off target {counts.off_target}</li><li>Blocked {counts.blocked}</li></ul>}
  </section>;
}
