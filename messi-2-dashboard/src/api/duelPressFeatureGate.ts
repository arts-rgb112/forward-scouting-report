export const DUEL_PRESS_RELEASE = { api: "2.3.0", schema: "1.1.0", taxonomy: "duel-press-v1", readiness: "pressing-source-coverage-2026-08-18", covered: 6061, population: 6157 } as const;
export type LeaderboardTaxonomyMode = "legacy-v1" | "duel-press-v1";
/** Explicit false is the rollback switch. Unset production defaults to the finalized companion contract; tests/dev retain legacy unless explicitly enabled. */
export function leaderboardTaxonomyMode(env: Record<string, unknown>, mode: string): LeaderboardTaxonomyMode {
  const value = env.VITE_DUEL_PRESS_LEADERBOARD_ENABLED;
  if (value === "false") return "legacy-v1";
  if (value === "true") return "duel-press-v1";
  return mode === "production" ? "duel-press-v1" : "legacy-v1";
}
