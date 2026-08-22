// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { samplePlayers } from "../../test/fixtures/players";
import { entryFromPlayer } from "../watchlistStorage";
import { legacyV3Entry } from "../watchlistStorageV3";
import type { WatchlistV3Entry } from "../watchlistV3Contracts";
import { WatchlistV3Drawer } from "./WatchlistV3Drawer";

const context = { season: "2025/2026", mode: "league" as const, scope: 8 as const, competition: "all" as const };
const base = entryFromPlayer(samplePlayers[0], { season: context.season, mode: "league", scope: 8, competition: null }).snapshot;
const entries = [1, 2, 3].map((id) => legacyV3Entry(id, { ...base, name: `Player ${id}` }, context));
describe("Watchlist V3 drawer", () => {
  it("preserves selection order and exposes direct View detail and Compare anchors", () => {
    const close = vi.fn();
    function Drawer() { const [saved, setSaved] = useState(entries); const [selected, setSelected] = useState<string[]>([]); return <WatchlistV3Drawer open entries={saved} selectedKeys={selected} feedback="" onClose={close} onRemove={(key) => { setSaved((rows) => rows.filter((row) => row.key !== key)); setSelected((keys) => keys.filter((item) => item !== key)); }} onToggleSelection={(key) => setSelected((keys) => keys.includes(key) ? keys.filter((item) => item !== key) : keys.length >= 2 ? keys : [...keys, key])} />; }
    render(<Drawer />);
    const details = screen.getAllByRole("link", { name: "View detail" });
    expect(details[0]).toHaveAttribute("href", expect.stringContaining(import.meta.env.VITE_LEGACY_DETAIL_HANDOFF_ENABLED === "true" ? "streamlit.app" : "/players/1"));
    fireEvent.click(screen.getAllByRole("button", { name: "Select for compare" })[1]);
    fireEvent.click(screen.getAllByRole("button", { name: "Select for compare" })[0]);
    expect(screen.getByText("Position 1")).toBeInTheDocument();
    expect(screen.getByText("Position 2")).toBeInTheDocument();
    const compare = screen.getByRole("link", { name: "Compare selected" });
    expect(compare).toHaveAttribute("href", expect.stringMatching(/^\/compare\?leftPlayerId=2&leftTaxonomy=legacy-v1/));
    fireEvent.click(screen.getAllByRole("button", { name: "Remove" })[0]);
    expect(screen.queryByText("Position 2")).not.toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" }); expect(close).toHaveBeenCalled();
  });

  it("keeps mixed legacy and Duel compare order in the native canonical URL", () => {
    const duel = { version: 3, taxonomy: "duel-press-v1", namespace: "fotmob", key: "duel-right", playerId: 303, context, snapshot: { id: 303, name: "Duel Right", club: { name: "Duel Club" } }, savedAt: "2026-08-11T00:00:00.000Z" } as unknown as WatchlistV3Entry;
    render(<WatchlistV3Drawer open entries={[entries[0], duel]} selectedKeys={[duel.key, entries[0].key]} feedback="" onClose={vi.fn()} onRemove={vi.fn()} onToggleSelection={vi.fn()} />);
    const href = screen.getByRole("link", { name: "Compare selected" }).getAttribute("href")!;
    const params = new URL(href, "https://native.test").searchParams;
    expect(params.get("leftPlayerId")).toBe("303"); expect(params.get("leftTaxonomy")).toBe("duel-press-v1"); expect(params.get("rightPlayerId")).toBe(String(entries[0].playerId)); expect(href).not.toMatch(/streamlit/i);
  });
});
