import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchTacticalSummaryV2, tacticalSummaryV2Url } from "./tacticalSummaryV2Api";
import { tacticalSummaryV2Fixture } from "../test/fixtures/tacticalSummaryV2";
const config = { baseUrl: "https://api.example.test", season: "2025/2026", scope: 7, limit: 1000 };
afterEach(() => vi.unstubAllGlobals());
describe("tactical-summary-v2 transport", () => {
  it("uses the isolated endpoint and exact league context", () => { const url=tacticalSummaryV2Url(config,194165,{season:"2025/2026",mode:"league",scope:7,competition:"all"}); const scope8=tacticalSummaryV2Url(config,194165,{season:"2025/2026",mode:"league",scope:8,competition:"all"}); expect(url.pathname).toBe("/api/v2/players/194165/tactical-summary-v2"); expect(url.search).toContain("scope=7"); expect(url.search).toContain("competition=all"); expect(scope8.search).toContain("scope=8"); expect(scope8.href).not.toBe(url.href); });
  it("rejects a server identity that differs from the request", async () => { vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(tacticalSummaryV2Fixture()), { status: 200 }))); await expect(fetchTacticalSummaryV2(config,194165,{season:"2024/2025",mode:"league",scope:7,competition:"all"},new AbortController().signal)).rejects.toMatchObject({kind:"schema"}); });
});
