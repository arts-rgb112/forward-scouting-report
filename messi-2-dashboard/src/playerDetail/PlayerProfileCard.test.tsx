// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { PlayerHistoryEntry } from "../api/playerHistoryApi";
import type { DatasetRouteState, Player, PlayerAnalysis, Tier } from "../dashboard/types";
import { samplePlayers } from "../test/fixtures/players";
import { PlayerProfileCard, tierLadderPercent } from "./PlayerProfileCard";

const selected: DatasetRouteState = { season: "2025/2026", mode: "europe", scope: 8, competition: "all" };
const player: Player = { ...samplePlayers[0], name: "Kylian Mbappé", club: { ...samplePlayers[0].club, name: "Real Madrid" }, position: "Striker", age: 27, minutes: 912, rank: 9, score: 72, tier: { code: "diamond", level: 2, label: "Diamond", taxonomyVersion: "crystal-v2" } };
const analysis = { score: { value: 72, rank: 3, topPercent: 1, population: 45, archetype: "Type A" } } as PlayerAnalysis;
const tier = (code: string, level: number): Tier => ({ code, level, label: code, taxonomyVersion: "crystal-v2" });
const history: PlayerHistoryEntry[] = [
  { player: { ...player, score: 72.4, tier: tier("emerald", 2) }, context: { season: "2024/2025", mode: "league", scope: 8, competition: "all" } },
  { player: { ...player, score: 71.7, tier: tier("diamond", 5) }, context: { season: "2023/2024", mode: "europe", scope: 8, competition: "all" } },
  { player: { ...player, score: 69.8, tier: tier("emerald", 4) }, context: { season: "2022/2023", mode: "europe", scope: 8, competition: "all" } },
  { player: { ...player, score: 70.7, tier: tier("platinum", 1) }, context: { season: "2021/2022", mode: "league", scope: 8, competition: "all" } },
];

const readyHistory = { loading: false, entries: history, failed: 0, requestedSeasons: 4 };
afterEach(cleanup);

describe("approved Figma profile card", () => {
  it("renders the exact compact panel geometry, identity, score, tier and selected context", () => {
    const { container } = render(<PlayerProfileCard player={player} analysis={analysis} selected={selected} history={readyHistory}/>);
    const card = container.querySelector('[data-layout="approved-profile-card"]');
    expect(card).toHaveClass("w-full", "gap-4", "p-[22px]");
    expect(card).not.toHaveClass("max-w-[300px]");
    expect(screen.getByRole("heading", { name: "72" })).toHaveStyle({ color: "var(--messi-violet, #ab8ffa)" });
    expect(screen.getByLabelText("Overall M.E.S.S.I. tier: Diamond, level 2")).toHaveTextContent("◆ Diamond Lv.2");
    expect(card).toHaveTextContent("Kylian Mbappé"); expect(card).toHaveTextContent("Real Madrid · Striker"); expect(card).toHaveTextContent("27세 · 912분");
    expect(card).toHaveTextContent("유럽대항전"); expect(card).toHaveTextContent("전체 대회 · 2025/2026");
  });

  it("uses the two existing rank sources without inventing the missing overall population", () => {
    render(<PlayerProfileCard player={player} analysis={analysis} selected={selected} history={readyHistory}/>);
    const card = screen.getByRole("region", { name: "72" });
    expect(card).toHaveTextContent("대회 전체9위/ —명");
    expect(card).toHaveTextContent("동포지션3위/ 45명");
  });

  it("sorts five authoritative contexts by server score and marks the selected context", () => {
    render(<PlayerProfileCard player={player} analysis={analysis} selected={selected} history={readyHistory}/>);
    const list = screen.getByRole("list", { name: "Season tier ladder" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(5);
    expect(rows.map((row) => row.getAttribute("data-season"))).toEqual(["2024/2025", "2025/2026", "2023/2024", "2021/2022", "2022/2023"]);
    expect(rows[1]).toHaveAttribute("data-selected", "true"); expect(rows[1]).toHaveTextContent("현재");
    expect(screen.getByText("조회 범위 69.8–72.4")).toBeInTheDocument();
  });

  it("uses the final 30-step tier ladder for bar length and tier tokens for color", () => {
    const { container } = render(<PlayerProfileCard player={player} analysis={analysis} selected={selected} history={readyHistory}/>);
    const fills = [...container.querySelectorAll<HTMLElement>("[data-tier-fill]")];
    expect(fills.map((fill) => fill.style.width)).toEqual(["80%", "96.66666666666667%", "86.66666666666667%", "66.66666666666666%", "73.33333333333333%"]);
    expect(fills.map((fill) => fill.style.backgroundColor)).toEqual(["var(--messi-accent, #b5f052)", "var(--messi-violet, #ab8ffa)", "var(--messi-violet, #ab8ffa)", "var(--messi-cyan, #45d6ed)", "var(--messi-accent, #b5f052)"]);
    expect(tierLadderPercent(tier("diamond", 1))).toBe(100); expect(tierLadderPercent(tier("bronze", 5))).toBeCloseTo(3.3333, 3);
    expect(screen.getByText(/막대 길이는 티어 순위입니다/)).toBeInTheDocument();
  });

  it("keeps the selected row visible with four skeleton rows while history loads", () => {
    const { container } = render(<PlayerProfileCard player={player} analysis={analysis} selected={selected} history={{ loading: true, entries: [], failed: 0, requestedSeasons: 0 }}/>);
    expect(screen.getByRole("list", { name: "Season tier ladder" }).querySelectorAll("li")).toHaveLength(5);
    expect(container.querySelectorAll(".animate-pulse")).toHaveLength(4);
    expect(screen.getByText("조회 범위 72.0–72.0 · 선택 컨텍스트만")).toBeInTheDocument();
  });

  it("shows partial-history status without changing the five retrieved server rows", () => {
    render(<PlayerProfileCard player={player} analysis={analysis} selected={selected} history={{ ...readyHistory, failed: 2 }}/>);
    expect(screen.getByText("2개 컨텍스트의 시즌 이력을 불러오지 못했습니다.")).toHaveAttribute("aria-live", "polite");
    expect(screen.getAllByRole("listitem")).toHaveLength(5);
  });
});
