import { useId, useMemo, useRef, useState, type KeyboardEvent } from "react";

import type { MessiApiConfig } from "../api/env";
import type { FinalThirdRenderableData } from "../api/finalThirdShotMapV2Contracts";
import type { FinalThirdShotMapV3Data } from "../api/finalThirdShotMapV3Contracts";
import type { DatasetRouteState, PlayerAnalysis } from "../dashboard/types";
import { GoalMouthView } from "./GoalMouthView";
import { usePitchPenalty } from "./PitchPenaltyContext";
import { SpatialPitch } from "./SpatialPitch";
import { useFinalThirdShotMap } from "./useFinalThirdShotMap";
import { useGoalMouthBaseline } from "./useGoalMouthBaseline";

const WORKSPACE_COPY = {
  title: "Pitch workspace",
  tabs: {
    threeD: "어디서 쏘고 어디로 꽂나",
    twoD: "어떻게 움직이나",
    goalMouth: "골문 어디를 노리나",
  },
  unavailable: "골문 배치 데이터가 이 컨텍스트에서 제공되지 않습니다.",
  loading: "골문 배치 데이터를 불러오는 중입니다.",
} as const;

const TAB_IDS = ["threeD", "twoD", "goalMouth"] as const;
type WorkspaceTab = typeof TAB_IDS[number];
type RenderableData = FinalThirdRenderableData | FinalThirdShotMapV3Data;

function isRenderableData(value: unknown): value is RenderableData {
  return Boolean(value && typeof value === "object" && "shots" in value);
}

export function PitchWorkspace({ analysis, contextIdentity, config, playerId, dataset }: {
  analysis?: PlayerAnalysis;
  contextIdentity: string;
  config?: MessiApiConfig;
  playerId: number;
  dataset: DatasetRouteState;
}) {
  const id = useId().replace(/:/g, "");
  const [activeTab, setActiveTab] = useState<WorkspaceTab>("threeD");
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const finalThird = useFinalThirdShotMap(config, playerId, dataset);
  const { includePenalties } = usePitchPenalty();
  const baselineContext = useMemo(() => ({ playerId, season: dataset.season, mode: dataset.mode, scope: dataset.scope, competition: dataset.competition, includePenalties }), [dataset.competition, dataset.mode, dataset.scope, dataset.season, includePenalties, playerId]);
  const baseline = useGoalMouthBaseline(config, baselineContext);
  const current = finalThird.state.key === finalThird.resourceKey;
  const payload = current && "data" in finalThird.state ? finalThird.state.data.data : undefined;
  const goalData = isRenderableData(payload) ? payload : undefined;
  const select = (next: WorkspaceTab, focus = false) => {
    setActiveTab(next);
    if (focus) requestAnimationFrame(() => tabRefs.current[TAB_IDS.indexOf(next)]?.focus());
  };
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const nextIndex = event.key === "ArrowLeft" ? (index + TAB_IDS.length - 1) % TAB_IDS.length : event.key === "ArrowRight" ? (index + 1) % TAB_IDS.length : event.key === "Home" ? 0 : event.key === "End" ? TAB_IDS.length - 1 : null;
    if (nextIndex === null) return;
    event.preventDefault();
    select(TAB_IDS[nextIndex], true);
  };
  return <section data-layout="pitch-workspace" className="min-w-0 rounded-xl border border-white/10 bg-[#101415] p-4 shadow-sm" aria-labelledby={`pitch-workspace-${id}`}>
    <h2 id={`pitch-workspace-${id}`} className="text-sm font-black">{WORKSPACE_COPY.title}</h2>
    <div role="tablist" aria-label={WORKSPACE_COPY.title} className="mt-3 flex flex-wrap gap-2">
      {TAB_IDS.map((tab, index) => <button key={tab} ref={(element) => { tabRefs.current[index] = element; }} id={`${id}-${tab}`} role="tab" type="button" tabIndex={activeTab === tab ? 0 : -1} aria-selected={activeTab === tab} aria-controls={`${id}-panel`} onClick={() => select(tab)} onKeyDown={(event) => onKeyDown(event, index)} className="min-h-11 rounded border border-white/20 px-4 text-sm font-bold aria-selected:bg-lime-300 aria-selected:text-zinc-950 focus-visible:ring-2 focus-visible:ring-lime-300">{WORKSPACE_COPY.tabs[tab]}</button>)}
    </div>
    <div id={`${id}-panel`} role="tabpanel" aria-labelledby={`${id}-${activeTab}`} className="mt-3">
      {activeTab === "threeD" && <SpatialPitch analysis={analysis} contextIdentity={contextIdentity} forcedMode="perspective" embedded/>}
      {activeTab === "twoD" && <SpatialPitch analysis={analysis} contextIdentity={contextIdentity} forcedMode="plan" embedded/>}
      {activeTab === "goalMouth" && (goalData ? <GoalMouthView data={goalData} config={config} baselineResource={baseline.state}/> : <p role="status" aria-live="polite" className="rounded border border-white/10 bg-black/20 p-4 text-sm text-zinc-300">{!current || finalThird.state.kind === "loading" ? WORKSPACE_COPY.loading : WORKSPACE_COPY.unavailable}</p>)}
    </div>
  </section>;
}
