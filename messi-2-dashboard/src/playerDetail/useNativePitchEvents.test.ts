// @vitest-environment jsdom
import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, afterEach } from "vitest";
import { useNativePitchEvents } from "./useNativePitchEvents";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const included = JSON.parse(readFileSync(
  resolve(import.meta.dirname, "../../../../messi-specs/evidence/native-pitch-http-20260908-canonical-v2/included.json"),
  "utf-8",
));
const config = { baseUrl: "https://api.example.com", season: "2025/2026", scope: 8 as const, limit: 1000 };
const kaneLeague8 = { season: "2025/2026", mode: "league" as const, scope: 8 as const, competition: "all" as const };

function withSeason(season: string) {
  return {
    ...included,
    context: { ...included.context, season },
    bodyParts: {
      ...included.bodyParts,
      context: { ...included.bodyParts.context, season },
      sources: included.bodyParts.sources.map((source: Record<string, unknown>) => ({ ...source, season })),
    },
  };
}

afterEach(() => { vi.unstubAllGlobals(); });

describe("useNativePitchEvents", () => {
  it("today's real backend state — unmounted production router — surfaces as error, not a silently-seeded fixture", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 404 })));
    const hook = renderHook(() => useNativePitchEvents(config, 194165, kaneLeague8));
    expect(hook.result.current.kind).toBe("loading");
    await waitFor(() => expect(hook.result.current.kind).toBe("error"));
  });

  it("reaches ready once the reviewed route is actually live, with the real fixture shape and default includePenalties=true", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response(JSON.stringify(included), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchSpy);
    const hook = renderHook(() => useNativePitchEvents(config, 194165, kaneLeague8));
    await waitFor(() => expect(hook.result.current.kind).toBe("ready"));
    if (hook.result.current.kind === "ready") expect(hook.result.current.data.events).toHaveLength(119);
    const requestedUrl = new URL(fetchSpy.mock.calls[0][0] as string);
    expect(requestedUrl.searchParams.get("includePenalties")).toBe("true");
  });

  it("drops a late response after the context changes — same context-key/abort discipline as the existing native hooks", async () => {
    let resolveFirst!: (value: Response) => void;
    const fetchSpy = vi.fn()
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { resolveFirst = resolve; }))
      .mockResolvedValueOnce(new Response(JSON.stringify(withSeason("2024/2025")), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchSpy);
    const hook = renderHook(({ dataset }) => useNativePitchEvents(config, 194165, dataset), { initialProps: { dataset: kaneLeague8 } });
    expect(hook.result.current.kind).toBe("loading");
    const nextContext = { season: "2024/2025", mode: "league" as const, scope: 8 as const, competition: "all" as const };
    hook.rerender({ dataset: nextContext });
    await waitFor(() => expect(hook.result.current.kind).toBe("ready"));
    resolveFirst(new Response(JSON.stringify(withSeason("2025/2026")), { status: 200, headers: { "content-type": "application/json" } }));
    // the stale first request's key must never overwrite the state the newer context already reached
    expect(hook.result.current.key).not.toContain("2025/2026");
  });

  it("does not fetch without a resolved API config", () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const hook = renderHook(() => useNativePitchEvents(undefined, 194165, kaneLeague8));
    expect(hook.result.current.kind).toBe("error");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
