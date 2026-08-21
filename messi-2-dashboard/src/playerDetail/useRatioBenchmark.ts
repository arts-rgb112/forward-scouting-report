import { useCallback, useEffect, useRef, useState } from "react";

import { fetchRatioBenchmark } from "../api/ratioBenchmarkApi";
import type { RatioBenchmark } from "../api/ratioBenchmarkContracts";
import type { MessiApiConfig } from "../api/env";
import type { DatasetRouteState } from "../dashboard/types";

export type RatioBenchmarkState = { kind: "disabled" } | { kind: "loading" } | { kind: "error" } | { kind: "unavailable"; data: Extract<RatioBenchmark, { available: false }> } | { kind: "ready"; data: Extract<RatioBenchmark, { available: true }> };
export const ratioBenchmarkEnabled = (env: Record<string, string | boolean | undefined> = import.meta.env) => env.VITE_RATIO_BENCHMARK_ENABLED === "true";

export function useRatioBenchmark(config: MessiApiConfig | undefined, playerId: number, context: DatasetRouteState) {
  const [epoch, setEpoch] = useState(0); const generation = useRef(0); const enabled = ratioBenchmarkEnabled();
  const [state, setState] = useState<RatioBenchmarkState>(enabled ? { kind: "loading" } : { kind: "disabled" });
  useEffect(() => {
    const current = ++generation.current;
    if (!enabled || !config || !Number.isSafeInteger(playerId) || playerId <= 0) { setState({ kind: "disabled" }); return; }
    const controller = new AbortController(); setState({ kind: "loading" });
    void fetchRatioBenchmark(config, playerId, context, controller.signal).then((data) => {
      if (!controller.signal.aborted && generation.current === current) setState(data.available ? { kind: "ready", data } : { kind: "unavailable", data });
    }).catch((error) => {
      if (!controller.signal.aborted && generation.current === current && !(error instanceof DOMException && error.name === "AbortError")) setState({ kind: "error" });
    });
    return () => controller.abort();
  }, [config, context.competition, context.mode, context.scope, context.season, enabled, epoch, playerId]);
  return { state, retry: useCallback(() => setEpoch((value) => value + 1), []) };
}
