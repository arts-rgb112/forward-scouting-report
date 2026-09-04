import { lazy, Suspense, useEffect, useId, useMemo, useState } from "react";

import type { FullActivityHeatmapData } from "../api/fullActivityHeatmapContracts";
import type { PlayerAnalysis, ShotmapPoint } from "../dashboard/types";
import { LegacySpatialPitchFigure } from "./LegacySpatialPitch";
import { DEFAULT_PITCH_LAYERS, type PitchLayerVisibility } from "./pitchLayers";
import { usePitchPenalty } from "./PitchPenaltyContext";
import { excludePenaltyShots } from "./pitchPenalties";
import { outcomeSummary, OutcomeControls, useShotOutcomeVisibility } from "./shotOutcomeVisibility";

const WebGLSpatialPitch = lazy(() => import("./WebGLSpatialPitch").then((module) => ({ default: module.WebGLSpatialPitch })));

const panel = "min-w-0 rounded-xl border border-white/10 bg-[#101415] p-4 shadow-sm";
const PITCH_VIEW_COPY = { perspective: "3D 회랑", plan: "2D 회랑" } as const;

export type ViewMode = "perspective" | "plan";
function usePrefersReducedMotion() {
  const query = "(prefers-reduced-motion: reduce)";
  const read = () => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(query).matches;
  const [reduced, setReduced] = useState(read);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const media = window.matchMedia(query);
    const update = () => setReduced(media.matches);
    update();
    media.addEventListener?.("change", update);
    return () => media.removeEventListener?.("change", update);
  }, []);
  return reduced;
}

const outcomeLabel: Record<ShotmapPoint["outcome"], string> = { goal: "득점", on_target: "유효 슛", off_target: "빗나감", blocked: "블록" };

export function SpatialPitch({ analysis, contextIdentity = "", forcedMode, embedded = false, layers = DEFAULT_PITCH_LAYERS, fullActivityHeatmap }: {
  analysis?: PlayerAnalysis;
  contextIdentity?: string;
  forcedMode?: ViewMode;
  embedded?: boolean;
  layers?: PitchLayerVisibility;
  fullActivityHeatmap?: FullActivityHeatmapData;
}) {
  const reducedMotion = usePrefersReducedMotion();
  const { includePenalties } = usePitchPenalty();
  const [manualMode, setManualMode] = useState<ViewMode | null>(null);
  const mode = manualMode ?? forcedMode ?? (reducedMotion ? "plan" : "perspective");
  const spatial = analysis?.spatial;
  const displaySpatial = useMemo(() => {
    if (!spatial || includePenalties) return spatial;
    const shotmapPoints = [...excludePenaltyShots(spatial.shotmapPoints, false)];
    return { ...spatial, shotmapPoints, shotmapPointCount: shotmapPoints.length };
  }, [includePenalties, spatial]);
  const displayAnalysis = useMemo(() => !analysis || !displaySpatial ? analysis : { ...analysis, spatial: displaySpatial }, [analysis, displaySpatial]);
  const controller = useShotOutcomeVisibility(displaySpatial, contextIdentity);
  const heatState = fullActivityHeatmap?.available ? `full Tier 3 활동 좌표 ${fullActivityHeatmap.validPointCount}개` : "full Tier 3 활동 히트맵 사용 불가";
  const shotState = !displaySpatial?.shotmapSnapshotAvailable ? "슈팅 스냅샷 사용 불가" : !controller.integrity ? "슈팅 스냅샷 무결성 불일치" : displaySpatial.shotmapPoints.length ? `슛 ${displaySpatial.shotmapPoints.length}개` : "관측된 슛 0개";
  const activitySentence = `${heatState} · 전술 구획은 시각 안내선이며 브라우저에서 점수나 구역 값을 새로 계산하지 않습니다.`;
  const shotSentence = `${shotState} · 데이터 없음과 관측된 0은 구분합니다.`;
  const rawId = useId().replace(/:/g, "");
  const markerLayerId = `spatial-shot-markers-${rawId}`;
  const visibleOutcomes = controller.presentOutcomes.filter((outcome) => controller.visibleOutcomes.has(outcome));

  return <section className={embedded ? "min-w-0" : panel} aria-labelledby={embedded ? undefined : `spatial-pitch-${rawId}`} aria-label={embedded ? PITCH_VIEW_COPY[mode] : undefined}>
    {!embedded && <div className="flex flex-wrap items-start justify-between gap-3"><div><h2 id={`spatial-pitch-${rawId}`} className="text-sm font-black">{PITCH_VIEW_COPY[mode]}</h2><p className="mt-1 type-caption text-zinc-400">공격 방향 왼쪽 → 오른쪽 · 오른쪽 외곽이 가까운 터치라인 · 동일 6레인 좌표계</p></div>{!forcedMode && <div role="group" aria-label="피치 보기" className="flex rounded-lg border border-white/15 bg-black/30 p-1"><button type="button" aria-pressed={mode === "perspective"} onClick={() => setManualMode("perspective")} className="min-h-9 rounded px-3 text-base font-bold aria-pressed:bg-orange-400 aria-pressed:text-zinc-950 focus-visible:ring-2 focus-visible:ring-orange-200">3D 회랑</button><button type="button" aria-pressed={mode === "plan"} onClick={() => setManualMode("plan")} className="min-h-9 rounded px-3 text-base font-bold aria-pressed:bg-orange-400 aria-pressed:text-zinc-950 focus-visible:ring-2 focus-visible:ring-orange-200">2D 회랑</button></div>}</div>}
    {reducedMotion && manualMode === null && <p className="mt-2 text-base text-zinc-400">Reduced-motion preference detected; the 2D plan fallback is active.</p>}
    {layers.markers && controller.integrity && controller.presentOutcomes.length > 0 && <OutcomeControls outcomes={controller.presentOutcomes} counts={controller.counts} visible={controller.visibleOutcomes} markerLayerId={markerLayerId} onClick={controller.onClick} onDoubleClick={controller.onDoubleClick} showCounts={false} />}
    <p role="status" aria-live="polite" className="sr-only">표시 중인 슈팅 결과: {outcomeSummary(visibleOutcomes)}.</p>
    <div className="mt-3 min-w-0 overflow-hidden rounded-lg border border-white/10">{mode === "plan" ? <LegacySpatialPitchFigure analysis={displayAnalysis} visibleOutcomes={controller.visibleOutcomes} markerLayerId={markerLayerId} showCounts={false} layers={layers} corridors /> : <figure><Suspense fallback={<div role="status" className="grid min-h-80 place-items-center bg-[#050a08] text-sm font-bold text-zinc-200">WebGL 렌더러 로딩…</div>}><WebGLSpatialPitch spatial={displaySpatial} visibleOutcomes={controller.visibleOutcomes} markerLayerId={markerLayerId} contextIdentity={contextIdentity} layers={layers} fullActivityHeatmap={fullActivityHeatmap} /></Suspense><figcaption className="border-t border-white/10 bg-black/25 px-3 py-2 text-base text-zinc-300">{heatState} · {shotState} · CCA는 기존 점수 스냅샷 32×22, 표시 히트맵은 full Tier 3 32×22 원천을 사용합니다.</figcaption></figure>}</div>
    <div className="mt-3 space-y-2 text-base leading-5 text-zinc-400" aria-live="polite">
      <p data-spatial-activity-note>{activitySentence}</p>
      <p data-spatial-shot-note>{shotSentence}</p>
    </div>
    <details className="mt-3 rounded-lg border border-white/10 bg-black/20 text-base text-zinc-300"><summary className="min-h-11 cursor-pointer px-3 py-3 font-bold focus-visible:ring-2 focus-visible:ring-orange-200">피치와 슈팅 상세</summary><div className="border-t border-white/10 p-3"><p>3D와 2D 회랑은 동일한 서버 좌표계와 레인 경계를 사용합니다.</p>{!controller.integrity ? <p className="mt-3">슈팅 이벤트 상세를 제공할 수 없습니다.</p> : displaySpatial!.shotmapPoints.length === 0 ? <p className="mt-3">관측된 슈팅 이벤트가 0건입니다.</p> : <ol aria-label="서버 슈팅 이벤트" className="mt-3 max-h-48 space-y-1 overflow-y-auto pr-1">{displaySpatial!.shotmapPoints.map((shot, index) => <li key={index} className="rounded bg-white/5 px-2 py-1">{index + 1}. {outcomeLabel[shot.outcome]} · xG {shot.xg == null ? "미상" : shot.xg.toFixed(2)} · xGOT {shot.xgot == null ? "미상" : shot.xgot.toFixed(2)} · ({shot.x.toFixed(1)}, {shot.y.toFixed(1)})</li>)}</ol>}</div></details>
  </section>;
}
