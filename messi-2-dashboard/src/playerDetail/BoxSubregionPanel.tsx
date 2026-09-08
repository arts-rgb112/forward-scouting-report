import type { BoxSubregionRegion } from "../api/boxSubregionContracts";
import type { BoxSubregionStatsState } from "./useBoxSubregionStats";

/**
 * Shared between the 2D and 3D pitch views so the box breakdown never drifts
 * between them. Every number here is server-authoritative
 * (`box-subregion-stats-v1`) — this component only formats, it never
 * computes shares, deltas, or aggregates itself.
 *
 * The backend route is reviewed but not yet runtime-activated, so `error`
 * (today's real state, a 404) must read as "unavailable", never as a blank
 * panel or a silently-seeded placeholder.
 *
 * Progressive disclosure (2026-09-08 follow-up): the always-expanded 4-region
 * grid recreated the rejected "number wall" pattern. The passive table is now
 * collapsed by default behind `<details>` — a person who wants the full
 * breakdown can still open it, the numbers are never deleted. Hovering or
 * selecting an actual region on the pitch (the 3D dock's own hover tooltip,
 * the 2D corridor's own selection inspector) already surfaces that region's
 * real readout on its own; `activeRegionId` additionally mirrors that same
 * readout here, next to the totals, so it is not missed just because the
 * detail table happens to be collapsed.
 */
export function BoxSubregionPanel({ state, activeRegionId }: { state: BoxSubregionStatsState; activeRegionId?: string | null }) {
  const ready = state.kind === "ready" ? state.data : undefined;
  const activeRegion = ready?.regions.find((region) => region.id === activeRegionId);

  return (
    <section aria-label="박스 구역 슈팅 통계" data-box-subregion-panel data-box-subregion-state={state.kind}
      className="rounded border border-white/20 bg-[#0b0e0f]/95 p-2.5 text-zinc-100">
      <h3 className="text-xs font-bold text-white/85">박스 구역 슈팅</h3>
      {state.kind === "loading" && <p className="mt-2 text-xs text-white/60" role="status">불러오는 중…</p>}
      {state.kind === "error" && (
        <p className="mt-2 text-xs text-amber-200/90" data-box-subregion-unavailable>
          박스 구역 통계를 사용할 수 없습니다.
        </p>
      )}
      {ready && (
        <>
          {activeRegion && (
            <div className="mt-2 rounded border border-orange-300/40 bg-orange-400/10 px-2 py-1.5" data-box-subregion-active-region={activeRegion.id}>
              <p className="text-[10px] text-orange-200/80">선택 구역 · {activeRegion.label}</p>
              <RegionReadout region={activeRegion} />
            </div>
          )}
          <details className="mt-2 text-[10px] text-white/50">
            <summary className="cursor-pointer select-none text-xs font-semibold text-white/70">4분할 상세 보기</summary>
            <dl className="mt-2 grid grid-cols-2 gap-x-2 gap-y-1.5">
              {ready.regions.map((region) => (
                <div key={region.id} data-box-subregion-region={region.id}>
                  <dt className="text-[10px] text-white/55">{region.label}</dt>
                  <RegionReadout region={region} />
                </div>
              ))}
            </dl>
            <p className="mt-2 border-t border-white/15 pt-1.5 text-[10px] leading-relaxed text-white/50" data-box-subregion-denominators>
              분모 — 전체 활동 {ready.denominators.fullActivityCount ?? "—"}개 · 비페널티 슛 {ready.denominators.selectedNonPenaltyShots ?? "—"}개
            </p>
            {ready.completeness !== "observed" && (
              <p className="mt-1 text-[10px] leading-relaxed text-amber-200/90">
                {ready.completeness === "unavailable" ? "박스 구역 원천 데이터 미연결" : "일부 구간만 관측됨 — 완전한 시즌 합계 아님"}
              </p>
            )}
          </details>
        </>
      )}
    </section>
  );
}

function RegionReadout({ region }: { region: BoxSubregionRegion }) {
  return (
    <>
      <dd className="font-mono text-sm font-semibold tracking-tight">
        {region.shots === null ? "—" : `${region.shots}슛 · ${region.goals}골 · xG ${region.xg === null ? "—" : region.xg.toFixed(2)}`}
      </dd>
      <dd className="font-mono text-[11px] text-white/60">
        활동 {region.activitySharePct === null ? "—" : `${region.activitySharePct.toFixed(1)}%`}
        <span className="mx-1 text-white/30">·</span>
        슈팅 {region.shootingSharePct === null ? "—" : `${region.shootingSharePct.toFixed(1)}%`}
      </dd>
      <dd className="font-mono text-[11px] text-white/70" data-box-subregion-quality={region.quality.state}>
        {region.quality.state === "unavailable" ? "xGOT−xG —" : `xGOT−xG ${region.quality.delta! >= 0 ? "+" : ""}${region.quality.delta!.toFixed(2)}`}
        {region.quality.state !== "unavailable" && <span className="ml-1 text-white/40">적격 {region.quality.eligible}/{region.shots}</span>}
        {region.quality.state === "partial" && <span className="ml-1 text-amber-200/80">일부 표본</span>}
      </dd>
    </>
  );
}
