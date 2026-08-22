import { useCallback, useEffect, useRef, useState } from "react";
import { fetchFinalThirdShotMap, finalThirdShotMapResourceKey } from "../api/finalThirdShotMapApi";
import { fetchFinalThirdShotMapV2, finalThirdShotMapV2ResourceKey } from "../api/finalThirdShotMapV2Api";
import { finalThirdShotMapEnabled } from "../api/finalThirdShotMapFeatureGate";
import { finalThirdShotMapV2Enabled } from "../api/finalThirdShotMapFeatureGate";
import type { FinalThirdShotMapEnvelope } from "../api/finalThirdShotMapContracts";
import type { FinalThirdShotMapV2Envelope } from "../api/finalThirdShotMapV2Contracts";
import type { MessiApiConfig } from "../api/env";
import type { DatasetRouteState } from "../dashboard/types";

type Keyed = { key: string };
export type FinalThirdShotMapEnvelopeResponse = FinalThirdShotMapEnvelope | FinalThirdShotMapV2Envelope;
export type FinalThirdShotMapState = (Keyed & { kind: "disabled" }) | (Keyed & { kind: "loading" }) | (Keyed & { kind: "error" }) | (Keyed & { kind: "unavailable"; data: FinalThirdShotMapEnvelopeResponse }) | (Keyed & { kind: "partial"; data: FinalThirdShotMapEnvelopeResponse }) | (Keyed & { kind: "ready"; data: FinalThirdShotMapEnvelopeResponse }) | (Keyed & { kind: "observed-zero"; data: FinalThirdShotMapEnvelopeResponse });
export function useFinalThirdShotMap(config: MessiApiConfig | undefined, playerId: number, context: DatasetRouteState) {
  const [retryEpoch, setRetryEpoch] = useState(0), generation = useRef(0); const enabled = finalThirdShotMapEnabled(); const v2Enabled = finalThirdShotMapV2Enabled(); const resourceKey = v2Enabled ? finalThirdShotMapV2ResourceKey(playerId, context) : finalThirdShotMapResourceKey(playerId, context); const [state, setState] = useState<FinalThirdShotMapState>({ kind: enabled ? "loading" : "disabled", key: resourceKey });
  useEffect(() => {
    const current = ++generation.current;
    if (!enabled || !config || !Number.isSafeInteger(playerId) || playerId <= 0) { setState({ kind: "disabled", key: resourceKey }); return; }
    const controller = new AbortController(); setState({ kind: "loading", key: resourceKey });
    const request = v2Enabled ? fetchFinalThirdShotMapV2(config, playerId, context, controller.signal) : fetchFinalThirdShotMap(config, playerId, context, controller.signal);
    void request.then((data) => { if (controller.signal.aborted || generation.current !== current) return; if (!data.data.available) setState({ kind: "unavailable", data, key: resourceKey }); else if (data.data.completeness === "partial") setState({ kind: "partial", data, key: resourceKey }); else if (data.data.zones.every((zone) => zone.shotsTotal === 0)) setState({ kind: "observed-zero", data, key: resourceKey }); else setState({ kind: "ready", data, key: resourceKey }); }).catch((error: unknown) => { if (!controller.signal.aborted && generation.current === current && !(error instanceof DOMException && error.name === "AbortError")) setState({ kind: "error", key: resourceKey }); });
    return () => controller.abort();
  }, [config, context.competition, context.mode, context.scope, context.season, enabled, playerId, retryEpoch, resourceKey, v2Enabled]);
  return { state, resourceKey, retry: useCallback(() => setRetryEpoch((value) => value + 1), []) };
}
