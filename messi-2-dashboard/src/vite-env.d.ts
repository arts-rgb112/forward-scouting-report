/// <reference types="vite/client" />

interface ImportMetaEnv { readonly VITE_WATCHLIST_V3_ENABLED?: string; readonly VITE_LEGACY_HANDOFF_ENABLED?: string; readonly VITE_VOLUME_BENCHMARK_ENABLED?: string; readonly VITE_RATIO_BENCHMARK_ENABLED?: string; readonly VITE_TACTICAL_SUMMARY_ENABLED?: string }
interface ImportMeta { readonly env: ImportMetaEnv }

interface ImportMetaEnv {
  readonly VITE_DUEL_PRESS_LEADERBOARD_ENABLED?: string;
}

declare module "*.css";
