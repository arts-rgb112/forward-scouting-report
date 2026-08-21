// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import observedZeroImputed from "../../../docs/fixtures/ratio_benchmark_v1/observed_zero_imputed.json";

const transport = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("../api/ratioBenchmarkApi", () => ({ fetchRatioBenchmark: transport.fetch }));
import { ratioBenchmarkEnabled, useRatioBenchmark } from "./useRatioBenchmark";

const config = { baseUrl: "https://api.example.test", season: "2025/2026", scope: 8 as const, limit: 1000 };
const league = { season: "2025/2026", mode: "league" as const, scope: 8 as const, competition: "all" as const };
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });
describe("use ratio benchmark", () => {
  it("enables only the literal string true and makes no disabled request", () => {
    expect(ratioBenchmarkEnabled({ VITE_RATIO_BENCHMARK_ENABLED: true })).toBe(false); expect(ratioBenchmarkEnabled({ VITE_RATIO_BENCHMARK_ENABLED: "true" })).toBe(true);
    vi.stubEnv("VITE_RATIO_BENCHMARK_ENABLED", "1"); renderHook(() => useRatioBenchmark(config, 1, league)); expect(transport.fetch).not.toHaveBeenCalled();
  });
  it("aborts obsolete work, ignores stale generations, and retries", async () => {
    vi.stubEnv("VITE_RATIO_BENCHMARK_ENABLED", "true"); const old = { ...observedZeroImputed.data, axes: observedZeroImputed.data.axes.map((axis) => ({ ...axis, playerScore: 99 })) }; const fresh = { ...observedZeroImputed.data, season: "2024/2025", axes: observedZeroImputed.data.axes.map((axis) => ({ ...axis, playerScore: 0 })) };
    let resolveOld!: (value: typeof old) => void; transport.fetch.mockReturnValueOnce(new Promise((resolve) => { resolveOld = resolve; })).mockResolvedValueOnce(fresh).mockResolvedValueOnce(fresh);
    const hook = renderHook(({ context }) => useRatioBenchmark(config, 1, context), { initialProps: { context: league } }); hook.rerender({ context: { ...league, season: "2024/2025" } });
    await waitFor(() => expect(hook.result.current.state.kind).toBe("ready")); act(() => resolveOld(old)); if (hook.result.current.state.kind === "ready") expect(hook.result.current.state.data.season).toBe("2024/2025");
    act(() => hook.result.current.retry()); await waitFor(() => expect(transport.fetch).toHaveBeenCalledTimes(3));
  });
});
