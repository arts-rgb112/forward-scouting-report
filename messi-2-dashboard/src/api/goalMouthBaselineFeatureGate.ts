/** Exact opt-in: every value except the literal string "true" leaves the global baseline idle. */
export const goalMouthBaselineEnabled = (env: Record<string, string | boolean | undefined> = import.meta.env) => env.VITE_GOAL_MOUTH_BASELINE_ENABLED === "true";
