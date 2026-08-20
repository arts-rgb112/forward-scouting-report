import { useContext } from "react";
import { WatchlistV3Context, WATCHLIST_V3_ENABLED } from "./WatchlistV3Provider";

export function useWatchlistV3() {
  const value = useContext(WatchlistV3Context);
  if (!value) throw new Error("useWatchlistV3 must be used inside WatchlistV3Provider");
  return value;
}
export function useOptionalWatchlistV3() { return useContext(WatchlistV3Context); }
export { WATCHLIST_V3_ENABLED };
