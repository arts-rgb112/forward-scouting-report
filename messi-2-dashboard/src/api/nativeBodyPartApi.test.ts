import { describe, expect, it, vi, afterEach } from "vitest";
import { buildNativeBodyPartUrl, fetchNativeBodyPartStats, NativeBodyPartApiError } from "./nativeBodyPartApi";
import { readFileSync } from "node:fs";

const included = JSON.parse(readFileSync(
  new URL("../../../../messi-specs/fixtures/native-body-parts-kane-2025-2026-quality-v2-included-envelope.json", import.meta.url),
  "utf-8",
));

afterEach(() => { vi.unstubAllGlobals(); });

describe("native-body-part transport", () => {
  it("builds the reviewed route with existing league/Europe context rules plus includePenalties", () => {
    const league = new URL(buildNativeBodyPartUrl("https://api.example.com", 194165, { season: "2025/2026", mode: "league", scope: 8, competition: "all" }, true));
    expect(league.pathname).toBe("/api/v2/players/194165/body-part-shooting-stats");
    expect(league.searchParams.get("scope")).toBe("8");
    expect(league.searchParams.get("competition")).toBe("all");
    expect(league.searchParams.get("includePenalties")).toBe("true");
    const europe = new URL(buildNativeBodyPartUrl("https://api.example.com", 194165, { season: "2025/2026", mode: "europe", scope: 8, competition: "ucl" }, false));
    expect(europe.searchParams.has("scope")).toBe(false);
    expect(europe.searchParams.get("competition")).toBe("ucl");
    expect(europe.searchParams.get("includePenalties")).toBe("false");
  });

  it("today's real 404 (unmounted router) surfaces as not-found, never a fabricated fixture response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 404 })));
    await expect(fetchNativeBodyPartStats(
      { baseUrl: "https://api.example.com", season: "2025/2026", scope: 8, limit: 1000 },
      194165, { season: "2025/2026", mode: "league", scope: 8, competition: "all" }, true, new AbortController().signal,
    )).rejects.toMatchObject({ kind: "not-found" });
  });

  it("accepts the reviewed fixture shape once the route is live and rejects an identity mismatch", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(included), { status: 200, headers: { "content-type": "application/json" } })));
    const config = { baseUrl: "https://api.example.com", season: "2025/2026", scope: 8, limit: 1000 };
    const request = { season: "2025/2026", mode: "league" as const, scope: 8 as const, competition: "all" as const };
    const data = await fetchNativeBodyPartStats(config, 194165, request, true, new AbortController().signal);
    expect(data.parts.rightFoot).toEqual({ shots: 84, goals: 27, quality: { xg: 20.1047, xgot: 21.6327, delta: 1.528, eligible: 84, state: "complete" } });

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(included), { status: 200, headers: { "content-type": "application/json" } })));
    await expect(fetchNativeBodyPartStats(config, 194165, request, false, new AbortController().signal))
      .rejects.toBeInstanceOf(NativeBodyPartApiError);
  });

  it("rejects a malformed body as a schema error, not a silent empty state", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ not: "the contract" }), { status: 200, headers: { "content-type": "application/json" } })));
    await expect(fetchNativeBodyPartStats(
      { baseUrl: "https://api.example.com", season: "2025/2026", scope: 8, limit: 1000 },
      194165, { season: "2025/2026", mode: "league", scope: 8, competition: "all" }, true, new AbortController().signal,
    )).rejects.toMatchObject({ kind: "schema" });
  });
});
