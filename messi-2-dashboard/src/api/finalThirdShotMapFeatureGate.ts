/** Exact opt-in: any other value leaves the companion endpoint untouched. */
export const finalThirdShotMapEnabled = (env: Record<string, string | boolean | undefined> = import.meta.env) => env.VITE_FINAL_THIRD_SHOT_MAP_ENABLED === "true";
/** Exact opt-in for server-owned effective-shot conversion. v1 remains the default. */
export const finalThirdShotMapV2Enabled = (env: Record<string, string | boolean | undefined> = import.meta.env) => env.VITE_FINAL_THIRD_SHOT_MAP_V2_ENABLED === "true";
