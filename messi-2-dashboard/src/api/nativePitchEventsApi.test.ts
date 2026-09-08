import { describe, expect, it, vi, afterEach } from "vitest";
import { buildNativePitchEventsUrl, fetchNativePitchEvents, NativePitchEventsApiError } from "./nativePitchEventsApi";
import { readFileSync } from "node:fs";

const included = JSON.parse(readFileSync(
  new URL("../../../../messi-specs/evidence/native-pitch-http-20260908-canonical-v2/included.json", import.meta.url),
  "utf-8",
));

afterEach(() => { vi.unstubAllGlobals(); });

describe("native-pitch-events transport", () => {
  it("builds the reviewed route with existing league/Europe context rules plus includePenalties", () => {
    const league = new URL(buildNativePitchEventsUrl("https://api.example.com", 194165, { season: "2025/2026", mode: "league", scope: 8, competition: "all" }, true));
    expect(league.pathname).toBe("/api/v2/players/194165/native-pitch-events");
    expect(league.searchParams.get("scope")).toBe("8");
    expect(league.searchParams.get("includePenalties")).toBe("true");
    const europe = new URL(buildNativePitchEventsUrl("https://api.example.com", 194165, { season: "2025/2026", mode: "europe", scope: 8, competition: "ucl" }, false));
    expect(europe.searchParams.has("scope")).toBe(false);
    expect(europe.searchParams.get("competition")).toBe("ucl");
  });

  it("today's real 404 (unmounted production router) surfaces as not-found, never a fabricated fixture response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 404 })));
    await expect(fetchNativePitchEvents(
      { baseUrl: "https://api.example.com", season: "2025/2026", scope: 8, limit: 1000 },
      194165, { season: "2025/2026", mode: "league", scope: 8, competition: "all" }, true, new AbortController().signal,
    )).rejects.toMatchObject({ kind: "not-found" });
  });

  it("accepts the reviewed real fixture shape once the route is live and rejects an identity mismatch", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(included), { status: 200, headers: { "content-type": "application/json" } })));
    const config = { baseUrl: "https://api.example.com", season: "2025/2026", scope: 8, limit: 1000 };
    const request = { season: "2025/2026", mode: "league" as const, scope: 8 as const, competition: "all" as const };
    const data = await fetchNativePitchEvents(config, 194165, request, true, new AbortController().signal);
    expect(data.events).toHaveLength(119);

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(included), { status: 200, headers: { "content-type": "application/json" } })));
    await expect(fetchNativePitchEvents(config, 194165, request, false, new AbortController().signal))
      .rejects.toBeInstanceOf(NativePitchEventsApiError);
  });

  it("rejects a malformed body as a schema error, not a silent empty state", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ not: "the contract" }), { status: 200, headers: { "content-type": "application/json" } })));
    await expect(fetchNativePitchEvents(
      { baseUrl: "https://api.example.com", season: "2025/2026", scope: 8, limit: 1000 },
      194165, { season: "2025/2026", mode: "league", scope: 8, competition: "all" }, true, new AbortController().signal,
    )).rejects.toMatchObject({ kind: "schema" });
  });
});
