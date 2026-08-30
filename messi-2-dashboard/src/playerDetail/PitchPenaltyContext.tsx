import { createContext, useContext, useState, type ReactNode } from "react";

import { penaltyStateLabel } from "./pitchPenalties";
import type { ShotmapPoint } from "../dashboard/types";

type PenaltyState = { includePenalties: boolean; setIncludePenalties: (value: boolean) => void; summaryShots?: readonly ShotmapPoint[] };
const PenaltyContext = createContext<PenaltyState>({ includePenalties: true, setIncludePenalties: () => undefined });

export function PitchPenaltyProvider({ children, summaryShots }: { children: ReactNode; summaryShots?: readonly ShotmapPoint[] }) {
  const [includePenalties, setIncludePenalties] = useState(true);
  return <PenaltyContext.Provider value={{ includePenalties, setIncludePenalties, summaryShots }}>{children}</PenaltyContext.Provider>;
}

export function usePitchPenalty() {
  return useContext(PenaltyContext);
}

/** One parent-owned control keeps every pitch view on the same observed shot set. */
export function PitchPenaltyToggle() {
  const { includePenalties, setIncludePenalties } = usePitchPenalty();
  return <div data-pitch-penalty-toggle role="group" aria-label="페널티킥 표시" className="mt-2 flex flex-wrap items-center gap-1 rounded-lg border border-white/15 bg-black/30 p-1">
    {[true, false].map((next) => <button key={String(next)} type="button" aria-pressed={includePenalties === next} onClick={() => setIncludePenalties(next)} className="min-h-9 rounded px-3 text-base font-bold aria-pressed:bg-amber-300 aria-pressed:text-zinc-950 focus-visible:ring-2 focus-visible:ring-amber-200">{penaltyStateLabel(next)}</button>)}
  </div>;
}
