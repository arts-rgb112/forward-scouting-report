import { useEffect, useRef, useState } from "react";

import type { PlayerAnalysis, ShotmapPoint } from "../dashboard/types";

export type ShotOutcome = ShotmapPoint["outcome"];
type Spatial = PlayerAnalysis["spatial"];

export const outcomeOrder: readonly ShotOutcome[] = ["goal", "on_target", "off_target", "blocked"];
export const outcomePresentation: Record<ShotOutcome, { label: string; plural: string; color: string; symbol: string; size: number; summary: string }> = {
  goal: { label: "Goal", plural: "Goals", color: "#F8FAFC", symbol: "star", size: 12, summary: "◇" },
  on_target: { label: "On target", plural: "On target", color: "#22D3EE", symbol: "circle", size: 9, summary: "●" },
  off_target: { label: "Off target", plural: "Off target", color: "#FB923C", symbol: "x", size: 9, summary: "×" },
  blocked: { label: "Blocked", plural: "Blocked", color: "#A3A3A3", symbol: "diamond-open", size: 8, summary: "■" },
};

const singleClickDelayMs = 350;
const validCoordinate = (value: number) => Number.isFinite(value) && value >= 0 && value <= 100;
const isOutcome = (value: unknown): value is ShotOutcome => typeof value === "string" && (outcomeOrder as readonly string[]).includes(value);
export const validShot = (shot: ShotmapPoint) => validCoordinate(shot.x) && validCoordinate(shot.y) && isOutcome(shot.outcome);
export const shotIntegrity = (spatial: Spatial | undefined) => Boolean(spatial?.shotmapSnapshotAvailable && spatial.shotmapPointCount === spatial.shotmapPoints.length && spatial.shotmapPoints.every(validShot));
export const formatShotMetric = (value: number | null | undefined) => Number.isFinite(value) ? Number(value).toFixed(2) : "—";
export const shotMarkerLabel = (shot: ShotmapPoint) => `${outcomePresentation[shot.outcome].label}. xG ${formatShotMetric(shot.xg)}. xGOT ${formatShotMetric(shot.xgot)}.`;
export const outcomeSummary = (outcomes: readonly ShotOutcome[]) => outcomes.length ? outcomes.map((outcome) => outcomePresentation[outcome].plural).join(", ") : "none";

function snapshotIdentity(contextIdentity: string, spatial: Spatial | undefined) {
  if (!spatial) return `${contextIdentity}|no-spatial`;
  return `${contextIdentity}|${spatial.shotmapSnapshotAvailable}|${spatial.shotmapPointCount}|${spatial.shotmapPoints.map((shot) => `${shot.x},${shot.y},${shot.outcome},${shot.xg ?? "—"},${shot.xgot ?? "—"}`).join(";")}`;
}

export function useShotOutcomeVisibility(spatial: Spatial | undefined, contextIdentity = "") {
  const integrity = shotIntegrity(spatial);
  const counts: Record<ShotOutcome, number> = { goal: 0, on_target: 0, off_target: 0, blocked: 0 };
  if (integrity) spatial!.shotmapPoints.forEach((shot) => { counts[shot.outcome] += 1; });
  const presentOutcomes = outcomeOrder.filter((outcome) => counts[outcome] > 0);
  const identity = snapshotIdentity(contextIdentity, spatial);
  const identityRef = useRef(identity); identityRef.current = identity;
  const pending = useRef<{ outcome: ShotOutcome; timer: number } | null>(null);
  const [state, setState] = useState<{ identity: string; visible: ReadonlySet<ShotOutcome> }>({ identity: "", visible: new Set() });
  const visibleOutcomes = state.identity === identity ? state.visible : new Set(presentOutcomes);
  const update = (transform: (current: ReadonlySet<ShotOutcome>) => ReadonlySet<ShotOutcome>) => setState((current) => current.identity === identity ? { identity, visible: transform(current.visible) } : current);
  const toggle = (outcome: ShotOutcome) => update((current) => { const next = new Set(current); next.has(outcome) ? next.delete(outcome) : next.add(outcome); return next; });
  const isolate = (outcome: ShotOutcome) => update(() => new Set([outcome]));
  const cancelPending = () => { if (pending.current) { window.clearTimeout(pending.current.timer); pending.current = null; } };
  const commitPending = () => { const current = pending.current; cancelPending(); if (current) toggle(current.outcome); };
  useEffect(() => {
    cancelPending(); setState({ identity, visible: new Set(presentOutcomes) });
    return cancelPending;
  // The canonical snapshot serialisation resets filters when data changes in-place.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identity]);
  const onClick = (outcome: ShotOutcome, detail: number) => {
    const current = pending.current;
    if (detail === 0) { commitPending(); toggle(outcome); return; }
    if (current?.outcome === outcome) { cancelPending(); return; }
    if (current) commitPending();
    const pendingIdentity = identity;
    const timer = window.setTimeout(() => {
      if (pending.current?.timer !== timer) return;
      pending.current = null;
      if (identityRef.current === pendingIdentity) toggle(outcome);
    }, singleClickDelayMs);
    pending.current = { outcome, timer };
  };
  const onDoubleClick = (outcome: ShotOutcome) => {
    if (pending.current?.outcome === outcome) cancelPending(); else if (pending.current) commitPending();
    isolate(outcome);
  };
  return { integrity, counts, presentOutcomes, visibleOutcomes, onClick, onDoubleClick };
}

export function OutcomeControls({ outcomes, counts, visible, markerLayerId, onClick, onDoubleClick }: {
  outcomes: readonly ShotOutcome[]; counts: Record<ShotOutcome, number>; visible: ReadonlySet<ShotOutcome>; markerLayerId: string;
  onClick(outcome: ShotOutcome, detail: number): void; onDoubleClick(outcome: ShotOutcome): void;
}) {
  return <div role="group" aria-label="Shot outcome visibility" className="mt-3 grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
    {outcomes.map((outcome) => { const item = outcomePresentation[outcome]; const pressed = visible.has(outcome); return <button key={outcome} type="button" aria-pressed={pressed} aria-controls={markerLayerId} aria-label={`${item.plural}, ${counts[outcome]} shots. ${pressed ? "Visible" : "Hidden"}. Click to show or hide; double-click to isolate.`}
      onClick={(event) => onClick(outcome, event.detail)} onDoubleClick={() => onDoubleClick(outcome)}
      className={`inline-flex min-h-11 min-w-11 items-center justify-center gap-2 rounded border px-3 text-xs font-bold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-200 ${pressed ? "border-white/30 bg-white/10 text-zinc-100" : "border-white/10 bg-black/20 text-zinc-500"}`}>
      <span aria-hidden="true" className="font-mono" style={{ color: item.color }}>{item.summary}</span><span>{item.plural} {counts[outcome]}</span>
    </button>; })}
  </div>;
}
