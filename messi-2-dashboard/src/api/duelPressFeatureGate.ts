export const DUEL_PRESS_RELEASE = { api: "2.3.0", schema: "1.1.0", taxonomy: "duel-press-v1", readiness: "pressing-source-coverage-2026-08-18", covered: 6061, population: 6157 } as const;
export type DuelPressReleaseEvidence = { fixturePresent: boolean; liveVerified: boolean; api: string; schema: string; taxonomy: string; readiness: string; covered: number; population: number };
export type DuelPressFeatureState = { requested: boolean; enabled: boolean; activated: boolean; blocker: "NOT_REQUESTED" | "RELEASE_VERIFICATION_MISSING" | null };
export function evaluateDuelPressFeature(env: Record<string, unknown>, evidence?: DuelPressReleaseEvidence): DuelPressFeatureState {
  const requested = env.VITE_DUEL_PRESS_LEADERBOARD_ENABLED === "true";
  if (!requested) return { requested: false, enabled: false, activated: false, blocker: "NOT_REQUESTED" };
  const enabled = Boolean(evidence?.fixturePresent && evidence.liveVerified
    && evidence.api === DUEL_PRESS_RELEASE.api && evidence.schema === DUEL_PRESS_RELEASE.schema
    && evidence.taxonomy === DUEL_PRESS_RELEASE.taxonomy && evidence.readiness === DUEL_PRESS_RELEASE.readiness
    && evidence.covered === DUEL_PRESS_RELEASE.covered && evidence.population === DUEL_PRESS_RELEASE.population);
  return { requested: true, enabled, activated: false, blocker: enabled ? null : "RELEASE_VERIFICATION_MISSING" };
}
export const activateParsedResource = (state: DuelPressFeatureState): DuelPressFeatureState => state.enabled ? { ...state, activated: true } : state;
