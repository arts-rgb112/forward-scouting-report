export const PENALTY_SPOT = { x: 89.524, y: 50 } as const;

type PitchCoordinates = { x?: number | null; y?: number | null; pitchX?: number | null; pitchY?: number | null };

/** SportsAPI records penalties at the exact normalized spot; this never rounds a source coordinate. */
export function isPenaltyShot(shot: PitchCoordinates) {
  const x = shot.x ?? shot.pitchX;
  const y = shot.y ?? shot.pitchY;
  return x === PENALTY_SPOT.x && y === PENALTY_SPOT.y;
}

export function excludePenaltyShots<T extends PitchCoordinates>(shots: readonly T[], includePenalties: boolean) {
  return includePenalties ? shots : shots.filter((shot) => !isPenaltyShot(shot));
}

type SummarizableShot = PitchCoordinates & { status?: string; outcome?: string; xg?: number | null };

/** Presentation-only totals over the authoritative shot-event snapshot. */
export function summarizeShots<T extends SummarizableShot>(shots: readonly T[]) {
  const goals = shots.filter((shot) => (shot.status ?? shot.outcome) === "goal").length;
  const xg = shots.reduce((total, shot) => total + (shot.xg ?? 0), 0);
  return { shots: shots.length, goals, xg, conversionRatePct: shots.length ? goals / shots.length * 100 : null } as const;
}

export function penaltyStateLabel(includePenalties: boolean) {
  return includePenalties ? "페널티 포함" : "페널티 제외";
}
