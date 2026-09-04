import { useEffect, useRef, useState } from "react";

import { parseMessiApiConfig, type MessiApiConfig } from "../api/env";
import { MessiApiError } from "../api/errors";
import { fetchPlayerDetail } from "../api/leaderboardsApi";
import { dashboardQueryKeys, datasetHref, preserveExternalQuery } from "../dashboard/datasetRoute";
import type { DatasetRouteState, Player, PlayerAnalysis } from "../dashboard/types";
import { DEFAULT_PITCH_LAYERS } from "./pitchLayers";
import { PitchPenaltyProvider, PitchPenaltyToggle } from "./PitchPenaltyContext";
import { SpatialPitch } from "./SpatialPitch";
import { useFullActivityHeatmap } from "./useFullActivityHeatmap";

const validId = (id: number) => Number.isSafeInteger(id) && id > 0;

export function Player3DRoute({ id, dataset, config: providedConfig }: {
  id: number;
  dataset: DatasetRouteState;
  config?: MessiApiConfig;
}) {
  let parsedConfig = providedConfig;
  if (!parsedConfig) {
    try { parsedConfig = parseMessiApiConfig(import.meta.env, import.meta.env.MODE); } catch { /* surfaced below */ }
  }
  const config = parsedConfig;
  const [detail, setDetail] = useState<{ player: Player; analysis?: PlayerAnalysis }>();
  const [error, setError] = useState<"config" | "network" | "not-found">();
  const [retry, setRetry] = useState(0);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const fullHeatmap = useFullActivityHeatmap(config, id, dataset);
  const fullActivityHeatmap = fullHeatmap.kind === "ready" ? fullHeatmap.data : undefined;
  const contextIdentity = `${id}|${dataset.season}|${dataset.mode}|${dataset.scope}|${dataset.competition}`;
  const detailHref = preserveExternalQuery(datasetHref(`/players/${id}`, dataset), window.location.search, dashboardQueryKeys);

  useEffect(() => {
    if (!config || !validId(id)) {
      setError(validId(id) ? "config" : "not-found");
      return;
    }
    const controller = new AbortController();
    setDetail(undefined);
    setError(undefined);
    void fetchPlayerDetail(config, id, dataset, controller.signal)
      .then((value) => { if (!controller.signal.aborted) setDetail(value); })
      .catch((cause) => {
        if (!controller.signal.aborted) setError(cause instanceof MessiApiError && cause.status === 404 ? "not-found" : "network");
      });
    return () => controller.abort();
  }, [config, dataset.competition, dataset.mode, dataset.scope, dataset.season, id, retry]);

  useEffect(() => { if (detail) titleRef.current?.focus(); }, [detail]);

  if (error) return <main id="main-content" className="grid min-h-screen place-items-center bg-[#080b0c] p-6 text-zinc-100"><section className="w-full max-w-xl rounded-xl border border-white/10 bg-[#101415] p-6"><h1 ref={titleRef} tabIndex={-1} className="text-3xl font-black outline-none">{error === "not-found" ? "선수를 찾을 수 없습니다" : "3D 회랑을 불러올 수 없습니다"}</h1><p role="alert" className="mt-3 text-zinc-400">{error === "config" ? "대시보드 API 설정을 사용할 수 없습니다." : error === "network" ? "선수 데이터를 불러오지 못했습니다." : "선택한 컨텍스트에 선수가 없습니다."}</p>{error !== "not-found" && <button type="button" onClick={() => setRetry((value) => value + 1)} className="mt-4 min-h-11 rounded border border-lime-300/40 px-4 text-lime-300">다시 시도</button>}<p className="mt-4"><a href={detailHref} className="text-lime-300 hover:underline">선수 상세로 돌아가기</a></p></section></main>;

  if (!detail) return <main id="main-content" className="grid min-h-screen place-items-center bg-[#080b0c] p-6 text-zinc-100"><p role="status" aria-live="polite">3D 선수 데이터를 불러오는 중입니다.</p></main>;

  return <main id="main-content" data-layout="player-3d-route" className="min-h-screen bg-[#080b0c] p-3 text-zinc-100 sm:p-6">
    <PitchPenaltyProvider summaryShots={detail.analysis?.spatial.shotmapPoints}>
      <div className="mx-auto flex max-w-[1920px] flex-wrap items-center justify-between gap-3">
        <div><a href={detailHref} className="inline-flex min-h-11 items-center text-lime-300 hover:underline focus-visible:ring-2 focus-visible:ring-lime-300">← 선수 상세</a><h1 ref={titleRef} tabIndex={-1} className="text-3xl font-black outline-none">{detail.player.name} · 3D 회랑</h1><p className="mt-1 text-base text-zinc-400">{dataset.season} · {dataset.mode === "league" ? `${dataset.scope}개 리그` : dataset.competition.toUpperCase()}</p></div>
        <PitchPenaltyToggle/>
      </div>
      <div className="mx-auto mt-4 max-w-[1920px]">
        <SpatialPitch analysis={detail.analysis} contextIdentity={contextIdentity} forcedMode="perspective" layers={DEFAULT_PITCH_LAYERS} fullActivityHeatmap={fullActivityHeatmap}/>
      </div>
    </PitchPenaltyProvider>
  </main>;
}
