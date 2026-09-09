import { useEffect, useRef, useState } from "react";

import type { MessiApiConfig } from "../api/env";
import type { DuelPressV2DetailMetrics } from "../api/duelPressV2Contracts";
import { boxSubregionResourceKey } from "../api/boxSubregionApi";
import type { DatasetRouteState, Player, PlayerAnalysis } from "../dashboard/types";
import { dashboardQueryKeys, datasetHref, preserveExternalQuery } from "../dashboard/datasetRoute";
import { DEFAULT_PITCH_LAYERS } from "./pitchLayers";
import { PitchPenaltyToggle } from "./PitchPenaltyContext";
import { ArenaProfileHud, OverviewCategoryVector, OverviewSeasonRail, type PlayerOverviewHistory } from "./PlayerOverview";
import { SpatialPitch, type ArenaPitchSelection } from "./SpatialPitch";
import { useBoxSubregionStats } from "./useBoxSubregionStats";
import { useFullActivityDisplay } from "./useFullActivityDisplay";
import { useNativePitchEventsV2 } from "./useNativePitchEventsV2";

type OverviewReadoutState = "loading" | "error" | "unavailable" | "ready";

/** The stage only composes already-loaded player detail data with three
 * source-specific pitch hooks. It never calls fetchPlayerDetail or makes a
 * client-side aggregate; hooks retain their own context keys/cancellation. */
function PlayerArenaBody({ player, analysis, history, config, dataset, data, categoryState }: PlayerArenaStageProps) {
  const contextIdentity = `${player.id}|${dataset.season}|${dataset.mode}|${dataset.scope}|${dataset.competition}`;
  const activity = useFullActivityDisplay(config, player.id, dataset);
  const requestedBoxKey = boxSubregionResourceKey(player.id, dataset);
  const boxSubregionState = useBoxSubregionStats(config, player.id, dataset);
  // The shared hook changes its state after effects run. Never let an A
  // response reach a B arena for that initial render frame.
  const boxSubregion = boxSubregionState.key === requestedBoxKey
    ? boxSubregionState
    : { kind: "loading" as const, key: requestedBoxKey };
  const nativePitchEvents = useNativePitchEventsV2(config, player.id, dataset);
  const [selection, setSelection] = useState<ArenaPitchSelection>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const modeButton = useRef<HTMLButtonElement>(null);
  useEffect(() => setSelection(null), [contextIdentity]);
  const authoritative = data?.ratingVersion === "messi-score-unified-v3" ? data : undefined;
  const state: OverviewReadoutState = authoritative ? "ready" : data ? "unavailable" : categoryState ?? "unavailable";
  const display = "data" in activity ? activity.data : undefined;
  const heatmap = display?.fullHeat;
  // Selected records retain the renderer's real NativePitchSelectionCard /
  // box card. The stage only removes the default category HUD while that
  // one factual selection dock is visible.
  const selectionHud = selection ? null : <OverviewCategoryVector categories={authoritative?.categories} state={state} />;

  const comparisonBase = preserveExternalQuery(datasetHref("/compare", dataset), window.location.search, dashboardQueryKeys);
  const taxonomy = new URLSearchParams(window.location.search).get("taxonomy");
  const comparisonHref = taxonomy === "duel-press-v1" || taxonomy === "duel-press-v2"
    ? `${comparisonBase}&taxonomy=${taxonomy}` : comparisonBase;
  return <section data-layout="player-arena-stage" data-view={detailOpen ? "detail" : "overview"} aria-label="선수 피치 아레나" className="relative isolate min-w-0 overflow-hidden rounded-[1.5rem] border border-[#464a4c] bg-[#181a1b] shadow-[0_24px_60px_rgba(0,0,0,.28)]">
    <div className="relative z-30 flex items-center justify-between gap-3 border-b border-white/10 bg-[#232628]/90 px-4 py-3 text-zinc-200">
      <span className="text-sm tracking-[.12em]">{detailOpen ? "피치 분석" : "선수 인사이트"}</span>
      <button ref={modeButton} type="button" aria-expanded={detailOpen} onClick={() => { setDetailOpen((open) => !open); modeButton.current?.focus(); }} className="min-h-11 rounded-full border border-white/25 px-5 text-sm font-semibold hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#e78b84]">{detailOpen ? "요약으로 돌아가기" : "상세 분석"}<span aria-hidden="true" className="ml-3">{detailOpen ? "↗" : "↘"}</span></button>
    </div>
    <div data-layout="arena-stage-content" className="relative">
    <div aria-hidden={!detailOpen} inert={!detailOpen} className={detailOpen ? "relative" : "pointer-events-none absolute inset-0 overflow-hidden opacity-25 blur-[2px]"}>
    <div data-layout="arena-scene" className="relative min-h-[20rem] sm:min-h-[24rem]">
      <SpatialPitch presentation="arena" embedded analysis={analysis} contextIdentity={contextIdentity} layers={{ ...DEFAULT_PITCH_LAYERS, cca: false, trajectories: false }} fullActivityHeatmap={heatmap} fullActivityDisplay={display} boxSubregion={boxSubregion} nativePitchEvents={nativePitchEvents} onArenaSelectionChange={setSelection} />
      <div className="pointer-events-none absolute inset-x-0 top-0 z-20 flex items-start justify-between gap-3 p-3 sm:p-4">
        <div className="pointer-events-auto w-[min(100%,23rem)]"><ArenaProfileHud player={player} analysis={analysis} selected={dataset} /></div>
        {!selection && <div data-layout="arena-category-hud" className="pointer-events-auto hidden w-72 max-h-[min(31rem,calc(100svh_-_3rem))] overflow-y-auto overscroll-contain rounded-xl border border-white/15 bg-[#181a1b]/95 p-3 text-zinc-100 shadow-[0_12px_30px_rgba(0,0,0,.34)] backdrop-blur-md lg:block">{selectionHud}</div>}
      </div>
      <div data-layout="arena-season-rail" className="pointer-events-auto absolute bottom-3 left-3 z-20 hidden max-h-[min(15rem,calc(100%_-_6rem))] w-56 overflow-y-auto rounded-xl border border-white/15 bg-[#181a1b]/95 p-3 shadow-[0_12px_30px_rgba(0,0,0,.34)] backdrop-blur-md lg:block"><OverviewSeasonRail player={player} analysis={analysis} selected={dataset} history={history} /></div>
    </div>
    <div data-layout="arena-controls-footer" className="relative z-20 flex min-h-12 flex-col gap-2 border-t border-white/10 bg-[#232628]/95 px-3 py-2 text-zinc-200 sm:flex-row sm:items-center sm:justify-between">
      <div><p data-arena-controls-help className="type-caption">WASD 이동 · 좌드래그 앵글 · 우드래그 높이 · 휠 줌</p><p className="mt-1 text-xs text-zinc-400">활동 등고선: 선수 내 상대 밀도 · 층 높이는 실제 위치 높이가 아닙니다.</p></div>
      <div className="shrink-0"><PitchPenaltyToggle /></div>
    </div>
    <div className="relative z-20 border-t border-white/10 bg-[#232628]/95 p-3 lg:hidden">
      <details className="rounded-xl border border-white/10 p-3"><summary className="cursor-pointer text-sm font-black">시즌 기록</summary><div className="mt-3 max-h-[50svh] overflow-y-auto"><OverviewSeasonRail player={player} analysis={analysis} selected={dataset} history={history} ariaLabel="시즌 · 대회 모바일" /></div></details>
      {!selection && <details className="mt-2 rounded-xl border border-white/10 p-3"><summary className="cursor-pointer text-sm font-black">M.E.S.S.I. 카테고리</summary><div className="mt-3 max-h-[50svh] overflow-y-auto"><OverviewCategoryVector categories={authoritative?.categories} state={state} /></div></details>}
    </div>
    </div>
    {!detailOpen && <div data-layout="arena-opening" className="relative z-20 grid min-h-[34rem] gap-5 bg-gradient-to-r from-[#1c1f20]/95 via-[#1c1f20]/75 to-[#1c1f20]/40 p-4 sm:p-7 lg:grid-cols-[minmax(0,1fr)_22rem] lg:gap-8">
      <div className="min-w-0 lg:col-start-1 lg:row-start-1"><ArenaProfileHud player={player} analysis={analysis} selected={dataset}/></div>
      <div data-layout="opening-category" className="min-w-0 rounded-xl border border-white/15 bg-[#232628]/85 p-4 shadow-[0_15px_45px_rgba(0,0,0,.2)] backdrop-blur-md lg:col-start-2 lg:row-span-3 lg:row-start-1"><OverviewCategoryVector categories={authoritative?.categories} state={state}/></div>
      <div data-layout="opening-season" className="min-w-0 rounded-xl border border-white/15 bg-[#232628]/80 p-4 backdrop-blur-md lg:col-start-1 lg:row-start-2"><OverviewSeasonRail player={player} analysis={analysis} selected={dataset} history={history} ariaLabel="시즌 · 대회"/></div>
      <div className="mt-auto flex flex-wrap items-center justify-between gap-3 border-t border-white/15 pt-4 lg:col-start-1 lg:row-start-3"><p className="text-sm text-zinc-400">같은 시즌·대회에서 선수를 비교합니다.</p><a href={comparisonHref} className="inline-flex min-h-11 items-center rounded-full border border-white/25 px-5 text-sm font-semibold text-zinc-100 hover:bg-white/10 focus-visible:ring-2 focus-visible:ring-[#e78b84]">선수 비교 <span aria-hidden="true" className="ml-3">↗</span></a></div>
    </div>}
    </div>
  </section>;
}

export type PlayerArenaStageProps = {
  player: Player;
  analysis?: PlayerAnalysis;
  history: PlayerOverviewHistory;
  config?: MessiApiConfig;
  dataset: DatasetRouteState;
  data?: DuelPressV2DetailMetrics;
  categoryState?: OverviewReadoutState;
};

export function PlayerArenaStage(props: PlayerArenaStageProps) {
  return <PlayerArenaBody {...props} />;
}
