import { afterEach, describe, expect, it, vi } from "vitest";
import { clearPlayerHistoryCache, fetchPlayerSummary } from "./playerHistoryApi";

const config = { baseUrl: "https://api.example.test", season: "2025/2026", scope: 8 as const, limit: 1000 };
const context = { season: "2024/2025", mode: "league" as const, scope: 8 as const, competition: "all" as const };
const player = { id: 1, rank: 1, name: "Player", position: "CF", archetype: "Type A", age: null, minutes: 100, tier: { code: "diamond", level: 1, label: "Diamond" }, score: 90, face: null, nation: null, league: { id: 1, name: "League", icon: null }, club: { id: 2, name: "Club", icon: null }, stats: { outsideShot: 1, boxThreat: 2, dangerZone: 3, aerial: 4, groundDuel: 5, spaceControl: 6 } };
afterEach(() => { vi.restoreAllMocks(); clearPlayerHistoryCache(); });
describe("player history transport", () => {
  it("caches successful summaries but skips 404 failures", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(JSON.stringify({ data: player }), { headers: { "Content-Type": "application/json" } })).mockResolvedValueOnce(new Response("", { status: 404 }));
    await expect(fetchPlayerSummary(config, 1, context, new AbortController().signal)).resolves.toMatchObject({ player: { id: 1 } });
    await expect(fetchPlayerSummary(config, 1, context, new AbortController().signal)).resolves.toMatchObject({ player: { id: 1 } });
    await expect(fetchPlayerSummary(config, 2, context, new AbortController().signal)).rejects.toMatchObject({ status: 404 });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("does not cache an aborted response", async () => {
    const controller = new AbortController(); controller.abort(); const fetcher = vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new DOMException("aborted", "AbortError")).mockResolvedValueOnce(new Response(JSON.stringify({ data: player }), { headers: { "Content-Type": "application/json" } }));
    await expect(fetchPlayerSummary(config, 1, context, controller.signal)).rejects.toBeTruthy();
    await fetchPlayerSummary(config, 1, context, new AbortController().signal); expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("rejects namespaced and unknown-field summary rows", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { ...player, idNamespace: "fotmob" } }), { headers: { "Content-Type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { ...player, unknown: true } }), { headers: { "Content-Type": "application/json" } }));
    await expect(fetchPlayerSummary(config, 1, context, new AbortController().signal)).rejects.toMatchObject({ kind: "schema" });
    await expect(fetchPlayerSummary(config, 1, context, new AbortController().signal)).rejects.toMatchObject({ kind: "schema" });
  });
  it("rejects a valid summary whose player identity does not match the request", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ data: { ...player, id: 2 } }), { headers: { "Content-Type": "application/json" } }));
    await expect(fetchPlayerSummary(config, 1, context, new AbortController().signal)).rejects.toThrow("identity did not match");
  });
});
