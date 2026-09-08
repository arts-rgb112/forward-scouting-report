// @vitest-environment jsdom
import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, afterEach } from "vitest";
import { useNativeBodyPartStats } from "./useNativeBodyPartStats";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// import.meta.url does not resolve to a real filesystem path under the jsdom
// environment, unlike the node-environment contract/api test files — resolve
// from the package cwd instead.
const included = JSON.parse(readFileSync(
  resolve(import.meta.dirname, "../../../../messi-specs/fixtures/native-body-parts-kane-2025-2026-quality-v2-included-envelope.json"),
  "utf-8",
));
const config = { baseUrl: "https://api.example.com", season: "2025/2026", scope: 8 as const, limit: 1000 };
const kaneLeague8 = { season: "2025/2026", mode: "league" as const, scope: 8 as const, competition: "all" as const };

/** A season-shifted envelope must be internally consistent — the decoder now
 * validates each source's own season against the envelope context, so a
 * mock cannot change one without the other and still pass. */
function withSeason(season: string) {
  return { ...included, context: { ...included.context, season }, sources: included.sources.map((source: Record<string, unknown>) => ({ ...source, season })) };
}

afterEach(() => { vi.unstubAllGlobals(); });

describe("useNativeBodyPartStats", () => {
  it("today's real backend state — unmounted router — surfaces as error, not a silently-seeded fixture", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 404 })));
    const hook = renderHook(() => useNativeBodyPartStats(config, 194165, kaneLeague8));
    expect(hook.result.current.kind).toBe("loading");
    await waitFor(() => expect(hook.result.current.kind).toBe("error"));
  });

  it("reaches ready once the reviewed route is actually live, with the real fixture shape and default includePenalties=true", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response(JSON.stringify(included), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchSpy);
    const hook = renderHook(() => useNativeBodyPartStats(config, 194165, kaneLeague8));
    await waitFor(() => expect(hook.result.current.kind).toBe("ready"));
    if (hook.result.current.kind === "ready") expect(hook.result.current.data.parts.rightFoot).toEqual({ shots: 84, goals: 27, quality: { xg: 20.1047, xgot: 21.6327, delta: 1.528, eligible: 84, state: "complete" } });
    const requestedUrl = new URL(fetchSpy.mock.calls[0][0] as string);
    expect(requestedUrl.searchParams.get("includePenalties")).toBe("true");
  });

  it("drops a late response after the context changes — the same context-key/abort discipline as the existing hooks", async () => {
    let resolveFirst!: (value: Response) => void;
    const fetchSpy = vi.fn()
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { resolveFirst = resolve; }))
      .mockResolvedValueOnce(new Response(JSON.stringify(withSeason("2024/2025")), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchSpy);
    const hook = renderHook(({ dataset }) => useNativeBodyPartStats(config, 194165, dataset), { initialProps: { dataset: kaneLeague8 } });
    expect(hook.result.current.kind).toBe("loading");
    const nextContext = { season: "2024/2025", mode: "league" as const, scope: 8 as const, competition: "all" as const };
    hook.rerender({ dataset: nextContext });
    await waitFor(() => expect(hook.result.current.kind).toBe("ready"));
    resolveFirst(new Response(JSON.stringify(withSeason("2025/2026")), { status: 200, headers: { "content-type": "application/json" } }));
    // the stale first request must never overwrite the state the newer context already reached
    expect(hook.result.current.key).not.toContain("2025/2026");
  });

  it("does not fetch without a resolved API config", () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const hook = renderHook(() => useNativeBodyPartStats(undefined, 194165, kaneLeague8));
    expect(hook.result.current.kind).toBe("error");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
