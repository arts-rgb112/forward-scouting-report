/** Exact opt-in: any other value leaves the companion endpoint untouched. */
export const finalThirdShotMapEnabled = (env: Record<string, string | boolean | undefined> = import.meta.env) => env.VITE_FINAL_THIRD_SHOT_MAP_ENABLED === "true";
