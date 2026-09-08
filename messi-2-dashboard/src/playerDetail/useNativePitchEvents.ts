import { useEffect, useMemo, useRef, useState } from "react";
import type { MessiApiConfig } from "../api/env";
import { fetchNativePitchEvents, nativePitchEventsResourceKey } from "../api/nativePitchEventsApi";
import type { NativePitchEventsEnvelope } from "../api/nativePitchEventsContracts";
import type { DatasetRouteState } from "../dashboard/types";
import { usePitchPenalty } from "./PitchPenaltyContext";

export type NativePitchEventsState =
  | { kind: "loading" | "error"; key: string }
  | { kind: "ready"; key: string; data: NativePitchEventsEnvelope };

/**
 * Mirrors `useNativeBodyPartStats` exactly — same shared PK toggle, same
 * stale-response/context-change guard via a generation counter, same honest
 * three-state shape. `key` changing (player/season/mode/scope/competition/PK)
 * is also the moment any UI holding a selected native event's `key` must
 * clear that selection — a native `key` from a stale context can never carry
 * over into a new one.
 */
export function useNativePitchEvents(config: MessiApiConfig | undefined, playerId: number, dataset: DatasetRouteState) {
  const { includePenalties } = usePitchPenalty();
  const context = useMemo(() => ({ season: dataset.season, mode: dataset.mode, scope: dataset.scope, competition: dataset.competition }), [dataset.competition, dataset.mode, dataset.scope, dataset.season]);
  const key = nativePitchEventsResourceKey(playerId, context, includePenalties);
  const generation = useRef(0);
  const [state, setState] = useState<NativePitchEventsState>({ kind: "loading", key });
  useEffect(() => {
    const current = ++generation.current;
    if (!config) { setState({ kind: "error", key }); return; }
    const controller = new AbortController();
    setState({ kind: "loading", key });
    void fetchNativePitchEvents(config, playerId, context, includePenalties, controller.signal).then((data) => {
      if (!controller.signal.aborted && generation.current === current) setState({ kind: "ready", key, data });
    }).catch((error: unknown) => {
      if (!controller.signal.aborted && generation.current === current && !(error instanceof DOMException && error.name === "AbortError")) setState({ kind: "error", key });
    });
    return () => controller.abort();
  }, [config, context, includePenalties, key, playerId]);
  return state;
}
