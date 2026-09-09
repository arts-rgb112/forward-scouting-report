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
  afterEach(() => { cleanup(); window.history.replaceState({}, "", "/"); });

  it.each(["duel-press-v1", "duel-press-v2", "invalid", ""])("keeps valid taxonomy and attribution on comparison entry: %s", (taxonomy) => {
    window.history.replaceState({}, "", `/?utm_source=arena${taxonomy ? `&taxonomy=${taxonomy}` : ""}`);
    render(<PlayerArenaStage player={samplePlayers[0]} config={config} dataset={first} history={{ loading: false, entries: [], failed: 0, requestedSeasons: 0 }} />);
    const url = new URL(screen.getByRole("link", { name: "선수 비교" }).getAttribute("href")!, window.location.origin);
    expect(url.pathname).toBe("/compare");
    expect(url.searchParams.get("taxonomy")).toBe(taxonomy.startsWith("duel-press-") ? taxonomy : null);
    expect(url.searchParams.get("utm_source")).toBe("arena");
    expect(url.searchParams.get("season")).toBe(first.season);
    expect(url.searchParams.get("scope")).toBe("7");
  });

  beforeEach(() => { mocks.activity = { kind: "loading", key: "activity" }; mocks.native = { kind: "loading", key: "native" }; mocks.box = { kind: "loading", key: boxSubregionResourceKey(samplePlayers[0].id, first) }; });

  it("uses one presentation arena canvas and exchanges the category HUD for a renderer selection", () => {
    const { container } = render(<PlayerArenaStage player={samplePlayers[0]} config={config} dataset={first} history={{ loading: false, entries: [], failed: 0, requestedSeasons: 0 }} categoryState="unavailable"/>);
    fireEvent.click(screen.getByRole("button", { name: "상세 분석" }));
    expect(screen.getByText("활동 등고선: 선수 내 상대 밀도 · 층 높이는 실제 위치 높이가 아닙니다.")).toBeVisible();
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

  it("opens on insights and keeps the same canvas and URL when entering and returning from detail", () => {
    const { container } = render(<PlayerArenaStage player={samplePlayers[0]} config={config} dataset={first} history={{ loading: false, entries: [], failed: 0, requestedSeasons: 0 }} categoryState="unavailable"/>);
    const canvas = container.querySelector("canvas");
    const before = window.location.href;
    expect(container.querySelector('[data-layout="arena-opening"]')).toBeInTheDocument();
    expect(canvas?.closest('[inert]')).not.toBeNull();
    expect(screen.getByRole("link", { name: "선수 비교" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "상세 분석" }));
    expect(container.querySelector('[data-layout="arena-opening"]')).not.toBeInTheDocument();
    expect(container.querySelector("canvas")).toBe(canvas);
    expect(canvas?.closest('[inert]')).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "요약으로 돌아가기" }));
    expect(container.querySelector('[data-layout="arena-opening"]')).toBeInTheDocument();
    expect(container.querySelector("canvas")).toBe(canvas);
    expect(window.location.href).toBe(before);
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
