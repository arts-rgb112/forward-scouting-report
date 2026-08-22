import { useEffect, useMemo, useRef, useState } from "react";
import type { ContextualCompareRequest, ContextualCompareResponse } from "./contextualCompareContracts";
import type { MessiApiConfig } from "./env";
import { fetchContextualComparison } from "./contextualCompareApi";

export type ContextualCompareState = { state: "idle" | "loading" | "error" | "success"; value?: ContextualCompareResponse; error?: string };
export type ContextualComparePanelState = { state: "idle" | "loading" | "error"; error?: string } | { state: "resolved" | "unavailable" | "invalid_context"; side: ContextualCompareResponse["left"] };
function panelState(state: ContextualCompareState, key: "left" | "right"): ContextualComparePanelState {
  if (state.state !== "success") return state.state === "error" ? { state: "error", error: state.error ?? "Comparison could not be loaded." } : { state: state.state };
  const side = state.value![key]; return side.status === "resolved" ? { state: "resolved", side } : { state: side.status, side };
}
export function useContextualCompare(config: MessiApiConfig | undefined, request: ContextualCompareRequest | null) {
  const [retry, setRetry] = useState(0); const [state, setState] = useState<ContextualCompareState>({ state: "idle" }); const generation = useRef(0);
  const identity = useMemo(() => request ? JSON.stringify(request) : "", [request]);
  useEffect(() => {
    if (!request) { setState({ state: "idle" }); return; }
    if (!config) { setState({ state: "error", error: "API configuration is unavailable." }); return; }
    const controller = new AbortController(); const current = ++generation.current;
    setState({ state: "loading" });
    void fetchContextualComparison(config, request, controller.signal).then((value) => { if (!controller.signal.aborted && generation.current === current) setState({ state: "success", value }); }).catch((error: unknown) => { if (!controller.signal.aborted && generation.current === current) setState({ state: "error", error: error instanceof Error ? error.message : "Comparison could not be loaded." }); });
    return () => controller.abort();
  }, [config, identity, request, retry]);
  // Compatibility presentation only: values are server summaries, never client
  // recalculated analysis. New consumers should use `value.left/right` directly.
  const players = state.value ? [state.value.left, state.value.right].filter((side) => side.status === "resolved").map((side) => ({ player: side.summary!, analysis: undefined })) : [];
  const panels = { left: panelState(state, "left"), right: panelState(state, "right") };
  return { ...state, panels, players, retry: () => setRetry((value) => value + 1) };
}
