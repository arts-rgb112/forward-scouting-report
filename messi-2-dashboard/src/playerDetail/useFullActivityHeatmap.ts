import { useEffect, useMemo, useRef, useState } from "react";
import type { MessiApiConfig } from "../api/env";
import { fetchFullActivityHeatmap, fullActivityHeatmapResourceKey } from "../api/fullActivityHeatmapApi";
import type { FullActivityHeatmapData } from "../api/fullActivityHeatmapContracts";
import type { DatasetRouteState } from "../dashboard/types";

export type FullActivityHeatmapState = { kind: "loading" | "error"; key: string } | { kind: "ready" | "unavailable"; key: string; data: FullActivityHeatmapData };
export function useFullActivityHeatmap(config: MessiApiConfig | undefined, playerId: number, dataset: DatasetRouteState) {
  const context = useMemo(() => ({ playerId, season: dataset.season, mode: dataset.mode, scope: dataset.scope, competition: dataset.competition }), [dataset.competition, dataset.mode, dataset.scope, dataset.season, playerId]);
  const key = `${fullActivityHeatmapResourceKey}:${playerId}:${dataset.season}:${dataset.mode}:${dataset.scope}:${dataset.competition}`;
  const generation = useRef(0);
  const [state, setState] = useState<FullActivityHeatmapState>({ kind: "loading", key });
  useEffect(() => {
    const current = ++generation.current;
    if (!config) { setState({ kind: "error", key }); return; }
    const controller = new AbortController(); setState({ kind: "loading", key });
    void fetchFullActivityHeatmap(config, context, controller.signal).then((envelope) => {
      if (!controller.signal.aborted && generation.current === current) setState({ kind: envelope.data.available ? "ready" : "unavailable", key, data: envelope.data });
    }).catch((error: unknown) => {
      if (!controller.signal.aborted && generation.current === current && !(error instanceof DOMException && error.name === "AbortError")) setState({ kind: "error", key });
    });
    return () => controller.abort();
  }, [config, context, key]);
  return state;
}
