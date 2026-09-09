import { useEffect, useMemo, useRef, useState } from "react";
import type { MessiApiConfig } from "../api/env";
import {
  fetchFullActivityDisplay,
  fullActivityDisplayResourceKey,
} from "../api/fullActivityDisplayApi";
import type { FullActivityDisplayEnvelope } from "../api/fullActivityDisplayContracts";
import type { DatasetRouteState } from "../dashboard/types";

export type FullActivityDisplayState =
  | { kind: "loading" | "error"; key: string }
  | { kind: "ready" | "unavailable" | "zero"; key: string; data: FullActivityDisplayEnvelope };

function displayStateKind(data: FullActivityDisplayEnvelope): "ready" | "unavailable" | "zero" {
  // The endpoint has no imputation mode: data is either an observed display
  // packet, explicitly unavailable, or a real observed-zero heat grid.
  if (data.fullHeat.available && data.fullHeat.validPointCount === 0) return "zero";
  return data.fullSourceCca.available ? "ready" : "unavailable";
}

export function useFullActivityDisplay(config: MessiApiConfig | undefined, playerId: number, dataset: DatasetRouteState) {
  const context = useMemo(
    () => ({ season: dataset.season, mode: dataset.mode, scope: dataset.scope, competition: dataset.competition }),
    [dataset.competition, dataset.mode, dataset.scope, dataset.season],
  );
  const key = fullActivityDisplayResourceKey(playerId, context);
  const generation = useRef(0);
  const [state, setState] = useState<FullActivityDisplayState>({ kind: "loading", key });

  useEffect(() => {
    const current = ++generation.current;
    if (!config) {
      setState({ kind: "error", key });
      return;
    }
    const controller = new AbortController();
    setState({ kind: "loading", key });
    void fetchFullActivityDisplay(config, playerId, context, controller.signal).then((data) => {
      if (!controller.signal.aborted && generation.current === current)
        setState({ kind: displayStateKind(data), key, data });
    }).catch((error: unknown) => {
      if (!controller.signal.aborted && generation.current === current && !(error instanceof DOMException && error.name === "AbortError"))
        setState({ kind: "error", key });
    });
    return () => controller.abort();
  }, [config, context, key, playerId]);

  // Never expose a prior context packet while the new request starts.
  return state.key === key ? state : { kind: "loading" as const, key };
}
