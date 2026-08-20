// @vitest-environment jsdom
import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { samplePlayers } from "../test/fixtures/players";
import { entryFromPlayer } from "./watchlistStorage";
import { legacyV3Entry } from "./watchlistStorageV3";
import { clearLegacyWatchlistResolverSuppression, useLegacyWatchlistResolution } from "./useLegacyWatchlistResolution";

const config = { baseUrl: "https://api.test", season: "2025/2026", scope: 8 as const, limit: 1000 }; const context = { season: "2025/2026", mode: "league" as const, scope: 8 as const, competition: "all" as const };
const snapshot = entryFromPlayer(samplePlayers[0], { season: context.season, mode: "league", scope: 8, competition: null }).snapshot; const entry = legacyV3Entry(samplePlayers[0].id, snapshot, context);
afterEach(() => { clearLegacyWatchlistResolverSuppression(config.baseUrl); sessionStorage.clear(); vi.unstubAllGlobals(); });
describe("legacy V3 resolver bridge", () => {
  it("marks Preview 403 unavailable for the session and does not retry", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response("forbidden", { status: 403 })); vi.stubGlobal("fetch", fetcher);
    const { result, unmount } = renderHook(() => useLegacyWatchlistResolution(config, [entry], true, 0));
    await waitFor(() => expect(result.current[entry.key]?.status).toBe("resolver-unavailable")); expect(fetcher).toHaveBeenCalledTimes(1);
    unmount(); const remounted = renderHook(() => useLegacyWatchlistResolution(config, [entry], true, 0)); await waitFor(() => expect(remounted.result.current[entry.key]?.status).toBe("resolver-unavailable")); expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
