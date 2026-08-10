import { describe, expect, it, vi } from "vitest";

import { MessiApiError } from "./errors";
import { fetchPlayers } from "./playersApi";
import { retryDelay } from "./retry";

const config = { baseUrl: "https://api.example.test", season: "2025/2026", scope: 7 as const, limit: 10 };
const asset = { id: 1, name: "Asset", icon: null };
const payload = {
  data: [{ id: 1, rank: 1, name: "Player", position: "CF", archetype: "Type A", age: null, minutes: 100,
    tier: { code: "diamond", level: 1, label: "Diamond" }, score: 90, face: null, nation: null, league: asset, club: asset,
    stats: { outsideShot: 1, boxThreat: 2, dangerZone: 3, aerial: 4, groundDuel: 5, spaceControl: 6 } }],
  meta: { schemaVersion: "1.0.0", season: "2025/2026", scope: 7, population: 1, returned: 1, generatedAt: "2026-08-10T00:00:00Z", source: "messi-static-cohort" },
};
const jsonResponse = (body: unknown, status = 200, headers?: HeadersInit) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });

describe("players API transport", () => {
  it("retries a retryable HTTP response using Retry-After and then adapts valid data", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(jsonResponse({}, 503, { "Retry-After": "2" })).mockResolvedValueOnce(jsonResponse(payload));
    const sleep = vi.fn().mockResolvedValue(undefined);
    await expect(fetchPlayers(config, new AbortController().signal, { fetch: fetcher, sleep })).resolves.toMatchObject({ players: [{ id: 1 }] });
    expect(sleep).toHaveBeenCalledWith(2000, expect.any(AbortSignal));
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("does not retry a non-retryable HTTP response", async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({}, 404));
    await expect(fetchPlayers(config, new AbortController().signal, { fetch: fetcher })).rejects.toMatchObject({ kind: "http", status: 404 } satisfies Partial<MessiApiError>);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("turns malformed successful responses into schema errors", async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({ data: [], meta: {} }));
    await expect(fetchPlayers(config, new AbortController().signal, { fetch: fetcher })).rejects.toMatchObject({ kind: "schema" } satisfies Partial<MessiApiError>);
  });

  it("retries network failures and preserves an abort without another retry", async () => {
    const networkFetch = vi.fn().mockRejectedValueOnce(new TypeError("offline")).mockResolvedValueOnce(jsonResponse(payload));
    const sleep = vi.fn().mockResolvedValue(undefined);
    await expect(fetchPlayers(config, new AbortController().signal, { fetch: networkFetch, sleep, random: () => 0 })).resolves.toMatchObject({ players: [{ id: 1 }] });
    expect(sleep).toHaveBeenCalledWith(500, expect.any(AbortSignal));
    const aborted = new AbortController(); aborted.abort();
    const abortFetch = vi.fn().mockRejectedValue(new DOMException("Aborted", "AbortError"));
    await expect(fetchPlayers(config, aborted.signal, { fetch: abortFetch })).rejects.toMatchObject({ name: "AbortError" });
    expect(abortFetch).toHaveBeenCalledTimes(1);
  });
});

describe("retry delay", () => {
  it("honors bounded seconds and HTTP-date Retry-After values before exponential fallback", () => {
    expect(retryDelay(0, "120", 0, () => 0)).toBe(30_000);
    expect(retryDelay(0, new Date(5_000).toUTCString(), 0, () => 0)).toBe(5_000);
    expect(retryDelay(1, null, 0, () => 0)).toBe(1500);
  });
});
