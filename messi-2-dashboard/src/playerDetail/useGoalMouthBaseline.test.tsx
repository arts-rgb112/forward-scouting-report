// @vitest-environment jsdom
import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useGoalMouthBaseline } from "./useGoalMouthBaseline";
import { goalMouthBaselineFixture } from "../test/fixtures/goalMouthBaseline";
const config = { baseUrl: "https://api.example.com", season: "2025/2026", scope: 8 as const, limit: 50 };
describe("useGoalMouthBaseline", () => {
  it("does not issue a disabled request", () => { vi.stubEnv("VITE_GOAL_MOUTH_BASELINE_ENABLED", "false"); const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher); expect(renderHook(() => useGoalMouthBaseline(config)).result.current.state.kind).toBe("disabled"); expect(fetcher).not.toHaveBeenCalled(); });
  it("loads the single global payload only when exactly enabled", async () => { vi.stubEnv("VITE_GOAL_MOUTH_BASELINE_ENABLED", "true"); vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(goalMouthBaselineFixture)))); const hook = renderHook(() => useGoalMouthBaseline(config)); await waitFor(() => expect(hook.result.current.state.kind).toBe("ready")); });
});
