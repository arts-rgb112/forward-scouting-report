/** V2 is opt-in and fail-closed until immutable Preview QA is complete. */
export function duelPressV2Enabled(env: Record<string, unknown> = import.meta.env): boolean {
  return env.VITE_DUEL_PRESS_V2_ENABLED === "true";
}

