// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import validLeaderboard from "../../../docs/fixtures/duel_press_v1/valid_leaderboard.json";
import { duelPressPlayerSchema } from "../api/duelPressContracts";
import { WATCHLIST_V3_KEY } from "./watchlistV3Contracts";
import { parseWatchlistV3 } from "./watchlistV3Contracts";
import { duelPressEntry } from "./watchlistStorageV3";

const player = duelPressPlayerSchema.parse(validLeaderboard.data[0]); const context = { season: "2025/2026", mode: "league" as const, scope: 8 as const, competition: "all" as const };
beforeEach(() => { localStorage.clear(); vi.stubEnv("VITE_WATCHLIST_V3_ENABLED", "true"); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });
async function setup(withTestLock = true) {
  vi.resetModules(); const module = await import("./WatchlistV3Provider");
  function Harness() { return <module.WatchlistV3Context.Consumer>{(value) => <><button type="button" aria-pressed={value?.isWatched("duel-press-v1", player.id, context) ?? false} onClick={() => { void value?.toggleDuel(player, context); }}>Toggle exact context</button><p role="status">{value?.feedback}</p><output>{value?.watchCount ?? 0}</output></>}</module.WatchlistV3Context.Consumer>; }
  const repository = await import("./watchlistV3Repository"); const provider = withTestLock ? <module.WatchlistV3Provider lockCoordinator={repository.createMemoryWatchlistV3LockCoordinator()}><Harness /></module.WatchlistV3Provider> : <module.WatchlistV3Provider><Harness /></module.WatchlistV3Provider>; render(provider);
}
describe("Watchlist V3 provider persistence safety", () => {
  it("uses actual Web Locks support by default and refuses mutations when it is absent", async () => {
    await setup(false); const button = screen.getByRole("button", { name: "Toggle exact context" }); expect(screen.getByText(/does not support Web Locks/i)).toBeInTheDocument(); fireEvent.click(button); await waitFor(() => expect(button).toHaveAttribute("aria-pressed", "false")); expect(parseWatchlistV3(localStorage.getItem(WATCHLIST_V3_KEY))?.entries).toHaveLength(0);
  });
  it("turns readonly on an invalid storage event and never overwrites corrupt raw", async () => {
    await setup(); const button = screen.getByRole("button", { name: "Toggle exact context" }); fireEvent.click(button); await waitFor(() => expect(button).toHaveAttribute("aria-pressed", "true"));
    localStorage.setItem(WATCHLIST_V3_KEY, "corrupt-runtime-value"); dispatchEvent(new StorageEvent("storage", { key: WATCHLIST_V3_KEY, newValue: "corrupt-runtime-value" })); await screen.findByText(/became corrupt/i);
    fireEvent.click(button); await waitFor(() => expect(screen.getByText(/became corrupt/i)).toBeInTheDocument()); expect(localStorage.getItem(WATCHLIST_V3_KEY)).toBe("corrupt-runtime-value"); expect(button).toHaveAttribute("aria-pressed", "true");
  });
  it("rolls optimistic state back and announces quota failure", async () => {
    await setup(); const original = Storage.prototype.setItem; const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (key, value) { if (key === WATCHLIST_V3_KEY) throw new DOMException("quota", "QuotaExceededError"); return original.call(this, key, value); });
    const button = screen.getByRole("button", { name: "Toggle exact context" }); fireEvent.click(button); await waitFor(() => expect(screen.getByText(/could not be saved/i)).toBeInTheDocument()); expect(button).toHaveAttribute("aria-pressed", "false"); expect(screen.getByText("0")).toBeInTheDocument(); spy.mockRestore();
  });
  it("turns readonly on an equal-revision persisted conflict", async () => {
    await setup(); const button = screen.getByRole("button", { name: "Toggle exact context" }); fireEvent.click(button); await waitFor(() => expect(button).toHaveAttribute("aria-pressed", "true")); const current = parseWatchlistV3(localStorage.getItem(WATCHLIST_V3_KEY))!; const other = duelPressEntry({ ...player, id: player.id + 9, name: "Other tab player" }, context); const external = { ...current, entries: [other], updatedAt: new Date(Date.parse(current.updatedAt) + 1).toISOString() }; localStorage.setItem(WATCHLIST_V3_KEY, JSON.stringify(external)); dispatchEvent(new StorageEvent("storage", { key: WATCHLIST_V3_KEY, newValue: JSON.stringify(external) })); await screen.findByText(/conflicted with this tab/i); expect(button).toHaveAttribute("aria-pressed", "true"); fireEvent.click(button); expect(localStorage.getItem(WATCHLIST_V3_KEY)).toBe(JSON.stringify(external));
  });
  it("turns readonly when persisted storage moves to a lower revision", async () => {
    await setup(); const button = screen.getByRole("button", { name: "Toggle exact context" }); fireEvent.click(button); await waitFor(() => expect(button).toHaveAttribute("aria-pressed", "true")); const current = parseWatchlistV3(localStorage.getItem(WATCHLIST_V3_KEY))!; const stale = { ...current, revision: current.revision - 1, entries: [], updatedAt: new Date(Date.parse(current.updatedAt) - 1).toISOString() }; localStorage.setItem(WATCHLIST_V3_KEY, JSON.stringify(stale)); dispatchEvent(new StorageEvent("storage", { key: WATCHLIST_V3_KEY, newValue: JSON.stringify(stale) })); await screen.findByText(/conflicted with this tab/i); expect(button).toHaveAttribute("aria-pressed", "true"); fireEvent.click(button); expect(localStorage.getItem(WATCHLIST_V3_KEY)).toBe(JSON.stringify(stale));
  });
});
