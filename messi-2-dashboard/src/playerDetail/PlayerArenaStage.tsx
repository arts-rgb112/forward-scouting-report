import { useEffect, useState } from "react";

import type { MessiApiConfig } from "../api/env";
import type { DuelPressV2DetailMetrics } from "../api/duelPressV2Contracts";
import { boxSubregionResourceKey } from "../api/boxSubregionApi";
import type { DatasetRouteState, Player, PlayerAnalysis } from "../dashboard/types";
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
  useEffect(() => setSelection(null), [contextIdentity]);
  const authoritative = data?.ratingVersion === "messi-score-unified-v3" ? data : undefined;
  const state: OverviewReadoutState = authoritative ? "ready" : data ? "unavailable" : categoryState ?? "unavailable";
  const display = "data" in activity ? activity.data : undefined;
  const heatmap = display?.fullHeat;
  // Selected records retain the renderer's real NativePitchSelectionCard /
  // box card. The stage only removes the default category HUD while that
  // one factual selection dock is visible.
  const selectionHud = selection ? null : <OverviewCategoryVector categories={authoritative?.categories} state={state} />;

  return <section data-layout="player-arena-stage" aria-label="선수 피치 아레나" className="relative isolate min-w-0 overflow-hidden rounded-[1.5rem] border border-[#464a4c] bg-[#181a1b] shadow-[0_24px_60px_rgba(0,0,0,.28)]">
    <div data-layout="arena-scene" className="min-h-[20rem] sm:min-h-[24rem]"><SpatialPitch presentation="arena" embedded analysis={analysis} contextIdentity={contextIdentity} layers={{ ...DEFAULT_PITCH_LAYERS, cca: false, trajectories: false }} fullActivityHeatmap={heatmap} fullActivityDisplay={display} boxSubregion={boxSubregion} nativePitchEvents={nativePitchEvents} onArenaSelectionChange={setSelection} /></div>
    <div className="pointer-events-none absolute inset-x-0 top-0 z-20 flex items-start justify-between gap-3 p-3 sm:p-4">
      <div className="pointer-events-auto w-[min(100%,23rem)]"><ArenaProfileHud player={player} analysis={analysis} selected={dataset} /></div>
      {!selection && <div data-layout="arena-category-hud" className="pointer-events-auto hidden w-72 max-h-[min(31rem,calc(100svh_-_3rem))] overflow-y-auto overscroll-contain rounded-xl border border-white/15 bg-[#181a1b]/95 p-3 text-zinc-100 shadow-[0_12px_30px_rgba(0,0,0,.34)] backdrop-blur-md lg:block">{selectionHud}</div>}
    </div>
    <div data-layout="arena-season-rail" className="pointer-events-auto absolute bottom-3 left-3 z-20 hidden max-h-[min(15rem,calc(100%_-_6rem))] w-56 overflow-y-auto rounded-xl border border-white/15 bg-[#181a1b]/95 p-3 shadow-[0_12px_30px_rgba(0,0,0,.34)] backdrop-blur-md lg:block"><OverviewSeasonRail player={player} analysis={analysis} selected={dataset} history={history} /></div>
    <div className="pointer-events-auto absolute bottom-3 right-3 z-20 hidden lg:block"><PitchPenaltyToggle /></div>
    <div className="relative z-20 border-t border-white/10 bg-[#232628]/95 p-3 lg:hidden">
      <div className="mb-2 flex justify-end border-b border-white/10 pb-2"><PitchPenaltyToggle /></div>
      <details className="rounded-xl border border-white/10 p-3"><summary className="cursor-pointer text-sm font-black">시즌 기록</summary><div className="mt-3 max-h-[50svh] overflow-y-auto"><OverviewSeasonRail player={player} analysis={analysis} selected={dataset} history={history} ariaLabel="시즌 · 대회 모바일" /></div></details>
      {!selection && <details className="mt-2 rounded-xl border border-white/10 p-3"><summary className="cursor-pointer text-sm font-black">M.E.S.S.I. 카테고리</summary><div className="mt-3 max-h-[50svh] overflow-y-auto"><OverviewCategoryVector categories={authoritative?.categories} state={state} /></div></details>}
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
