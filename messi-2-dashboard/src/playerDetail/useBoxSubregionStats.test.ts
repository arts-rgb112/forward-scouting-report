// @vitest-environment jsdom
import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, afterEach } from "vitest";
import { useBoxSubregionStats } from "./useBoxSubregionStats";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// import.meta.url does not resolve to a real filesystem path under the jsdom
// environment, unlike the node-environment contract/api test files — resolve
// from the package cwd instead.
const fixture = JSON.parse(readFileSync(
  resolve(import.meta.dirname, "../../../../messi-specs/fixtures/box-subregion-kane-2025-2026-league8.json"),
  "utf-8",
));
const config = { baseUrl: "https://api.example.com", season: "2025/2026", scope: 8 as const, limit: 1000 };
const kaneLeague8 = { season: "2025/2026", mode: "league" as const, scope: 8 as const, competition: "all" as const };

afterEach(() => { vi.unstubAllGlobals(); });

describe("useBoxSubregionStats", () => {
  it("today's real backend state — unmounted router — surfaces as error, not a silently-seeded fixture", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 404 })));
    const hook = renderHook(() => useBoxSubregionStats(config, 194165, kaneLeague8));
    expect(hook.result.current.kind).toBe("loading");
    await waitFor(() => expect(hook.result.current.kind).toBe("error"));
  });

  it("reaches ready once the reviewed route is actually live, with the real fixture shape", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(fixture), { status: 200, headers: { "content-type": "application/json" } })));
    const hook = renderHook(() => useBoxSubregionStats(config, 194165, kaneLeague8));
    await waitFor(() => expect(hook.result.current.kind).toBe("ready"));
    if (hook.result.current.kind === "ready") expect(hook.result.current.data.regions.map((r) => r.shots)).toEqual([9, 31, 33, 11]);
  });

  it("drops a late response after the context changes — the same context-key/abort discipline as the existing hooks", async () => {
    let resolveFirst!: (value: Response) => void;
    const fetchSpy = vi.fn()
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { resolveFirst = resolve; }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ...fixture, context: { ...fixture.context, season: "2024/2025" } }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchSpy);
    const hook = renderHook(({ dataset }) => useBoxSubregionStats(config, 194165, dataset), { initialProps: { dataset: kaneLeague8 } });
    expect(hook.result.current.kind).toBe("loading");
    const nextContext = { season: "2024/2025", mode: "league" as const, scope: 8 as const, competition: "all" as const };
    hook.rerender({ dataset: nextContext });
    await waitFor(() => expect(hook.result.current.kind).toBe("ready"));
    resolveFirst(new Response(JSON.stringify({ ...fixture, context: { ...fixture.context, season: "2025/2026" } }), { status: 200, headers: { "content-type": "application/json" } }));
    // the stale first request must never overwrite the state the newer context already reached
    expect(hook.result.current.key).not.toContain("2025/2026");
  });

  it("does not fetch without a resolved API config", () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const hook = renderHook(() => useBoxSubregionStats(undefined, 194165, kaneLeague8));
    expect(hook.result.current.kind).toBe("error");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
