import { useCallback, useEffect, useRef, useState } from "react";
import { fetchVolumeBenchmark } from "../api/volumeBenchmarkApi";
import type { VolumeBenchmark } from "../api/volumeBenchmarkContracts";
import type { MessiApiConfig } from "../api/env";
import type { DatasetRouteState } from "../dashboard/types";

export type VolumeBenchmarkState = { kind: "disabled" } | { kind: "loading" } | { kind: "error" } | { kind: "unavailable"; data: Extract<VolumeBenchmark, { available: false }> } | { kind: "ready"; data: Extract<VolumeBenchmark, { available: true }> };
export const volumeBenchmarkEnabled = (env: Record<string, string | boolean | undefined> = import.meta.env) => env.VITE_VOLUME_BENCHMARK_ENABLED === "true";
export function useVolumeBenchmark(config: MessiApiConfig | undefined, playerId: number, context: DatasetRouteState) {
  const [epoch, setEpoch] = useState(0); const generation = useRef(0); const enabled = volumeBenchmarkEnabled();
  const [state, setState] = useState<VolumeBenchmarkState>(enabled ? { kind: "loading" } : { kind: "disabled" });
  useEffect(() => {
    const current = ++generation.current;
    if (!enabled || !config || !Number.isSafeInteger(playerId) || playerId <= 0) { setState({ kind: "disabled" }); return; }
    const controller = new AbortController(); setState({ kind: "loading" });
    void fetchVolumeBenchmark(config, playerId, context, controller.signal).then((data) => { if (!controller.signal.aborted && generation.current === current) setState(data.available ? { kind: "ready", data } : { kind: "unavailable", data }); }).catch((error) => { if (!controller.signal.aborted && generation.current === current && !(error instanceof DOMException && error.name === "AbortError")) setState({ kind: "error" }); });
    return () => controller.abort();
  }, [config, context.competition, context.mode, context.scope, context.season, enabled, epoch, playerId]);
  return { state, retry: useCallback(() => setEpoch((value) => value + 1), []) };
}
