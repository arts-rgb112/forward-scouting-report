import { useCallback, useEffect, useRef, useState } from "react";
import { fetchTacticalSummaryV2 } from "../api/tacticalSummaryV2Api";
import { tacticalSummaryV2Enabled } from "../api/tacticalSummaryV2FeatureGate";
import type { TacticalSummaryV2 } from "../api/tacticalSummaryV2Contracts";
import type { MessiApiConfig } from "../api/env";
import type { DatasetRouteState } from "../dashboard/types";

export type TacticalSummaryV2State = { kind: "disabled" } | { kind: "loading" } | { kind: "error" } | { kind: "ready"; data: TacticalSummaryV2 };

export function useTacticalSummaryV2(config: MessiApiConfig | undefined, playerId: number, context: DatasetRouteState) {
  const enabled = tacticalSummaryV2Enabled();
  const [epoch, setEpoch] = useState(0); const generation = useRef(0);
  const [state, setState] = useState<TacticalSummaryV2State>(enabled ? { kind: "loading" } : { kind: "disabled" });
  useEffect(() => {
    const current = ++generation.current;
    if (!enabled || !config || !Number.isSafeInteger(playerId) || playerId <= 0) { setState({ kind: "disabled" }); return; }
    const controller = new AbortController(); setState({ kind: "loading" });
    void fetchTacticalSummaryV2(config, playerId, context, controller.signal).then((data) => {
      if (!controller.signal.aborted && generation.current === current) setState({ kind: "ready", data });
    }).catch((error) => {
      if (!controller.signal.aborted && generation.current === current && !(error instanceof DOMException && error.name === "AbortError")) setState({ kind: "error" });
    });
    return () => controller.abort();
  }, [config, context.competition, context.mode, context.scope, context.season, enabled, epoch, playerId]);
  return { state, retry: useCallback(() => setEpoch((value) => value + 1), []) };
}
