import { useCallback, useEffect, useRef, useState } from "react";
import type { MessiApiConfig } from "../api/env";
import { fetchGoalMouthBaseline, goalMouthBaselineResourceKey } from "../api/goalMouthBaselineApi";
import type { GoalMouthBaselineEnvelope } from "../api/goalMouthBaselineContracts";
import { goalMouthBaselineEnabled } from "../api/goalMouthBaselineFeatureGate";

export type GoalMouthBaselineState = { kind: "disabled" | "loading" | "error"; key: string } | { kind: "unavailable" | "ready"; key: string; data: GoalMouthBaselineEnvelope };
export function useGoalMouthBaseline(config: MessiApiConfig | undefined) {
  const enabled = goalMouthBaselineEnabled(), key = goalMouthBaselineResourceKey, [epoch, setEpoch] = useState(0), generation = useRef(0);
  const [state, setState] = useState<GoalMouthBaselineState>({ kind: enabled ? "loading" : "disabled", key });
  useEffect(() => {
    const current = ++generation.current;
    if (!enabled || !config) { setState({ kind: "disabled", key }); return; }
    const controller = new AbortController(); setState({ kind: "loading", key });
    void fetchGoalMouthBaseline(config, controller.signal).then((data) => { if (!controller.signal.aborted && generation.current === current) setState(data.data.available ? { kind: "ready", key, data } : { kind: "unavailable", key, data }); }).catch((error: unknown) => { if (!controller.signal.aborted && generation.current === current && !(error instanceof DOMException && error.name === "AbortError")) setState({ kind: "error", key }); });
    return () => controller.abort();
  }, [config, enabled, epoch]);
  return { state, retry: useCallback(() => setEpoch((value) => value + 1), []) };
}
