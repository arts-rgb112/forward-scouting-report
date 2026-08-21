// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import complete from "../../../docs/fixtures/tactical_summary_v1/complete.json";

const transport = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("../api/tacticalSummaryApi", () => ({ fetchTacticalSummary: transport.fetch }));
import { tacticalSummaryEnabled, useTacticalSummary } from "./useTacticalSummary";

const config = { baseUrl: "https://api.example.test", season: "2025/2026", scope: 8 as const, limit: 1000 };
const league = { season: "2025/2026", mode: "league" as const, scope: 8 as const, competition: "all" as const };
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });
describe("use tactical summary", () => {
  it("is independently fail-closed", () => {
    expect(tacticalSummaryEnabled({ VITE_TACTICAL_SUMMARY_ENABLED: "TRUE" })).toBe(false); expect(tacticalSummaryEnabled({ VITE_TACTICAL_SUMMARY_ENABLED: "true" })).toBe(true);
    vi.stubEnv("VITE_TACTICAL_SUMMARY_ENABLED", "false"); renderHook(() => useTacticalSummary(config, 194165, league)); expect(transport.fetch).not.toHaveBeenCalled();
  });
  it("drops stale context data and retries the authoritative request", async () => {
    vi.stubEnv("VITE_TACTICAL_SUMMARY_ENABLED", "true"); const fresh = { ...complete.data, season: "2024/2025" }; let resolveOld!: (value: typeof complete.data) => void;
    transport.fetch.mockReturnValueOnce(new Promise((resolve) => { resolveOld = resolve; })).mockResolvedValueOnce(fresh).mockResolvedValueOnce(fresh);
    const hook = renderHook(({ context }) => useTacticalSummary(config, 194165, context), { initialProps: { context: league } }); hook.rerender({ context: { ...league, season: "2024/2025" } }); await waitFor(() => expect(hook.result.current.state.kind).toBe("ready")); act(() => resolveOld(complete.data));
    if (hook.result.current.state.kind === "ready") expect(hook.result.current.state.data.season).toBe("2024/2025"); act(() => hook.result.current.retry()); await waitFor(() => expect(transport.fetch).toHaveBeenCalledTimes(3));
  });
});
