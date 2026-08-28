// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { groupPitchShots, medianObservedXg, pitchMarkerRadius, PitchShotMarker } from "./PitchShotMarker";

describe("PitchShotMarker", () => {
  it("uses the shared xG footprint and only the circle/full-ball pattern tiers", () => {
    const { container, rerender } = render(<svg><PitchShotMarker outcome="goal" radius={4.5}/></svg>);
    expect(container.querySelector("[data-marker-pattern]")).toHaveAttribute("data-marker-pattern", "circle");
    expect(container.querySelector("[data-marker-pentagon]")).not.toBeInTheDocument();
    rerender(<svg><PitchShotMarker outcome="on_target" radius={6}/></svg>);
    expect(container.querySelector("[data-marker-pattern]")).toHaveAttribute("data-marker-pattern", "circle");
    rerender(<svg><PitchShotMarker outcome="goal" radius={11}/></svg>);
    expect(container.querySelector("[data-marker-pattern]")).toHaveAttribute("data-marker-pattern", "full");
    expect(container.querySelectorAll("[data-marker-spoke]")).toHaveLength(5);
    expect(pitchMarkerRadius(.02)).toBeCloseTo(3.99, 2);
    expect(pitchMarkerRadius(.11)).toBeCloseTo(5.32, 2);
    expect(pitchMarkerRadius(.45)).toBeCloseTo(7.70, 2);
    expect(pitchMarkerRadius(.79)).toBeCloseTo(9.22, 2);
    expect(pitchMarkerRadius(null, .11)).toBeCloseTo(pitchMarkerRadius(.11), 8);
    expect(medianObservedXg([{ xg: .02 }, { xg: .11 }, { xg: .79 }])).toBe(.11);
  });

  it("uses a white body plus result outline for frame-reaching shots, and an empty visible pattern for misses", () => {
    const { container, rerender } = render(<svg><PitchShotMarker outcome="off_target" radius={4}/></svg>);
    expect(container.querySelector("[data-pitch-shot-glyph]")).toHaveAttribute("fill", "#0B1220");
    expect(container.querySelector("[data-pitch-shot-glyph]")).toHaveAttribute("fill-opacity", "0.35");
    expect(container.querySelector("[data-marker-halo]")).toHaveAttribute("stroke", "#0A1F10");
    expect(container.querySelector("[data-marker-halo]")).toHaveAttribute("stroke-opacity", ".85");
    expect(container.querySelector("[data-marker-halo]")).toHaveAttribute("stroke-width", "1");
    rerender(<svg><PitchShotMarker outcome="goal" radius={8}/></svg>);
    expect(container.querySelector("[data-pitch-shot-glyph]")).toHaveAttribute("fill", "#F8FAFC");
    expect(container.querySelector("[data-pitch-shot-glyph]")).toHaveAttribute("data-marker-result-color", "#BEF264");
    rerender(<svg><PitchShotMarker outcome="blocked" radius={4}/></svg>);
    expect(container.querySelector("[data-pitch-shot-glyph]")).toHaveAttribute("fill", "#0B1220");
    expect(container.querySelector("[data-marker-block-bar]")).toBeInTheDocument();
  });

  it("groups only exact raw coordinates without jitter, selects the fixed top paint outcome, and retains the stack composition", () => {
    const groups = groupPitchShots([
      { sourceIndex: 0, shot: { x: 89.524, y: 50, outcome: "off_target" as const } },
      { sourceIndex: 1, shot: { x: 89.524, y: 50, outcome: "goal" as const } },
      { sourceIndex: 2, shot: { x: 87.905, y: 44.459, outcome: "blocked" as const } },
      { sourceIndex: 3, shot: { x: 87.905, y: 44.512, outcome: "blocked" as const } },
    ]);
    expect(groups).toHaveLength(3);
    expect(groups.map((group) => group.outcome)).toEqual(["blocked", "blocked", "goal"]);
    expect(groups[2]).toMatchObject({ count: 2, sourceIndexes: [0, 1], outcomeCounts: { goal: 1, off_target: 1 } });
    const { container, rerender } = render(<svg><PitchShotMarker outcome="goal" radius={4.5} count={2} outcomeCounts={groups[2].outcomeCounts}/></svg>);
    expect(container.querySelector("[data-marker-stack-composition]")).toHaveAttribute("data-marker-stack-composition", "득점 1 · 빗나감 1");
    expect(container.querySelector("[data-marker-count-badge]")).toHaveTextContent("×2");
    expect(container.querySelector("[data-marker-mixed-stack-indicator]")).toBeInTheDocument();
    rerender(<svg><PitchShotMarker outcome="goal" radius={4.5} count={2} outcomeCounts={groups[2].outcomeCounts} expandedStack/></svg>);
    expect(container.querySelector("[data-marker-count-badge]")).toHaveTextContent("×2 · 득점 1 · 빗나감 1");
  });
});
