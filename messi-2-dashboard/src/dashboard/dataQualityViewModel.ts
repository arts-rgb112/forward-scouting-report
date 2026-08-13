import type { DataQualityDto, WatchlistDataQualityResultDto } from "../api/contracts";
import type { WatchlistEntry } from "./watchlistStorage";

export type QualityCause = "http" | "network" | "schema" | "identity" | "partial";
export type QualityDisplay = { kind: "idle" | "pending" } | { kind: "complete" | "incomplete"; dataQuality: DataQualityDto } | { kind: "unknown"; cause: QualityCause };
export const qualityReasonKorean: Record<DataQualityDto["reason"], string> = {
  complete: "완전한 원본 데이터", spatial_session_missing: "공간 세션 데이터가 없습니다", source_metric_missing: "원본 지표 일부가 없습니다", mixed_source_missing: "혼합 원본 데이터 일부가 없습니다",
};
export function qualityDisplay(dataQuality: DataQualityDto): QualityDisplay {
  const complete = dataQuality.reason === "complete" && dataQuality.messiScoreComplete && dataQuality.imputedMetrics.length === 0 && dataQuality.imputedComponents.length === 0;
  return complete ? { kind: "complete", dataQuality } : { kind: "incomplete", dataQuality };
}
export function metricIsImputed(quality: QualityDisplay | undefined, metric: DataQualityDto["imputedMetrics"][number]): boolean {
  return quality?.kind === "incomplete" && (quality.dataQuality.imputedMetrics.includes(metric) || quality.dataQuality.imputedComponents.some((component) => component.startsWith(`${metric}.`)));
}
function exactResult(result: WatchlistDataQualityResultDto, entry: WatchlistEntry) {
  const context = result.context;
  return result.status === "resolved" && result.playerId === entry.playerId && context !== null
    && context.season === entry.context.season && context.mode === entry.context.mode && context.scope === entry.context.scope && context.competition === entry.context.competition
    && result.dataQuality !== null;
}
/** Missing, duplicates, unexpected records and partial statuses all fail closed per entry. */
export function watchlistQualityDisplays(entries: readonly WatchlistEntry[], results: readonly WatchlistDataQualityResultDto[]): Record<string, QualityDisplay> {
  const requested = new Map<string, number>(); const returned = new Map<string, number>(); const byKey = new Map<string, WatchlistDataQualityResultDto>();
  for (const entry of entries) requested.set(entry.key, (requested.get(entry.key) ?? 0) + 1);
  for (const result of results) { returned.set(result.key, (returned.get(result.key) ?? 0) + 1); byKey.set(result.key, result); }
  return Object.fromEntries(entries.map((entry) => {
    const result = byKey.get(entry.key);
    if (requested.get(entry.key) !== 1 || returned.get(entry.key) !== 1 || !result || !exactResult(result, entry)) return [entry.key, { kind: "unknown", cause: result?.status === "resolved" ? "identity" : "partial" } satisfies QualityDisplay];
    return [entry.key, qualityDisplay(result.dataQuality!)];
  }));
}
