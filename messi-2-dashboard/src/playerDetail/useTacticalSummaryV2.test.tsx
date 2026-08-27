// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
const transport = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("../api/tacticalSummaryV2Api", () => ({ fetchTacticalSummaryV2: transport.fetch }));
import { useTacticalSummaryV2 } from "./useTacticalSummaryV2";
import { tacticalSummaryV2Fixture } from "../test/fixtures/tacticalSummaryV2";
const config={baseUrl:"https://api.example.test",season:"2025/2026",scope:7,limit:1000}; const scope7={season:"2025/2026",mode:"league" as const,scope:7 as const,competition:"all" as const};
afterEach(()=>{vi.unstubAllEnvs();vi.clearAllMocks();});
describe("useTacticalSummaryV2",()=>{
  it("does not fetch while the v2 flag is disabled",()=>{vi.stubEnv("VITE_TACTICAL_SUMMARY_V2_ENABLED","false");renderHook(()=>useTacticalSummaryV2(config,194165,scope7));expect(transport.fetch).not.toHaveBeenCalled();});
  it("uses a complete context key and ignores a stale response",async()=>{vi.stubEnv("VITE_TACTICAL_SUMMARY_V2_ENABLED","true");let old!: (value: ReturnType<typeof tacticalSummaryV2Fixture>["data"])=>void;transport.fetch.mockImplementationOnce(()=>new Promise(resolve=>{old=resolve;})).mockResolvedValueOnce(tacticalSummaryV2Fixture().data);const hook=renderHook(({context})=>useTacticalSummaryV2(config,194165,context),{initialProps:{context:scope7}});hook.rerender({context:{...scope7,scope:8}});await waitFor(()=>expect(hook.result.current.state.kind).toBe("ready"));act(()=>old(tacticalSummaryV2Fixture().data));expect(hook.result.current.state.kind).toBe("ready");expect(transport.fetch).toHaveBeenCalledTimes(2);});
});
