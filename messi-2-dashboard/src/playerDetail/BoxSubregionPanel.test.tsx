// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { boxSubregionEnvelopeSchema } from "../api/boxSubregionContracts";
import { BoxSubregionPanel } from "./BoxSubregionPanel";
import type { BoxSubregionStatsState } from "./useBoxSubregionStats";

// Real reviewed Kane fixture, parsed through the actual strict decoder — the
// panel is exercised against exactly what a live response would look like,
// never a hand-typed shape that could drift from the contract.
// import.meta.url does not resolve to a real filesystem path under jsdom.
const fixture = boxSubregionEnvelopeSchema.parse(JSON.parse(readFileSync(
  resolve(import.meta.dirname, "../../../../messi-specs/fixtures/box-subregion-kane-2025-2026-league8.json"),
  "utf-8",
)));

describe("BoxSubregionPanel", () => {
  it("shows every server field per region — xg, activity share before shooting share, quality with joint eligibility", () => {
    const state: BoxSubregionStatsState = { kind: "ready", key: "k", data: fixture };
    const { container } = render(<BoxSubregionPanel state={state} />);
    const l4 = container.querySelector('[data-box-subregion-region="L4"]')!;
    expect(l4.querySelector("dt")).toHaveTextContent("박스 좌"); // real Korean label from the fixture, not a hardcoded guess
    expect(l4.textContent).toContain("9슛 · 2골 · xG 0.33");
    // activity share must be read BEFORE shooting share, matching the earlier
    // activity-share-before-shot-share instruction — assert order, not just presence.
    const shareLine = [...l4.querySelectorAll("dd")].map((dd) => dd.textContent).find((text) => text?.includes("활동"))!;
    expect(shareLine.indexOf("활동")).toBeLessThan(shareLine.indexOf("슈팅"));
    expect(shareLine).toContain("2.7%");
    expect(shareLine).toContain("8.3%");
    expect(l4.querySelector("[data-box-subregion-quality]")).toHaveTextContent("xGOT−xG +1.64");
    expect(l4.querySelector("[data-box-subregion-quality]")).toHaveTextContent("적격 9/9");
  });

  it("uses the owner-requested four-box presentation names without changing the server IDs", () => {
    const state: BoxSubregionStatsState = { kind: "ready", key: "k", data: fixture };
    const { container } = render(<BoxSubregionPanel state={state} />);
    expect(container.querySelector('[data-box-subregion-region="L4"]')).toHaveTextContent("박스 좌");
    expect(container.querySelector('[data-box-subregion-region="L3L"]')).toHaveTextContent("박스 좌중");
    expect(container.querySelector('[data-box-subregion-region="L3R"]')).toHaveTextContent("박스 우중");
    expect(container.querySelector('[data-box-subregion-region="L2"]')).toHaveTextContent("박스 우");
  });

  it("marks a partial-quality region (L3L: 30/31 eligible) without claiming complete", () => {
    const state: BoxSubregionStatsState = { kind: "ready", key: "k", data: fixture };
    const { container } = render(<BoxSubregionPanel state={state} />);
    const l3l = container.querySelector('[data-box-subregion-region="L3L"]')!;
    expect(l3l.querySelector("[data-box-subregion-quality]")).toHaveAttribute("data-box-subregion-quality", "partial");
    expect(l3l.textContent).toContain("일부 표본");
    expect(l3l.querySelector("[data-box-subregion-quality]")).toHaveTextContent("적격 30/31");
  });

  it("shows an observed-zero region (L2 has 0 goals) as an honest zero, not a dash", () => {
    const state: BoxSubregionStatsState = { kind: "ready", key: "k", data: fixture };
    const { container } = render(<BoxSubregionPanel state={state} />);
    const l2 = container.querySelector('[data-box-subregion-region="L2"]')!;
    expect(l2.textContent).toContain("11슛 · 0골");
  });

  it("states both server denominators — full activity count and non-penalty shots — without recomputing them", () => {
    const state: BoxSubregionStatsState = { kind: "ready", key: "k", data: fixture };
    const { container } = render(<BoxSubregionPanel state={state} />);
    const denominators = container.querySelector("[data-box-subregion-denominators]")!;
    expect(denominators).toHaveTextContent("전체 활동 1401개");
    expect(denominators).toHaveTextContent("비페널티 슛 108개");
  });

  it("keeps the passive 4-region table collapsed by default — progressive disclosure, not an always-open number wall", () => {
    const state: BoxSubregionStatsState = { kind: "ready", key: "k", data: fixture };
    const { container } = render(<BoxSubregionPanel state={state} />);
    const details = container.querySelector("details")!;
    expect(details).toBeInTheDocument();
    expect(details.open).toBe(false);
    // The stats are still present in the DOM (not deleted), just behind the disclosure.
    expect(details).toHaveTextContent("9슛 · 2골 · xG 0.33");
  });

  it("surfaces a specific region's real readout up front (outside the collapsed table) when the pitch reports it as the active region", () => {
    const state: BoxSubregionStatsState = { kind: "ready", key: "k", data: fixture };
    const { container, rerender } = render(<BoxSubregionPanel state={state} />);
    expect(container.querySelector("[data-box-subregion-active-region]")).not.toBeInTheDocument();

    rerender(<BoxSubregionPanel state={state} activeRegionId="L4" />);
    const active = container.querySelector('[data-box-subregion-active-region="L4"]')!;
    expect(active).toBeInTheDocument();
    expect(active).toHaveTextContent("박스 좌");
    expect(active).toHaveTextContent("9슛 · 2골 · xG 0.33");
  });

  it("renders loading and error as honest unavailable, never a fabricated zero", () => {
    const loading = render(<BoxSubregionPanel state={{ kind: "loading", key: "k" }} />);
    expect(loading.getByRole("status")).toHaveTextContent("불러오는 중");
    loading.unmount();
    const error = render(<BoxSubregionPanel state={{ kind: "error", key: "k" }} />);
    expect(error.container.querySelector("[data-box-subregion-unavailable]")).toHaveTextContent("사용할 수 없습니다");
  });

  it("flags a fully-unavailable ready envelope (route live but no mapped source) distinctly from observed", () => {
    const unavailableQuality = { xg: null, xgot: null, delta: null, eligible: null, state: "unavailable" as const };
    const unavailableShots = { shots: null, goals: null, xg: null, xgEligible: null, quality: unavailableQuality };
    const unavailableCoverage = { state: "unavailable" as const, expectedKeys: [], observedKeys: [], missingKeys: [] };
    const envelope = {
      ...fixture,
      completeness: "unavailable" as const,
      coverage: { shots: unavailableCoverage, activity: unavailableCoverage },
      denominators: { selectedNonPenaltyShots: null, fullActivityCount: null },
      regions: fixture.regions.map((r) => ({ ...r, ...unavailableShots, activity: null, shootingSharePct: null, activitySharePct: null })),
      accounting: { source: unavailableShots, inRegions: unavailableShots, penalties: unavailableShots, outside: unavailableShots, reconciles: null },
      activityAccounting: { source: null, inRegions: null, outside: null, reconciles: null },
    };
    const state: BoxSubregionStatsState = { kind: "ready", key: "k", data: envelope };
    const { container } = render(<BoxSubregionPanel state={state} />);
    expect(container.textContent).toContain("박스 구역 원천 데이터 미연결");
    expect(container.querySelector('[data-box-subregion-region="L4"]')!.textContent).toContain("—");
  });
});
