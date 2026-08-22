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

describe("WatchlistDrawer native Compare links", () => {
  const props = { open: true, entries, onClose: vi.fn(), onRemove: vi.fn(), onToggleSelection: vi.fn(), feedback: "" };

  it("keeps Compare unavailable until exactly two saved contexts are selected", () => {
    render(<WatchlistDrawer {...props} selectedKeys={["left"]} />);
    expect(screen.getByText("Open comparison page")).not.toHaveAttribute("href");
    expect(screen.getByText(/1\/2 selected/)).toBeInTheDocument();
  });

  it("uses selected order in the native canonical compare URL", () => {
    render(<WatchlistDrawer {...props} selectedKeys={["right", "left"]} />);
    const href = screen.getByRole("link", { name: "Open comparison page" }).getAttribute("href")!;
    const params = new URL(href, "https://native.test").searchParams;
    expect(params.get("leftPlayerId")).toBe("202");
    expect(params.get("leftCompetition")).toBe("uel");
    expect(params.get("leftScope")).toBe("null");
    expect(params.get("rightPlayerId")).toBe("101");
    expect(params.get("rightScope")).toBe("5");
    expect(href).not.toMatch(/streamlit/i);
  });

  it("keeps malformed saved contexts internal and produces a native recovery URL", () => {
    const malformed: WatchlistEntry[] = [
      { ...entries[0], key: "bad-league", context: { ...entries[0].context, scope: null } },
      { ...entries[1], key: "bad-europe", context: { ...entries[1].context, competition: null } },
    ];
    render(<WatchlistDrawer {...props} entries={malformed} selectedKeys={["bad-league", "bad-europe"]} />);
    expect(screen.getAllByRole("link", { name: "View detail" }).map((link) => link.getAttribute("href"))).toEqual([expect.stringContaining("/players/101"), expect.stringContaining("/players/202")]);
    expect(screen.getByRole("link", { name: "Open comparison page" })).toHaveAttribute("href", expect.stringMatching(/^\/compare\?/));
  });
});
