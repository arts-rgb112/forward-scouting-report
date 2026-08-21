import { useEffect, useMemo, useRef, useState } from "react";

import { fetchMetricRanks } from "../api/metricRanksApi";
import type { MetricRanksRequestEntry, MetricRanksResult } from "../api/metricRanksContracts";
import type { MessiApiConfig } from "../api/env";
import type { DuelPressMetricKey, DuelPressModeContext } from "../api/duelPressTypes";
import type { MetricRankDisplay } from "./components/MetricScore";

export type MetricRankTarget = { key: string; playerId: number; context: DuelPressModeContext };
export type MetricRankMap = Partial<Record<DuelPressMetricKey, MetricRankDisplay>>;
export type MetricRanksByTargetKey = Readonly<Record<string, MetricRankMap>>;

const metricKeys: readonly DuelPressMetricKey[] = ["outsideShot", "boxThreat", "dangerZone", "combinedDuel", "spaceControl", "forwardPress"];
const cache = new Map<string, MetricRanksResult>();

function origin(baseUrl: string) { return new URL(baseUrl).origin; }
function cacheKey(baseUrl: string, target: MetricRankTarget) { return JSON.stringify([origin(baseUrl), target.key, target.playerId, "duel-press-v1", target.context]); }
function requestEntry(target: MetricRankTarget): MetricRanksRequestEntry { return { key: target.key, player: { idNamespace: "fotmob", playerId: target.playerId }, metricTaxonomyVersion: "duel-press-v1", context: target.context }; }
function asDisplay(result: MetricRanksResult): MetricRankMap {
  return Object.fromEntries(metricKeys.map((key) => {
    const metric = result.status === "resolved" ? result.metrics?.[key] : null;
    return [key, metric?.rank != null ? { state: "resolved", rank: metric.rank, population: metric.population } : { state: "unavailable" } satisfies MetricRankDisplay];
  })) as MetricRankMap;
}

/**
 * Non-blocking exact-context metric rank companion. The module cache deliberately
 * outlives a page render; a target can never be reused across API origin, player,
 * taxonomy, or season/mode/scope/competition context. Requests deliberately
 * are not globally shared: an aborted owner must never leave a later render
 * subscribed to its cancelled promise.
 */
export function useMetricRanks(config: MessiApiConfig | undefined, requestedTargets: readonly MetricRankTarget[], active: boolean): MetricRanksByTargetKey {
  const uniqueTargets = useMemo(() => {
    if (!config || !active) return [] as { target: MetricRankTarget; cacheKey: string }[];
    const seen = new Set<string>();
    return requestedTargets.slice(0, 50).flatMap((target) => {
      const key = cacheKey(config.baseUrl, target);
      if (seen.has(key)) return [];
      seen.add(key);
      return [{ target, cacheKey: key }];
    });
  }, [active, config?.baseUrl, requestedTargets]);
  const signature = useMemo(() => uniqueTargets.map(({ cacheKey: key }) => key).join("\u0000"), [uniqueTargets]);
  const [records, setRecords] = useState<Readonly<Record<string, MetricRanksResult | "pending">>>({});
  const generation = useRef(0);

  useEffect(() => {
    const id = ++generation.current;
    const controller = new AbortController();
    if (!active || !config || !uniqueTargets.length) { setRecords({}); return () => controller.abort(); }
    const initial: Record<string, MetricRanksResult | "pending"> = {};
    const missing: typeof uniqueTargets = [];
    for (const item of uniqueTargets) {
      const cached = cache.get(item.cacheKey);
      if (cached) initial[item.target.key] = cached;
      else { initial[item.target.key] = "pending"; missing.push(item); }
    }
    setRecords(initial);
    const apply = (target: MetricRankTarget, promise: Promise<MetricRanksResult>) => {
      void promise.then((result) => {
        cache.set(cacheKey(config.baseUrl, target), result);
        if (!controller.signal.aborted && id === generation.current) setRecords((current) => ({ ...current, [target.key]: result }));
      }).catch(() => {
        // Rank companion failure must not replace or block the leaderboard.
        if (!controller.signal.aborted && id === generation.current) setRecords((current) => ({ ...current, [target.key]: { ...requestEntry(target), status: "unavailable", metrics: null } }));
      });
    };
    // A short defer collapses StrictMode setup/cleanup and rapid signature churn
    // before a POST is sent. Cleanup cancels both timer and transport.
    const timer = window.setTimeout(() => {
      if (controller.signal.aborted || id !== generation.current) return;
      for (let start = 0; start < missing.length; start += 50) {
        const batch = missing.slice(start, start + 50);
        const batchPromise = fetchMetricRanks(config, { entries: batch.map(({ target }) => requestEntry(target)) }, controller.signal);
        for (const item of batch) {
          const promise = batchPromise.then((response) => {
            const result = response.results.find((candidate) => candidate.key === item.target.key);
            if (!result) throw new Error("Metric-ranks batch omitted a requested target");
            return result;
          });
          apply(item.target, promise);
        }
      }
    }, 0);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [active, config?.baseUrl, signature]);

  return useMemo(() => Object.fromEntries(uniqueTargets.map(({ target }) => {
    const record = records[target.key];
    const pending = Object.fromEntries(metricKeys.map((key) => [key, { state: "pending" } satisfies MetricRankDisplay])) as MetricRankMap;
    const unavailable = Object.fromEntries(metricKeys.map((key) => [key, { state: "unavailable" } satisfies MetricRankDisplay])) as MetricRankMap;
    return [target.key, record === "pending" ? pending : record ? asDisplay(record) : unavailable];
  })) as MetricRanksByTargetKey, [records, uniqueTargets]);
}

export function clearMetricRanksCacheForTests() { cache.clear(); }
