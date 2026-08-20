import { DUEL_PRESS_RELEASE, type DuelPressReleaseEvidence } from "../api/duelPressFeatureGate";
export const REQUIRED_DUEL_PRESS_FIXTURES = ["docs/fixtures/duel_press_v1", "fixture7"] as const;
/** Test-only manifest verifier. It is never imported by production entrypoints. */
export function fixtureEvidence(paths: readonly string[], liveVerified = false): DuelPressReleaseEvidence {
  return { fixturePresent: REQUIRED_DUEL_PRESS_FIXTURES.every((required) => paths.some((path) => path.includes(required))), liveVerified, ...DUEL_PRESS_RELEASE };
}
