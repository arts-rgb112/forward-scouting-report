import { useEffect, useMemo, useRef, useState } from "react";
import type { MessiApiConfig } from "../api/env";
import { fetchNativeBodyPartStats, nativeBodyPartResourceKey } from "../api/nativeBodyPartApi";
import type { NativeBodyPartEnvelope } from "../api/nativeBodyPartContracts";
import type { DatasetRouteState } from "../dashboard/types";
import { usePitchPenalty } from "./PitchPenaltyContext";

export type NativeBodyPartStatsState =
  | { kind: "loading" | "error"; key: string }
  | { kind: "ready"; key: string; data: NativeBodyPartEnvelope };

/**
 * The backend route is reviewed but not runtime-activated (unmounted router,
 * no provider integration) as of 2026-09-08 — see
 * NATIVE_BODY_PART_TRANSPORT_20260908.md. Every real request today lands in
 * `error` (404), which callers must render as an honest "unavailable" state,
 * never as a seeded/fixture value standing in for a live response.
 *
 * `includePenalties` is sourced from the shared `usePitchPenalty()` toggle so
 * this panel always agrees with the rest of the pitch view about which shots
 * are in scope.
 */
export function useNativeBodyPartStats(config: MessiApiConfig | undefined, playerId: number, dataset: DatasetRouteState) {
  const { includePenalties } = usePitchPenalty();
  const context = useMemo(() => ({ season: dataset.season, mode: dataset.mode, scope: dataset.scope, competition: dataset.competition }), [dataset.competition, dataset.mode, dataset.scope, dataset.season]);
  const key = nativeBodyPartResourceKey(playerId, context, includePenalties);
  const generation = useRef(0);
  const [state, setState] = useState<NativeBodyPartStatsState>({ kind: "loading", key });
  useEffect(() => {
    const current = ++generation.current;
    if (!config) { setState({ kind: "error", key }); return; }
    const controller = new AbortController();
    setState({ kind: "loading", key });
    void fetchNativeBodyPartStats(config, playerId, context, includePenalties, controller.signal).then((data) => {
      if (!controller.signal.aborted && generation.current === current) setState({ kind: "ready", key, data });
    }).catch((error: unknown) => {
      if (!controller.signal.aborted && generation.current === current && !(error instanceof DOMException && error.name === "AbortError")) setState({ kind: "error", key });
    });
    return () => controller.abort();
  }, [config, context, includePenalties, key, playerId]);
  return state;
}
