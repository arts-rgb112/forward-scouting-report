// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { PitchPenaltyProvider, PitchPenaltyToggle } from "./PitchPenaltyContext";
import { clusterCorridorShotGroups, CORRIDOR_CLUSTER_DISTANCE, SixLaneCorridorPitch } from "./SixLaneCorridorPitch";
import { groupPitchShots } from "./PitchShotMarker";
import { DEFAULT_PITCH_LAYERS } from "./pitchLayers";

const analysis = {
  spatial: {
    available: true,
    heatmapPointCount: 3,
    heatmapPoints: [{ x: 80, y: 40 }, { x: 81, y: 42 }, { x: 82, y: 44 }],
    shotmapSnapshotAvailable: true,
    shotmapPointCount: 4,
    shotmapPoints: [
      { x: 80, y: 40, outcome: "goal", xg: .4, xgot: .6 },
      { x: 80, y: 40, outcome: "on_target", xg: .4, xgot: .6 },
      { x: 89.524, y: 50, outcome: "goal", xg: .79, xgot: .8 },
      { x: 71.049, y: 50, outcome: "off_target", xg: .02, xgot: null },
    ],
    continuousCore: { available: false },
  },
} as never;

describe("SixLaneCorridorPitch", () => {
  it("clusters near visual collisions deterministically while retaining every constituent shot", () => {
    const shots = [
      { x: 80, y: 40, outcome: "goal" as const, xg: .4 },
      { x: 80.5, y: 40.2, outcome: "on_target" as const, xg: .3 },
      { x: 81, y: 40.4, outcome: "off_target" as const, xg: .1 },
      { x: 90, y: 70, outcome: "blocked" as const, xg: .1 },
    ];
    const clusters = clusterCorridorShotGroups(groupPitchShots(shots.map((shot, sourceIndex) => ({ shot, sourceIndex }))), shots);
    expect(CORRIDOR_CLUSTER_DISTANCE).toBe(1.6);
    expect(clusters).toHaveLength(2);
    expect(clusters[1].count).toBe(3);
    expect(clusters[1].sourceIndexes).toEqual([0, 1, 2]);
    expect(clusters[1].shots).toHaveLength(3);
    expect(clusters[1].outcome).toBe("goal");
  });

  it("keeps the field clear, uses simple result markers, and shares the PK state", () => {
    const { container } = render(<PitchPenaltyProvider><PitchPenaltyToggle/><SixLaneCorridorPitch analysis={analysis} layers={DEFAULT_PITCH_LAYERS}/></PitchPenaltyProvider>);
    const corridor = container.querySelector('[data-layout="six-lane-corridor-pitch"]')!;
    const svg = within(corridor).getByRole("img");
    expect(svg.querySelectorAll("text")).toHaveLength(1);
    expect(svg.querySelector("[data-corridor-shot-stack] text")).toHaveTextContent("×2");
    expect(svg.querySelectorAll("[data-lane]")).toHaveLength(6);
    expect(svg.querySelector('[data-layer="positional-grid"]')).not.toBeNull();
    expect(svg.querySelector('[data-layer="pk-axis"]')).toBeNull();
    expect(svg.querySelectorAll('[data-pitch-shot-marker]')).toHaveLength(0);
    expect(within(svg).getAllByRole("button", { name: /슛 상세/ })).toHaveLength(3);
    const stack = within(svg).getByRole("button", { name: /묶음 2발.*득점 1.*유효 1/ });
    expect(stack).toHaveAttribute("data-corridor-shot-count", "2");
    expect(stack.querySelector("[data-corridor-shot-stack]")).toHaveTextContent("×2");
    fireEvent.click(screen.getByRole("button", { name: "페널티 제외" }));
    expect(within(svg).getAllByRole("button", { name: /슛 상세/ })).toHaveLength(2);
    fireEvent.click(within(svg).getByRole("button", { name: /goal 슛 상세, 묶음 2발/ }));
    expect(within(corridor).getByLabelText("슈팅 상세")).toHaveTextContent("xG 0.40");
    expect(within(corridor).getByRole("list", { name: "묶음 슈팅 이벤트" })).toHaveTextContent("#2 · on_target");
    fireEvent.click(within(corridor).getByRole("button", { name: "확대" }));
    expect(within(corridor).getByText("1.2배")).toBeInTheDocument();
    Object.defineProperty(corridor.querySelector('[data-zoom-pan]')!.parentElement!, "getBoundingClientRect", { value: () => ({ width: 300, height: 190 }) });
    fireEvent.pointerDown(svg, { pointerId: 1, clientX: 50, clientY: 50 });
    fireEvent.pointerMove(svg, { pointerId: 1, clientX: 70, clientY: 60 });
    fireEvent.pointerUp(svg, { pointerId: 1 });
    expect(corridor.querySelector('[data-zoom-pan]')).toHaveStyle({ transform: "translate(20px, 10px) scale(1.2)" });
  });
});
