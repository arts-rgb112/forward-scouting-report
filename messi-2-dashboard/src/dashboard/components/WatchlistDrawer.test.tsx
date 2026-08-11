// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { WatchlistDrawer } from "./WatchlistDrawer";
import type { WatchlistEntry } from "../watchlistStorage";

const entries: WatchlistEntry[] = [
  { version: 2, key: "left", namespace: "fotmob", playerId: 101, snapshot: { name: "A & B", position: "forward", clubName: "FC / One" }, context: { season: "2025/2026", mode: "league", scope: 5, competition: null }, savedAt: "2026-08-11T00:00:00.000Z" },
  { version: 2, key: "right", namespace: "fotmob", playerId: 202, snapshot: { name: "C D", position: "forward", clubName: "Two" }, context: { season: "2024/2025", mode: "europe", scope: null, competition: "uel" }, savedAt: "2026-08-11T00:00:00.000Z" },
];

afterEach(() => { cleanup(); vi.unstubAllEnvs(); });

describe("WatchlistDrawer legacy Compare handoff", () => {
  const props = { open: true, entries, onClose: vi.fn(), onRemove: vi.fn(), onToggleSelection: vi.fn(), feedback: "" };

  it("keeps Compare unavailable until exactly two saved contexts are selected", () => {
    render(<WatchlistDrawer {...props} selectedKeys={["left"]} />);
    expect(screen.getByText("Open comparison page")).not.toHaveAttribute("href");
    expect(screen.getByText(/1\/2 selected/)).toBeInTheDocument();
  });

  it("uses the selected order and passes both contexts to the enabled Streamlit handoff", () => {
    vi.stubEnv("VITE_LEGACY_HANDOFF_ENABLED", "true");
    render(<WatchlistDrawer {...props} selectedKeys={["right", "left"]} />);
    const href = screen.getByRole("link", { name: "Open comparison page" }).getAttribute("href")!;
    const params = new URL(href).searchParams;
    expect(params.get("left_player")).toBe("202");
    expect(params.get("left_competition")).toBe("uel");
    expect(params.has("left_scope")).toBe(false);
    expect(params.get("right_player")).toBe("101");
    expect(params.get("right_scope")).toBe("5");
    expect(params.has("right_competition")).toBe(false);
  });
});
