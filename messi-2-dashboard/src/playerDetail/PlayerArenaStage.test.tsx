// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  box: undefined as unknown,
  activity: { kind: "loading", key: "activity" } as unknown,
  native: { kind: "loading", key: "native" } as unknown,
}));

vi.mock("./useBoxSubregionStats", () => ({ useBoxSubregionStats: () => mocks.box }));
vi.mock("./useFullActivityDisplay", () => ({ useFullActivityDisplay: () => mocks.activity }));
vi.mock("./useNativePitchEventsV2", () => ({ useNativePitchEventsV2: () => mocks.native }));
vi.mock("./SpatialPitch", () => ({
  SpatialPitch: (props: { presentation?: string; boxSubregion?: { kind?: string; key?: string }; onArenaSelectionChange?: (value: unknown) => void }) => <div data-testid="arena-pitch" data-presentation={props.presentation} data-box-kind={props.boxSubregion?.kind} data-box-key={props.boxSubregion?.key}><canvas/><button type="button" onClick={() => props.onArenaSelectionChange?.({ kind: "tactical20", key: "wide-1" })}>구역 선택</button></div>,
}));

import { boxSubregionResourceKey } from "../api/boxSubregionApi";
import { samplePlayers } from "../test/fixtures/players";
import { PlayerArenaStage } from "./PlayerArenaStage";

const config = { baseUrl: "https://api.example.test", season: "2025/2026", scope: 7 as const, limit: 1000 };
const first = { season: "2025/2026", mode: "league" as const, scope: 7 as const, competition: "all" as const };
const second = { ...first, season: "2024/2025" };

describe("PlayerArenaStage", () => {
  afterEach(cleanup);

  beforeEach(() => { mocks.activity = { kind: "loading", key: "activity" }; mocks.native = { kind: "loading", key: "native" }; mocks.box = { kind: "loading", key: boxSubregionResourceKey(samplePlayers[0].id, first) }; });

  it("uses one presentation arena canvas and exchanges the category HUD for a renderer selection", () => {
    const { container } = render(<PlayerArenaStage player={samplePlayers[0]} config={config} dataset={first} history={{ loading: false, entries: [], failed: 0, requestedSeasons: 0 }} categoryState="unavailable"/>);
    expect(container.querySelectorAll("canvas")).toHaveLength(1);
    expect(screen.getByTestId("arena-pitch")).toHaveAttribute("data-presentation", "arena");
    expect(container.querySelector('[data-layout="arena-scene"]')).toHaveClass("min-h-[20rem]", "sm:min-h-[24rem]");
    expect(container.querySelector('[data-layout="arena-category-hud"]')).toHaveClass("bg-[#181a1b]/95", "backdrop-blur-md");
    expect(container.querySelector('[data-layout="arena-season-rail"]')).toHaveClass("bg-[#181a1b]/95", "max-h-[min(15rem,calc(100%_-_6rem))]");
    const scene = container.querySelector('[data-layout="arena-scene"]')!;
    const controlsFooter = container.querySelector('[data-layout="arena-controls-footer"]')!;
    expect(controlsFooter).toContainElement(container.querySelector('[data-arena-controls-help]'));
    expect(scene.compareDocumentPosition(controlsFooter) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const seasonHeadingIds = [...container.querySelectorAll('h2[id^="overview-season-heading-"]')].map((heading) => heading.id);
    expect(seasonHeadingIds).toHaveLength(2);
    expect(new Set(seasonHeadingIds).size).toBe(seasonHeadingIds.length);
    const radarHeadingIds = [...container.querySelectorAll('h2[id^="overview-radar-heading-"]')].map((heading) => heading.id);
    expect(radarHeadingIds).toHaveLength(2);
    expect(new Set(radarHeadingIds).size).toBe(radarHeadingIds.length);
    expect(container.querySelectorAll('[data-layout="overview-radar-card"]')).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "구역 선택" }));
    expect(container.querySelectorAll('[data-layout="overview-radar-card"]')).toHaveLength(0);
    expect(container.querySelector('[data-layout="arena-category-hud"]')).not.toBeInTheDocument();
  });

  it("does not pass a prior box-subregion response into a different selected context", () => {
    const oldKey = boxSubregionResourceKey(samplePlayers[0].id, first);
    mocks.box = { kind: "ready", key: oldKey, data: {} };
    const view = render(<PlayerArenaStage player={samplePlayers[0]} config={config} dataset={first} history={{ loading: false, entries: [], failed: 0, requestedSeasons: 0 }} />);
    expect(screen.getByTestId("arena-pitch")).toHaveAttribute("data-box-kind", "ready");
    view.rerender(<PlayerArenaStage player={samplePlayers[0]} config={config} dataset={second} history={{ loading: false, entries: [], failed: 0, requestedSeasons: 0 }} />);
    expect(screen.getByTestId("arena-pitch")).toHaveAttribute("data-box-kind", "loading");
    expect(screen.getByTestId("arena-pitch")).toHaveAttribute("data-box-key", boxSubregionResourceKey(samplePlayers[0].id, second));
  });
});
