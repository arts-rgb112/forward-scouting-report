import { afterEach, describe, expect, it, vi } from "vitest";
import complete from "../../../docs/fixtures/tactical_summary_v1/complete.json";
import europeAll from "../../../docs/fixtures/tactical_summary_v1/europe_all_partial_source_imputed.json";
import partial from "../../../docs/fixtures/tactical_summary_v1/partial_source_imputed.json";

import { fetchTacticalSummary } from "./tacticalSummaryApi";

const config = { baseUrl: "https://api.example.test", season: "2025/2026", scope: 8 as const, limit: 1000 };
afterEach(() => vi.restoreAllMocks());
describe("tactical summary API", () => {
  it("serializes League and Europe contexts exactly", async () => {
    const request = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(JSON.stringify(complete))).mockResolvedValueOnce(new Response(JSON.stringify(partial))).mockResolvedValueOnce(new Response(JSON.stringify(europeAll)));
    await fetchTacticalSummary(config, 194165, { season: "2025/2026", mode: "league", scope: 8, competition: "all" }, new AbortController().signal);
    const league = new URL(String(request.mock.calls[0][0])); expect(league.searchParams.get("scope")).toBe("8"); expect(league.searchParams.get("competition")).toBe("all");
    await fetchTacticalSummary(config, 1, { season: "2025/2026", mode: "europe", scope: 8, competition: "ucl" }, new AbortController().signal);
    const europe = new URL(String(request.mock.calls[1][0])); expect(europe.searchParams.has("scope")).toBe(false); expect(europe.searchParams.get("competition")).toBe("ucl");
    await fetchTacticalSummary(config, 1, { season: "2025/2026", mode: "europe", scope: 8, competition: "all" }, new AbortController().signal);
    const europeAllUrl = new URL(String(request.mock.calls[2][0])); expect(europeAllUrl.searchParams.has("scope")).toBe(false); expect(europeAllUrl.searchParams.get("competition")).toBe("all");
  });
  it("fails closed on mismatched request identity", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ ...complete, data: { ...complete.data, playerId: 1 } })));
    await expect(fetchTacticalSummary(config, 194165, { season: "2025/2026", mode: "league", scope: 8, competition: "all" }, new AbortController().signal)).rejects.toMatchObject({ kind: "schema" });
  });
});
