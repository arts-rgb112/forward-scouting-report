import { afterEach, describe, expect, it, vi } from "vitest";
import observedZeroImputed from "../../../docs/fixtures/ratio_benchmark_v1/observed_zero_imputed.json";
import europeAll from "../../../docs/fixtures/ratio_benchmark_v1/europe_all_observed_zero_imputed.json";
import success from "../../../docs/fixtures/ratio_benchmark_v1/success.json";

import { fetchRatioBenchmark } from "./ratioBenchmarkApi";

const config = { baseUrl: "https://api.example.test", season: "2025/2026", scope: 8 as const, limit: 1000 };
afterEach(() => vi.restoreAllMocks());
describe("ratio benchmark API", () => {
  it("serializes League and Europe contexts exactly with fixed benchmark scope", async () => {
    const uclFixture = { ...observedZeroImputed, data: { ...observedZeroImputed.data, sourceContext: { mode: "europe", scope: null, competition: "ucl" } } };
    const request = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify(success)))
      .mockResolvedValueOnce(new Response(JSON.stringify(uclFixture)))
      .mockResolvedValueOnce(new Response(JSON.stringify(europeAll)));
    await fetchRatioBenchmark(config, 194165, { season: "2025/2026", mode: "league", scope: 8, competition: "all" }, new AbortController().signal);
    const league = new URL(String(request.mock.calls[0][0])); expect(league.searchParams.get("scope")).toBe("8"); expect(league.searchParams.get("competition")).toBe("all"); expect(league.searchParams.get("benchmarkScope")).toBe("8");
    await fetchRatioBenchmark(config, 1, { season: "2025/2026", mode: "europe", scope: 8, competition: "ucl" }, new AbortController().signal);
    const europe = new URL(String(request.mock.calls[1][0])); expect(europe.searchParams.has("scope")).toBe(false); expect(europe.searchParams.get("competition")).toBe("ucl");
    await fetchRatioBenchmark(config, 1, { season: "2025/2026", mode: "europe", scope: 8, competition: "all" }, new AbortController().signal);
    const europeAllUrl = new URL(String(request.mock.calls[2][0])); expect(europeAllUrl.searchParams.has("scope")).toBe(false); expect(europeAllUrl.searchParams.get("competition")).toBe("all"); expect(europeAllUrl.searchParams.get("benchmarkScope")).toBe("8");
  });
  it("fails closed on mismatched source context", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify(success)));
    await expect(fetchRatioBenchmark(config, 194165, { season: "2025/2026", mode: "europe", scope: 8, competition: "ucl" }, new AbortController().signal)).rejects.toMatchObject({ kind: "schema" });
  });
});
