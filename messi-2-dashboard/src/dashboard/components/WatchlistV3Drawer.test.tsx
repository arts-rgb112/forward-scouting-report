// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { samplePlayers } from "../../test/fixtures/players";
import { entryFromPlayer } from "../watchlistStorage";
import { legacyV3Entry } from "../watchlistStorageV3";
import { WatchlistV3Drawer } from "./WatchlistV3Drawer";

const context = { season: "2025/2026", mode: "league" as const, scope: 8 as const, competition: "all" as const }; const base = entryFromPlayer(samplePlayers[0], { season: context.season, mode: "league", scope: 8, competition: null }).snapshot; const entries = [1, 2, 3].map((id) => legacyV3Entry(id, { ...base, name: `Player ${id}` }, context));
describe("Watchlist V3 drawer", () => {
  it("keeps selection order/max two, reconciles remove, has no dead compare link, and closes on Escape", () => {
    const close = vi.fn(); function Drawer() { const [saved, setSaved] = useState(entries); const [selected, setSelected] = useState<string[]>([]); const [feedback, setFeedback] = useState(""); return <WatchlistV3Drawer open entries={saved} selectedKeys={selected} feedback={feedback} onClose={close} onRemove={(key) => { setSaved((rows) => rows.filter((row) => row.key !== key)); setSelected((keys) => keys.filter((item) => item !== key)); }} onToggleSelection={(key) => setSelected((keys) => { if (keys.includes(key)) return keys.filter((item) => item !== key); if (keys.length >= 2) { setFeedback("You can select up to two saved contexts for comparison."); return keys; } return [...keys, key]; })} />; }
    render(<Drawer />); const selects = screen.getAllByRole("button", { name: "Select for compare" }); fireEvent.click(selects[0]); fireEvent.click(selects[1]); expect(screen.getByText("Position 1")).toBeInTheDocument(); expect(screen.getByText("Position 2")).toBeInTheDocument(); fireEvent.click(screen.getAllByRole("button", { name: "Select for compare" })[0]); expect(screen.getByRole("status")).toHaveTextContent(/up to two/); expect(screen.getByText(/2 selected · Compare view/)).toHaveAttribute("aria-disabled", "true"); expect(screen.queryByRole("link")).not.toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: "Remove" })[0]); expect(screen.getByText("Position 1")).toBeInTheDocument(); expect(screen.queryByText("Position 2")).not.toBeInTheDocument(); fireEvent.keyDown(window, { key: "Escape" }); expect(close).toHaveBeenCalled();
  });
});
