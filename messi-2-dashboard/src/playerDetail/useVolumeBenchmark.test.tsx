// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
const transport = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("../api/volumeBenchmarkApi", () => ({ fetchVolumeBenchmark: transport.fetch }));
import { benchmarkEnvelope } from "../test/volumeBenchmarkFixtures";
import { useVolumeBenchmark, volumeBenchmarkEnabled } from "./useVolumeBenchmark";
const config={baseUrl:"https://api.example.test",season:"2025/2026",scope:8 as const,limit:1000}; const league={season:"2025/2026",mode:"league" as const,scope:8 as const,competition:"all" as const};
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });
describe("use volume benchmark", () => {
  it("enables only the literal string true", () => { expect(volumeBenchmarkEnabled({VITE_VOLUME_BENCHMARK_ENABLED:true})).toBe(false); expect(volumeBenchmarkEnabled({VITE_VOLUME_BENCHMARK_ENABLED:"true"})).toBe(true); });
  it("makes no request while disabled", () => { const hook=renderHook(()=>useVolumeBenchmark(config,1,league)); expect(hook.result.current.state.kind).toBe("disabled"); expect(transport.fetch).not.toHaveBeenCalled(); });
  it("drops a late old-context response and retry requests again", async () => { vi.stubEnv("VITE_VOLUME_BENCHMARK_ENABLED","true"); const oldData={...benchmarkEnvelope.data,axes:benchmarkEnvelope.data.axes.map((axis)=>({...axis,playerScore:99}))}; const newData={...benchmarkEnvelope.data,season:"2024/2025",axes:benchmarkEnvelope.data.axes.map((axis)=>({...axis,playerScore:11}))}; let resolveOld!: (value: typeof benchmarkEnvelope.data)=>void; transport.fetch.mockReturnValueOnce(new Promise((resolve)=>{resolveOld=resolve;})).mockResolvedValueOnce(newData).mockResolvedValueOnce(newData); const hook=renderHook(({context})=>useVolumeBenchmark(config,1,context),{initialProps:{context:league}}); hook.rerender({context:{...league,season:"2024/2025"}}); await waitFor(()=>expect(hook.result.current.state.kind).toBe("ready")); act(()=>resolveOld(oldData)); expect(hook.result.current.state.kind).toBe("ready"); if(hook.result.current.state.kind==="ready") expect(hook.result.current.state.data.axes[0].playerScore).toBe(11); act(()=>hook.result.current.retry()); await waitFor(()=>expect(transport.fetch).toHaveBeenCalledTimes(3)); });
});
