import { useEffect, useMemo, useRef, useState } from "react";
import type { MessiApiConfig } from "../api/env";
import { fetchNativePitchEventsV2, nativePitchEventsV2ResourceKey } from "../api/nativePitchEventsV2Api";
import type { NativePitchEventsV2Envelope } from "../api/nativePitchEventsV2Contracts";
import type { DatasetRouteState } from "../dashboard/types";
import { usePitchPenalty } from "./PitchPenaltyContext";

export type NativePitchEventsV2State =
  | { kind: "loading" | "error"; key: string }
  | { kind: "ready"; key: string; data: NativePitchEventsV2Envelope };

export function useNativePitchEventsV2(config: MessiApiConfig | undefined, playerId: number, dataset: DatasetRouteState) {
  const { includePenalties } = usePitchPenalty();
  const context = useMemo(() => ({ season: dataset.season, mode: dataset.mode, scope: dataset.scope, competition: dataset.competition }), [dataset.competition, dataset.mode, dataset.scope, dataset.season]);
  const key = nativePitchEventsV2ResourceKey(playerId, context, includePenalties);
  const generation = useRef(0);
  const [state, setState] = useState<NativePitchEventsV2State>({ kind: "loading", key });
  useEffect(() => {
    const current = ++generation.current;
    if (!config) { setState({ kind: "error", key }); return; }
    const controller = new AbortController();
    setState({ kind: "loading", key });
    void fetchNativePitchEventsV2(config, playerId, context, includePenalties, controller.signal).then(data => {
      if (!controller.signal.aborted && generation.current === current) setState({ kind: "ready", key, data });
    }).catch(() => {
      if (!controller.signal.aborted && generation.current === current) setState({ kind: "error", key });
    });
    return () => controller.abort();
  }, [config, context, includePenalties, key, playerId]);
  // A new context must not expose the old ready packet even for one render.
  return state.key === key ? state : { kind: "loading" as const, key };
}
