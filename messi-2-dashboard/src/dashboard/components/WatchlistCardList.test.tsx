// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { samplePlayers } from "../../test/fixtures/players";
import { entryFromPlayer } from "../watchlistStorage";
import type { WatchlistRow } from "../watchlistViewModel";
import { WatchlistCardList } from "./WatchlistCardList";

describe("WatchlistCardList legacy-partial action", () => {
  it("uses the same compact checked Watch control instead of a visible Remove label", () => {
    const entry = entryFromPlayer(samplePlayers[0], { season: "2025/2026", mode: "league", scope: 8, competition: null });
    const row: WatchlistRow = {
      key: entry.key,
      entry: { ...entry, snapshot: { profile: "legacy-partial", name: entry.snapshot.name, position: entry.snapshot.position, clubName: entry.snapshot.clubName } },
      profile: { name: entry.snapshot.name, position: entry.snapshot.position, clubName: entry.snapshot.clubName },
      source: "legacy-partial",
    };
    const onRemove = vi.fn();
    render(<WatchlistCardList rows={[row]} onRemove={onRemove} onRetry={vi.fn()} />);

    const remove = screen.getByRole("button", { name: `Remove ${row.profile.name} saved context` });
    expect(remove).toHaveTextContent("✓");
    expect(remove).toHaveAttribute("aria-pressed", "true");
    expect(remove).toHaveAttribute("title", `Remove ${row.profile.name} saved context`);
    expect(remove).toHaveClass("min-h-11", "min-w-11");
    fireEvent.click(remove);
    expect(onRemove).toHaveBeenCalledWith(row.key);
  });
});
