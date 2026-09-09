// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { readFileSync } from "node:fs";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { duelPressV2DetailMetricsSchema } from "../api/duelPressV2Contracts";
import type { PlayerAnalysis } from "../dashboard/types";
import { samplePlayers } from "../test/fixtures/players";
import { ArenaProfileHud, PlayerOverview } from "./PlayerOverview";

/**
 * No captured unified-v3 response is available in this checkout.  This helper
 * explicitly converts the checked-in legacy transport fixture into a schema
 * valid unified-v3 *synthetic UI fixture*; it is never product/API evidence.
 */
function syntheticUnifiedDetail(mutate?: (detail: Record<string, unknown>) => void) {
  const detail = JSON.parse(readFileSync("../docs/fixtures/duel_press_v2/complete_league.json", "utf8")).responses.detail;
  detail.ratingVersion = "messi-score-unified-v3";
  detail.ratingSnapshotId = "messi-score-unified-v3:0123456789abcdef";
  detail.categories = detail.categories.map((category: { percentileScore: number }) => ({
    ...category,
    formulaId: "pressing-sector-score-v3",
    formulaVersion: "messi-score-unified-v3",
    scoreBreakdown: {
      compositeScore: category.percentileScore,
      volumeScore: category.percentileScore,
      ratioScore: category.percentileScore,
      volumeSample: { attempts: 12, minutes: 1800 },
      ratioSample: { attempts: 12, minutes: 1800 },
      sampleState: "observed",
    },
  }));
  mutate?.(detail);
  return duelPressV2DetailMetricsSchema.parse(detail);
}

describe("PlayerOverview", () => {
  const selected = { season: "2025/2026", mode: "league" as const, scope: 7 as const, competition: "all" as const };
  const history = { loading: false, entries: [], failed: 0, requestedSeasons: 0 };

  afterEach(() => { cleanup(); window.history.replaceState({}, "", "/"); });

  it.each(["duel-press-v1", "duel-press-v2", "invalid", ""])("preserves only recognized taxonomy across season navigation: %s", (taxonomy) => {
    window.history.replaceState({}, "", `/players/1?season=2025%2F2026&mode=league&scope=7&utm_source=continuity${taxonomy ? `&taxonomy=${taxonomy}` : ""}`);
    const { container } = render(<PlayerOverview player={samplePlayers[0]} selected={selected} history={{ ...history, entries: [{ player: samplePlayers[0], context: { season: "2024/2025", mode: "league", scope: 8, competition: "all" } }] }} categoryState="unavailable" />);
    const link = container.querySelector('a[aria-label*="2024/2025"]')!;
    const query = new URL(link.getAttribute("href")!, window.location.origin).searchParams;
    expect(query.get("taxonomy")).toBe(taxonomy.startsWith("duel-press-") ? taxonomy : null);
    expect(query.get("season")).toBe("2024/2025");
    expect(query.get("scope")).toBe("8");
    expect(query.get("utm_source")).toBe("continuity");
  });

  it("uses only authoritative unified category scores in one radar-and-vector card without a duplicate category rail", () => {
    const data = syntheticUnifiedDetail();
    const { container } = render(<PlayerOverview player={samplePlayers[0]} selected={selected} history={history} data={data} />);
    const overview = container.querySelector('[data-layout="player-overview"]')!;
    expect(within(overview as HTMLElement).getByRole("img", { name: "서버 제공 M.E.S.S.I. 6개 카테고리 레이더" })).toBeInTheDocument();
    expect(overview.querySelectorAll("polygon")).toHaveLength(5);
    expect(within(overview as HTMLElement).getAllByText("박스 밖 슈팅")).toHaveLength(1);
    expect(within(overview as HTMLElement).getAllByText("전방 압박")).toHaveLength(1);
    expect(overview.querySelector('[data-layout="overview-category-vector"]')).toHaveAttribute("data-layout", "overview-category-vector");
    expect(overview.querySelectorAll('[data-layout="overview-category-vector"] li')).toHaveLength(6);
    expect(within(overview as HTMLElement).queryByRole("heading", { name: "카테고리 스탯" })).not.toBeInTheDocument();
  });

  it("keeps unavailable data distinct from zero and exposes a clear loading state", () => {
    const { rerender } = render(<PlayerOverview player={samplePlayers[0]} selected={selected} history={history} categoryState="loading" />);
    expect(screen.getByText("정본 카테고리 점수를 불러오는 중입니다.")).toBeInTheDocument();
    rerender(<PlayerOverview player={samplePlayers[0]} selected={selected} history={history} categoryState="unavailable" />);
    expect(screen.getByText("선택된 데이터 버전에서는 카테고리 정본 점수를 제공하지 않습니다.")).toBeInTheDocument();
  });

  it("uses readable compact minutes on a four-cell mobile summary while retaining the exact server value for assistive technology", () => {
    const analysis = { score: { value: 84, rank: 3, topPercent: null, population: 50, archetype: "Type A" as const }, rawMetrics: { minutesPlayed: 1900 } } as PlayerAnalysis;
    render(<PlayerOverview player={samplePlayers[0]} analysis={analysis} selected={selected} history={history} categoryState="unavailable" />);
    const compactMinutes = screen.getByText("1.9k분");
    expect(compactMinutes).toHaveAttribute("aria-label", "1,900분");
    expect(compactMinutes).toHaveAttribute("title", "1,900분");
  });

  it("preserves only approved actual profile metrics in the arena HUD, with compact mobile disclosure", () => {
    const analysis = { score: { value: 84, rank: 3, topPercent: null, population: 50, archetype: "Type A" as const }, rawMetrics: { goals: 12, xg: 10.4, xgot: 11.1, minutesPlayed: 1900 } } as PlayerAnalysis;
    const { container } = render(<ArenaProfileHud player={samplePlayers[0]} analysis={analysis} selected={selected} />);
    const hud = container.querySelector('[data-layout="arena-profile-hud"]')!;
    expect(hud.querySelectorAll('[data-layout="arena-profile-stats"]')).toHaveLength(2);
    expect(within(hud).getAllByText("1.9k분")[0]).toHaveAttribute("aria-label", "1,900분");
    expect(within(hud).getByText("기록 · 현재 프로필")).toBeInTheDocument();
    expect(hud).toHaveTextContent(`현재 프로필 ${samplePlayers[0].age}세`);
    expect(hud).toHaveTextContent("동포지션 3위/50명");
  });

  it("keeps the selected season visible while history loads and puts the profile first in the mobile DOM", () => {
    const { container } = render(<PlayerOverview player={samplePlayers[0]} selected={selected} history={{ ...history, loading: true }} categoryState="loading" />);
    const overview = container.querySelector('[data-layout="player-overview"]')!;
    expect(overview.firstElementChild).toHaveAttribute("aria-labelledby", "overview-profile-heading");
    expect(overview.children[1]).toHaveAttribute("data-layout", "overview-rail");
    const selectedSeason = overview.querySelector('[data-selected="true"]')!;
    expect(selectedSeason).toHaveAttribute("data-season", "2025/2026");
    expect(within(selectedSeason as HTMLElement).getByText("2025/2026")).toHaveAttribute("data-season-label", "true");
    expect(within(selectedSeason as HTMLElement).getByText("2025/2026")).toHaveClass("whitespace-nowrap");
    expect(within(selectedSeason as HTMLElement).getByText("현재")).toHaveClass("whitespace-nowrap");
    expect(overview.querySelectorAll('li[aria-hidden="true"]')).toHaveLength(5);
  });

  it("keeps attribution query keys when historical context navigation changes the dataset", () => {
    window.history.pushState({}, "", "/players/1?season=2025%2F2026&mode=league&scope=7&utm_source=overview-test");
    const priorSeason = { ...samplePlayers[0], score: 81.4 };
    const { container } = render(<PlayerOverview player={samplePlayers[0]} selected={selected} history={{ ...history, entries: [{ player: priorSeason, context: { season: "2024/2025", mode: "europe", scope: 8, competition: "ucl" } }] }} categoryState="unavailable" />);
    const historicalLink = container.querySelector('a[aria-label*="2024/2025"]');
    expect(historicalLink).toHaveAttribute("href", "/players/1?season=2024%2F2025&mode=europe&competition=ucl&utm_source=overview-test");
  });

  it("does not relabel a legacy stat-pairs diagnostic envelope as a M.E.S.S.I. radar", () => {
    const legacy = duelPressV2DetailMetricsSchema.parse(JSON.parse(readFileSync("../docs/fixtures/duel_press_v2/complete_league.json", "utf8")).responses.detail);
    render(<PlayerOverview player={samplePlayers[0]} selected={selected} history={history} data={legacy} />);
    expect(screen.getByRole("img", { name: "M.E.S.S.I. 카테고리 레이더 데이터 없음" })).toBeInTheDocument();
    expect(screen.getByText("선택된 데이터 버전에서는 카테고리 정본 점수를 제공하지 않습니다.")).toBeInTheDocument();
  });

  it("renders server-declared synthetic fixture zero, unavailable, and imputed states without coercing them", () => {
    const data = syntheticUnifiedDetail((detail) => {
      const categories = detail.categories as Array<Record<string, unknown>>;
      categories[0].percentileScore = 0;
      categories[0].scoreBreakdown = { compositeScore: 0, volumeScore: 0, ratioScore: 0, volumeSample: { attempts: 0, minutes: 1800 }, ratioSample: { attempts: 0, minutes: 1800 }, sampleState: "observed" };
      categories[1].scoreState = "unavailable";
      categories[2].scoreState = "imputed";
      categories[2].imputedComponents = ["synthetic-ui-fixture-only"];
    });
    const { container } = render(<PlayerOverview player={samplePlayers[0]} selected={selected} history={history} data={data} />);
    const categoryList = container.querySelector('[data-layout="overview-category-vector"]')!;
    expect(within(categoryList).getByText("0", { exact: true })).toBeInTheDocument();
    expect(within(categoryList).getByText("—", { exact: true })).toBeInTheDocument();
    expect(screen.getByText("일부 카테고리에 서버 대체 구성요소가 포함되어 있습니다.")).toBeInTheDocument();
    expect(container.querySelectorAll("span.opacity-60")).toHaveLength(1);
    expect(screen.getByRole("img", { name: "M.E.S.S.I. 카테고리 레이더 데이터 없음" })).toBeInTheDocument();
  });
});
