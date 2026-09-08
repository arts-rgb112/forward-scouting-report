import { useEffect, useMemo, useRef, useState } from "react";
import type { MessiApiConfig } from "../api/env";
import { fetchBoxSubregionStats, boxSubregionResourceKey } from "../api/boxSubregionApi";
import type { BoxSubregionEnvelope } from "../api/boxSubregionContracts";
import type { DatasetRouteState } from "../dashboard/types";

export type BoxSubregionStatsState =
  | { kind: "loading" | "error"; key: string }
  | { kind: "ready"; key: string; data: BoxSubregionEnvelope };

/**
 * The backend route is reviewed but not runtime-activated (unmounted router,
 * no provider integration) as of 2026-09-08 — see
 * BOX_SUBREGION_TRANSPORT_PROPOSAL_20260908.md. Every real request today
 * lands in `error` (404), which callers must render as an honest
 * "unavailable" state, never as a seeded/fixture value standing in for a
 * live response.
 */
export function useBoxSubregionStats(config: MessiApiConfig | undefined, playerId: number, dataset: DatasetRouteState) {
  const context = useMemo(() => ({ season: dataset.season, mode: dataset.mode, scope: dataset.scope, competition: dataset.competition }), [dataset.competition, dataset.mode, dataset.scope, dataset.season]);
  const key = `${boxSubregionResourceKey(playerId, context)}`;
  const generation = useRef(0);
  const [state, setState] = useState<BoxSubregionStatsState>({ kind: "loading", key });
  useEffect(() => {
    const current = ++generation.current;
    if (!config) { setState({ kind: "error", key }); return; }
    const controller = new AbortController();
    setState({ kind: "loading", key });
    void fetchBoxSubregionStats(config, playerId, context, controller.signal).then((data) => {
      if (!controller.signal.aborted && generation.current === current) setState({ kind: "ready", key, data });
    }).catch((error: unknown) => {
      if (!controller.signal.aborted && generation.current === current && !(error instanceof DOMException && error.name === "AbortError")) setState({ kind: "error", key });
    });
    return () => controller.abort();
  }, [config, context, key, playerId]);
  return state;
}
