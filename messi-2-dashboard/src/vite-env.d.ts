/// <reference types="vite/client" />

interface ImportMetaEnv { readonly VITE_WATCHLIST_V3_ENABLED?: string; readonly VITE_VOLUME_BENCHMARK_ENABLED?: string; readonly VITE_RATIO_BENCHMARK_ENABLED?: string; readonly VITE_TACTICAL_SUMMARY_ENABLED?: string; readonly VITE_DUEL_PRESS_V2_ENABLED?: string; readonly VITE_GOAL_MOUTH_BASELINE_ENABLED?: string; readonly VITE_BENCHMARK_RADAR_V2_ENABLED?: string; readonly VITE_GA_MEASUREMENT_ID?: string }
interface ImportMeta { readonly env: ImportMetaEnv }

interface ImportMetaEnv {
  readonly VITE_DUEL_PRESS_LEADERBOARD_ENABLED?: string;
}

declare module "*.css";
