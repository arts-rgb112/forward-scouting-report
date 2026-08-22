// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
const transport = vi.hoisted(() => ({ fetch: vi.fn() })); vi.mock("../api/finalThirdShotMapApi", () => ({ fetchFinalThirdShotMap: transport.fetch, finalThirdShotMapResourceKey: (id: number, context: { season: string }) => `${id}:${context.season}` }));
import { finalThirdShotMapFixture } from "../test/fixtures/finalThirdShotMap";
import { useFinalThirdShotMap } from "./useFinalThirdShotMap";
const config = { baseUrl: "https://api.test", season: "2025/2026", scope: 8 as const, limit: 1000 }, league = { season: "2025/2026", mode: "league" as const, scope: 8 as const, competition: "all" as const };
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });
describe("use final-third shot map", () => {
  it("is exact-gated and makes no disabled request", () => { vi.stubEnv("VITE_FINAL_THIRD_SHOT_MAP_ENABLED", "false"); expect(renderHook(() => useFinalThirdShotMap(config, 1, league)).result.current.state.kind).toBe("disabled"); expect(transport.fetch).not.toHaveBeenCalled(); });
  it("aborts and drops old-context responses", async () => { vi.stubEnv("VITE_FINAL_THIRD_SHOT_MAP_ENABLED", "true"); let resolveOld!: (value: typeof finalThirdShotMapFixture) => void; const current = structuredClone(finalThirdShotMapFixture); current.context.season = "2024/2025"; transport.fetch.mockReturnValueOnce(new Promise((resolve) => { resolveOld = resolve; })).mockResolvedValueOnce(current); const hook = renderHook(({ context }) => useFinalThirdShotMap(config, 194165, context), { initialProps: { context: league } }); hook.rerender({ context: { ...league, season: "2024/2025" } }); await waitFor(() => expect(hook.result.current.state.kind).toBe("partial")); act(() => resolveOld(finalThirdShotMapFixture)); expect(hook.result.current.state.kind).toBe("partial"); });
});
